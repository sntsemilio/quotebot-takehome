// Without memories the product behaves exactly as in the measured runs. The five recorded
// conversations (cases 1, 5, 6, 7 and 9, fixtures/records) are replayed through Conversation.send with a fake model that answers as the
// recorded model did: what the model receives (system, tools, messages), the request the code starts, the tool
// results, the replies and the recorded turns, plus the view and digest of each recorded quote, must equal the golden
// file. No network, no model, no browser.
// To rewrite the golden file (only with the code it must match): WRITE_GOLDEN=conversation npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { Conversation, resultDigest } from "./session.js";
import { buildQuoteView } from "../orchestrator/view.js";
import type { Orchestrator } from "../orchestrator/types.js";
import type { RunEvent } from "../record/events.js";

const GOLDEN = path.join("src", "conversation", "fixtures", "conversation-no-regression.json");
const read = (f: string): RunEvent[] => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const records = ["one-turn", "two-turn"].flatMap((l) =>
  fs.readdirSync(path.join("fixtures", "records", l)).filter((f) => f.startsWith("conversation-")).sort().map((f) => path.join("fixtures", "records", l, f)));

type Turn = Extract<RunEvent, { type: "conversation.turn" }>;

// What the recorded model answered after each user message: tool calls (with the input it gave) and its text.
function script(turns: Turn[]): { user: string; responses: Partial<Anthropic.Message>[] }[] {
  const out: { user: string; responses: Partial<Anthropic.Message>[] }[] = [];
  for (const t of turns) {
    if (t.role === "user") out.push({ user: t.text, responses: [] });
    else if (t.role === "tool") {
      const input = JSON.parse(t.text.slice("request_quote ".length, t.text.indexOf(" -> ")));
      out[out.length - 1].responses.push({ stop_reason: "tool_use", content: [{ type: "tool_use", id: `t${out.length}`, name: "request_quote", input }] as Anthropic.ContentBlock[] });
    } else if (!t.text.startsWith("[result note]")) {
      out[out.length - 1].responses.push({ stop_reason: "end_turn", content: [{ type: "text", text: t.text, citations: null }] as Anthropic.ContentBlock[] });
    }
  }
  return out;
}

async function capture(file: string) {
  const turns = read(file).filter((e): e is Turn => e.type === "conversation.turn");
  const runIds = turns.filter((t) => t.role === "tool" && t.runId).map((t) => t.runId!);
  const now = new Date(turns[0].t);
  const calls: unknown[] = [];
  const queue = script(turns);
  let pending: Partial<Anthropic.Message>[] = [];
  const client = {
    messages: {
      create: async (req: unknown) => {
        calls.push(JSON.parse(JSON.stringify(req)));
        const r = pending.shift();
        if (!r) throw new Error("no scripted response");
        return { model: "claude-haiku-5-5", usage: { input_tokens: 1, output_tokens: 1 }, ...r };
      },
    },
  } as unknown as Anthropic;
  const started: unknown[] = [];
  const orch = {
    async startQuote(request: unknown, carrierIds: string[], opts: unknown) { started.push({ request, carrierIds, opts }); return runIds[started.length - 1]; },
    subscribe() { return () => {}; },
    async finished() { throw new Error("unused"); },
  } as unknown as Orchestrator;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qb-step10-"));
  const conv = new Conversation(orch, { client, now: () => now, recordDir: dir, label: "after-final" });
  const replies: unknown[] = [];
  for (const m of queue) {
    pending = m.responses;
    replies.push(await conv.send(m.user));
  }
  const recorded = read(conv.recordFile!).map((e) => {
    const { t: _t, ms: _ms, conversationId: _c, ...rest } = e as Turn;
    return rest;
  });
  fs.rmSync(dir, { recursive: true, force: true });
  const quotes = runIds.map((id) => {
    const q = read(path.join(path.dirname(file), `${id}.jsonl`));
    const view = buildQuoteView(q, now);
    return { runId: id, view: JSON.parse(JSON.stringify(view)), digest: resultDigest(view) };
  });
  return { calls, started, replies, recorded, quotes };
}

test("no regression without memories: the five recorded conversations give the same model input, request, replies, record and view", async () => {
  assert.equal(records.length, 5);
  const got: Record<string, unknown> = {};
  for (const f of records) got[path.basename(f)] = JSON.parse(JSON.stringify(await capture(f))); // as stored
  if (process.env.WRITE_GOLDEN === "conversation") {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + "\n");
  }
  const want = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
  assert.deepEqual(Object.keys(got), Object.keys(want));
  for (const k of Object.keys(want)) assert.deepEqual(got[k], want[k], k);
});
