// No amount reaches the chat. The model's sentences with an amount are removed in code before the
// reply is shown, and the conversation.turn records it. Fake model and fake orchestrator: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { AMOUNTS_REMOVED, Conversation, MONEY, redactAmounts } from "./session.js";
import type { Orchestrator } from "../orchestrator/types.js";
import { readEvents } from "../record/store.js";

const orch: Orchestrator = {
  async startQuote() { throw new Error("no quote in this test"); },
  subscribe() { throw new Error("unused"); },
  async finished() { throw new Error("unused"); },
};
function says(text: string): Anthropic {
  return {
    messages: {
      create: async () => ({
        model: "claude-haiku-5-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: "text", text, citations: null }],
      }),
    },
  } as unknown as Anthropic;
}

test("an amount inside a valid question is removed; the question stays and the turn records the redaction", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qb-amounts-"));
  const conv = new Conversation(orch, { client: says("Con esas medidas te sale en $350, ¿me confirmas el código postal de destino?"), recordDir: dir });
  const r = await conv.send("¿Cuánto me sale una caja de 2 kg a Mérida?");
  assert.equal(r.text, "¿me confirmas el código postal de destino?");
  assert.doesNotMatch(r.text, /350/);
  const turn = readEvents(conv.recordFile!).filter((e) => e.type === "conversation.turn").pop()!;
  assert.ok(turn.type === "conversation.turn");
  assert.equal(turn.text, r.text, "the record keeps what was shown, not the amount");
  assert.equal(turn.redacted, true);
  assert.equal(turn.redactedSentences, 1);
});

test("a reply that is all amounts becomes the fixed text; a reply without amounts is untouched", async () => {
  const conv = new Conversation(orch, { client: says("Te sale en 350 pesos. El total es 1,400.00."), recordDir: null });
  assert.equal((await conv.send("¿cuánto?")).text, AMOUNTS_REMOVED);
  const ask = "¿Me das el peso y las medidas de la caja? Si son 2.50 kg y 30 x 20 cm, dímelo así.";
  assert.deepEqual(redactAmounts(ask), { text: ask, removed: 0 }, "weight and size are not money");
});

test("what counts as an amount", () => {
  for (const s of ["$350", "$ 1,200", "350 MXN", "350 pesos", "MXN 350", "1,234.56", "un total de 778.87"]) assert.match(s, MONEY, s);
  for (const s of ["el peso de la caja", "2.50 kg", "30.00 cm", "64000", "4 cajas de 10 kg", "llega el 27"]) assert.doesNotMatch(s, MONEY, s);
  assert.deepEqual(redactAmounts("Cotizo con Estafeta.\n- Estafeta: $350\n- FedEx: sin precio"), { text: "Cotizo con Estafeta.\n- FedEx: sin precio", removed: 1 });
});
