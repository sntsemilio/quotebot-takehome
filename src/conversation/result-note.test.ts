// The result note does not claim more than the record says. Over a live session with Memorias
// (results/live-memorias: conversation kgvf, quotes pz79 and pt8c). Fake model, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { RunEvent } from "../record/events.js";
import type { Orchestrator } from "../orchestrator/types.js";
import { fold } from "../record/state.js";
import { buildQuoteView } from "../orchestrator/view.js";
import { Conversation, resultDigest } from "./session.js";
import { redpack } from "../carriers/redpack.js";
import { ups } from "../carriers/ups.js";

const DIR = path.join("results", "live-memorias");
const read = (f: string): RunEvent[] => fs.readFileSync(path.join(DIR, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const PZ79 = "quote-2026-11-19T21-03-55-744Z-pz79.jsonl";
const PT8C = "quote-2026-11-19T21-04-58-107Z-pt8c.jsonl";
const NOW = new Date("2026-11-19T21:05:00Z");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

test("pz79's digest has no Redpack or UPS (they were waiting for data) and says nobody chose a priority", () => {
  const v = buildQuoteView(read(PZ79), NOW);
  assert.equal(v.request?.preference, undefined, "the request carries no preference");
  assert.ok(v.carriers.filter((c) => c.missing).map((c) => c.carrierId).sort().join() === "redpack,ups");
  const digest = resultDigest(v);
  assert.equal(digest.split("\n")[0], "Order: by price, the app's default. The user did not choose a priority: never say they chose one.");
  assert.doesNotMatch(digest, /Redpack|UPS/);
  assert.doesNotMatch(digest, /Do not mention it|not launched/);
  assert.match(digest, /- DHL México: blocked\./);
});

test("pt8c's digest gives Redpack's message without its caveat; the final note has each caveat exactly once", async () => {
  const events = read(PT8C);
  const v = buildQuoteView(events, NOW);
  const caveat = redpack.caveats![0].text;
  const digest = resultDigest(v);
  assert.equal(digest.split("\n")[0], "Priority chosen by the user: cheapest", "pt8c's request carries a preference");
  assert.match(digest, /- Redpack: no_coverage\. Redpack dice que no da servicio en esa ruta\. Su página dice: "SIN COBERTURA"\.\n/);
  assert.equal(count(digest, caveat), 0);
  assert.doesNotMatch(digest, /colonia/);

  // The model returns its recorded paraphrase (the recorded note before the caveats code appended).
  const turns = read("conversation-2026-11-19T21-03-35-758Z-kgvf.jsonl").filter((e): e is Extract<RunEvent, { type: "conversation.turn" }> => e.type === "conversation.turn");
  const recorded = turns.find((t) => t.runId?.endsWith("pt8c") && t.text.startsWith("[result note]"))!.text.slice("[result note] ".length);
  const paraphrase = recorded.slice(0, recorded.indexOf(caveat)).trim();
  assert.ok(paraphrase.endsWith("puedes cotizar directamente en su página."));
  const client = {
    messages: {
      create: async () => ({ model: "claude-haiku-5-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: paraphrase, citations: null }] }),
    },
  } as unknown as Anthropic;
  const orch = {
    async startQuote() { throw new Error("unused"); },
    subscribe(_id: string, on: (e: RunEvent) => void) { events.forEach(on); return () => {}; },
    async finished() { return fold(events); },
  } as unknown as Orchestrator;
  const { note } = await new Conversation(orch, { client, now: () => NOW, recordDir: null }).describeResult("pt8c");
  assert.equal(count(note, caveat), 1, note);
  assert.equal(count(note, ups.caveats![0].text), 1, note);
});
