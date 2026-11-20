// Tests for the "after" protocol (--reply): fake model client + orchestrator in replay mode. No network, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { Conversation } from "../conversation/session.js";
import { createOrchestrator } from "../orchestrator/index.js";
import { carrierSummaries, parseAfterArgs, runAfterCase, toolErrorCounts, type CaseTurn } from "./afterCase.js";
import { fold } from "../record/state.js";
import type { RunEvent } from "../record/events.js";

const NOW = new Date("2026-11-18T18:00:00Z");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qb-after-"));

// A tiny recorded Estafeta run to replay.
function replayFixture(): string {
  const file = path.join(tmp(), "recorded.jsonl");
  const events = [
    { type: "run.started", runId: "rec", label: "fixture", carrierIds: ["estafeta"] },
    { type: "carrier.started", carrierId: "estafeta", startUrl: "u", budget: { maxSteps: 15, maxSeconds: 150 }, traceFile: "t.zip" },
    { type: "evidence.captured", carrierId: "estafeta", evidenceId: "ev1", reason: "r", url: "u", text: "Terrestre $778.87", capturedAt: "", images: [] },
    { type: "price.verified", carrierId: "estafeta", service: "Terrestre", amount: 778.87, currency: "MXN", includesVAT: null, deliveryDays: null, priceText: "$778.87", evidenceId: "ev1" },
    { type: "carrier.closed", carrierId: "estafeta", status: "quoted", reason: "ok", closedBy: "model" },
    { type: "run.finished", status: "completed" },
  ].map((e, i) => ({ seq: i + 1, t: "", ms: i, ...e }));
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

function scriptedClient(responses: Partial<Anthropic.Message>[]) {
  const seen: string[] = [];
  const client = {
    messages: {
      create: async (req: { messages: Anthropic.MessageParam[] }) => {
        const last = req.messages[req.messages.length - 1];
        if (typeof last?.content === "string") seen.push(last.content);
        const r = responses.shift();
        if (!r) throw new Error("no more scripted responses");
        return { model: "claude-haiku-5-5", usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn", ...r };
      },
    },
  } as unknown as Anthropic;
  return { client, seen };
}
const text = (t: string) => ({ content: [{ type: "text", text: t, citations: null }] as Anthropic.ContentBlock[] });
const quoteCall = (id: string) => ({
  stop_reason: "tool_use" as const,
  content: [{ type: "tool_use", id, name: "request_quote", input: { originZip: "06600", destZip: "97000", parcel: { weight: 3, weightUnit: "kg", length: 30, width: 20, height: 15, lengthUnit: "cm" }, carriers: ["estafeta"] } }] as Anthropic.ContentBlock[],
});

function setup(responses: Partial<Anthropic.Message>[]) {
  const orchestrator = createOrchestrator({ mode: "replay", replayFile: replayFixture(), replaySpeed: 1000, runsRoot: tmp() });
  const { client, seen } = scriptedClient(responses);
  const conversation = new Conversation(orchestrator, { client, now: () => NOW, recordDir: null });
  return { conversation, seen };
}

test("--reply: the bot asks in turn 1, the fixed reply goes as turn 2 in the same conversation and starts the quote", async () => {
  const { conversation, seen } = setup([
    text("¿Cuánto mide la caja?"),
    quoteCall("t1"),
    text("Listo, estoy cotizando."),
  ]);
  const turns: CaseTurn[] = [];
  const r = await runAfterCase(conversation, "Envío de 3 kg de 06600 a 97000", { reply: "La caja mide 30x20x15 cm", turns });
  assert.equal(r.replySent, true);
  assert.ok(r.runId?.startsWith("replay-"));
  assert.deepEqual(turns.map((t) => t.user), ["Envío de 3 kg de 06600 a 97000", "La caja mide 30x20x15 cm"]);
  assert.equal(turns[0].assistant, "¿Cuánto mide la caja?");
  assert.equal(turns[0].runId, undefined);
  assert.equal(turns[1].runId, r.runId);
  // Same conversation: the second user message follows the first exchange in one history.
  assert.deepEqual(seen, ["Envío de 3 kg de 06600 a 97000", "La caja mide 30x20x15 cm"]);
  assert.equal(conversation.messages.filter((m) => m.role === "user" && typeof m.content === "string").length, 2);
});

test("--reply is NOT sent when turn 1 already started a quote", async () => {
  const { conversation, seen } = setup([quoteCall("t1"), text("Cotizando.")]);
  const turns: CaseTurn[] = [];
  const r = await runAfterCase(conversation, "3 kg, 30x20x15, de 06600 a 97000", { reply: "La caja mide 30x20x15 cm", turns });
  assert.equal(r.replySent, false);
  assert.equal(turns.length, 1);
  assert.ok(r.runId);
  assert.deepEqual(seen, ["3 kg, 30x20x15, de 06600 a 97000"]);
});

test("without --reply nothing changes: one turn, no quote if the bot asks", async () => {
  const { conversation } = setup([text("¿Cuánto mide la caja?")]);
  const turns: CaseTurn[] = [];
  const r = await runAfterCase(conversation, "Envío de 3 kg", { turns });
  assert.equal(r.replySent, false);
  assert.equal(r.runId, undefined);
  assert.equal(turns.length, 1);
});

test("parseAfterArgs: --reply anywhere, keeps caseId and label; rejects a missing text", () => {
  assert.deepEqual(parseAfterArgs(["5", "after-2t", "--reply", "El destino es el CP 72000 y la caja mide 33x20x12 cm"]), {
    caseId: 5, label: "after-2t", reply: "El destino es el CP 72000 y la caja mide 33x20x12 cm",
  });
  assert.deepEqual(parseAfterArgs(["--reply", "La caja mide 30x20x15 cm", "9", "after-2t"]), { caseId: 9, label: "after-2t", reply: "La caja mide 30x20x15 cm" });
  assert.deepEqual(parseAfterArgs(["7"]), { caseId: 7, label: "after" });
  assert.ok("error" in parseAfterArgs(["5", "--reply"]));
  assert.ok("error" in parseAfterArgs(["x"]));
});

// ---- tool errors from the record, and turns and seconds per carrier ----

const ev = (list: Record<string, unknown>[]) => list.map((e, i) => ({ seq: i + 1, t: "", ms: i * 1000, ...e })) as RunEvent[];

test("a model tool failure without shownToModel counts as hidden; harness failures (step 0, model call) do not count", () => {
  const events = ev([
    { type: "step.failed", carrierId: "fedex", step: 0, tool: "wait_ready", args: {}, error: "x", shownToModel: false },
    { type: "step.failed", carrierId: "fedex", step: 3, tool: "click", args: {}, error: "x", shownToModel: true },
    { type: "step.failed", carrierId: "fedex", step: 4, tool: "fill_field", args: {}, error: "x" },
    { type: "step.failed", carrierId: "fedex", step: 5, tool: "choose_option", args: {}, error: "x", shownToModel: false },
    { type: "step.failed", carrierId: "fedex", step: 6, tool: "model", args: null, error: "x", shownToModel: false },
  ]);
  assert.deepEqual(toolErrorCounts(events), { hidden: 2, shown: 1 });
  assert.deepEqual(toolErrorCounts([]), { hidden: 0, shown: 0 });
  // An older record without shownToModel does not say: null, not a count.
  assert.deepEqual(toolErrorCounts(ev([{ type: "step.failed", carrierId: "fedex", step: 3, tool: "click", args: {}, error: "x" }])), { hidden: null, shown: null });
});

test("carriers[] carries model turns and seconds from carrier.started to carrier.closed", () => {
  const usage = { input_tokens: 1, output_tokens: 1 };
  const state = fold(ev([
    { type: "run.started", runId: "r", label: "t", carrierIds: ["fedex", "ups"] },
    { type: "carrier.skipped", carrierId: "ups", missing: [{ field: "shipDate", why: "date" }] },
    { type: "carrier.started", carrierId: "fedex", startUrl: "u", budget: { maxSteps: 20, maxSeconds: 180 }, traceFile: "t" },
    { type: "model.response", carrierId: "fedex", step: 1, model: "m", stopReason: "tool_use", usage, costUsd: 0.01, text: "" },
    { type: "model.response", carrierId: "fedex", step: 2, model: "m", stopReason: "tool_use", usage, costUsd: 0.01, text: "" },
    { type: "carrier.closed", carrierId: "fedex", status: "failed", reason: "x", closedBy: "model" },
  ]));
  const [fedex, ups] = ["fedex", "ups"].map((id) => carrierSummaries(state).find((c) => c.carrierId === id)!);
  assert.equal(fedex.modelTurns, 2);
  assert.equal(fedex.seconds, 3); // started at 2 s, closed at 5 s
  assert.equal(ups.modelTurns, 0);
  assert.equal(ups.seconds, 0);
});
