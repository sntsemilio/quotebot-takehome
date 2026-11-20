// The history, the note's message and an unconfirmed postal code, over the live sessions with Memorias
// (results/live-memorias: conversations kgvf and 7aj1, quotes pz79, pt8c, nzss and 2x3q). Fake model, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { RunEvent } from "../record/events.js";
import type { Orchestrator } from "../orchestrator/types.js";
import { fold } from "../record/state.js";
import { buildQuoteView } from "../orchestrator/view.js";
import { Conversation, fallbackNote, guardNote, resultDigest } from "../conversation/session.js";
import { listConversations } from "./history.js";

const DIR = path.join("results", "live-memorias");
const read = (f: string): RunEvent[] => fs.readFileSync(path.join(DIR, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const C7AJ1 = "conversation-2026-11-19T21-38-48-997Z-7aj1.jsonl";
const NZSS = "quote-2026-11-19T21-38-51-205Z-nzss.jsonl";
const X3Q = "quote-2026-11-19T21-39-05-399Z-2x3q.jsonl";
const NOW = new Date("2026-11-19T21:45:00Z");
type Turn = Extract<RunEvent, { type: "conversation.turn" }>;

test("the history sums up the shipment: neither conversation says 'Sin precio'; 7aj1 keeps its cities", () => {
  const list = listConversations(DIR, NOW);
  assert.equal(list.length, 2);
  for (const c of list) assert.notEqual(c.line, "Sin precio", c.id);
  const c7 = list.find((c) => c.id.endsWith("7aj1"))!;
  assert.equal(c7.title, "Monterrey a Tijuana, 4 cajas de 10 kg");
  assert.match(c7.line, /^Estafeta 12:30: .* por 4 cajas$/, "the first option of nzss, the shipment's latest quote with prices");
  const kgvf = list.find((c) => c.id.endsWith("kgvf"))!;
  assert.match(kgvf.line, /^FedEx Nacional Económico: .* por 4 cajas$/);
  assert.doesNotMatch(kgvf.title, /^01299 a 64700/, "cities from pz79, the same shipment");
});

test("a quote's note reads the message that started it, not a later follow-up", async () => {
  const turns = read(C7AJ1).filter((e): e is Turn => e.type === "conversation.turn");
  const runIds = turns.filter((t) => t.role === "tool").map((t) => t.runId!);
  const notePrompts: string[] = [];
  const queue: Partial<Anthropic.Message>[] = [];
  for (const t of turns) {
    if (t.role === "tool") {
      const input = JSON.parse(t.text.slice("request_quote ".length, t.text.indexOf(" -> ")));
      queue.push({ stop_reason: "tool_use", content: [{ type: "tool_use", id: t.runId!, name: "request_quote", input }] as Anthropic.ContentBlock[] });
    } else if (t.role === "assistant" && !t.text.startsWith("[result note]")) {
      queue.push({ stop_reason: "end_turn", content: [{ type: "text", text: t.text, citations: null }] as Anthropic.ContentBlock[] });
    }
  }
  const client = {
    messages: {
      create: async (req: { tools?: unknown; messages: { content: unknown }[] }) => {
        const base = { model: "claude-haiku-5-5", usage: { input_tokens: 1, output_tokens: 1 } };
        if (!req.tools) {
          notePrompts.push(String(req.messages[0].content));
          return { ...base, stop_reason: "end_turn", content: [{ type: "text", text: "Nota.", citations: null }] };
        }
        return { ...base, ...queue.shift()! };
      },
    },
  } as unknown as Anthropic;
  const events = Object.fromEntries(runIds.map((id) => [id, read(`${id}.jsonl`)]));
  let n = 0;
  const orch = {
    async startQuote() { return runIds[n++]; },
    subscribe(id: string, on: (e: RunEvent) => void) { events[id].forEach(on); return () => {}; },
    async finished(id: string) { return fold(events[id]); },
  } as unknown as Orchestrator;
  const conv = new Conversation(orch, { client, now: () => NOW, recordDir: null });
  for (const t of turns.filter((x) => x.role === "user")) await conv.send(t.text);
  await conv.describeResult(runIds[0]); // nzss's note, written after the follow-up, as in the live run
  assert.match(notePrompts[0], /^User's last message \(use its language\): 4 #caja-mediana de 10 kg desde #tienda-nopal a 22000\n/);
  assert.doesNotMatch(notePrompts[0], /a domicilio, lo envío mañana/);
  await conv.describeResult(runIds[1]);
  assert.match(notePrompts[1], /^User's last message \(use its language\): a domicilio, lo envío mañana\n/);
});

test("Redpack's form did not continue without a message: 'Sin terminar', buttons, no 'no aceptó'", () => {
  const v = buildQuoteView(read(X3Q), NOW);
  const redpack = v.carriers.find((c) => c.carrierId === "redpack")!;
  assert.equal(redpack.label, "Sin terminar");
  assert.equal(redpack.manualQuote?.label, "Cotizar en el sitio de Redpack");
  assert.equal(redpack.message, "El formulario de Redpack no continuó con el CP 64000 y su página no mostró ningún error. Puede ser el CP o su formulario; si tu CP es correcto, cotiza en su sitio.");
  assert.ok(v.shipmentText, "the data to copy for its site");
  for (const t of [redpack.message, resultDigest(v), fallbackNote(v)]) assert.doesNotMatch(t, /no aceptó|REJECTED/);
  // Nobody else quoted in 2x3q, so 64000 was not recognized in this quote: confirm it, or quote on the site.
  assert.match(resultDigest(v), /Redpack's form did not continue with postal code 64000 \(origin\) and its page showed no error: it may be the code or the form\. Ask the user to confirm it/);
});

test("when another site recognized the code in the same quote, the row and the digest say so and nothing asks to confirm it", () => {
  // Synthetic: nzss (Estafeta recognized «CP 64000 MONTERREY, NUEVO LEON») plus a Redpack that closed with rejectedZip
  // origin and no site message.
  const base = read(NZSS);
  const finished = base.findIndex((e) => e.type === "run.finished");
  // nzss left Redpack waiting for data (carrier.skipped); here it is launched instead.
  const events = [
    ...base.slice(0, finished).filter((e) => !(e.type === "carrier.skipped" && e.carrierId === "redpack")),
    { seq: 9001, t: "", ms: 0, type: "carrier.started", carrierId: "redpack", startUrl: "u", budget: { maxSteps: 1, maxSeconds: 1 }, traceFile: "t" },
    { seq: 9002, t: "", ms: 0, type: "carrier.closed", carrierId: "redpack", status: "needs_human", reason: "no suggestion list appeared", closedBy: "model", rejectedZip: "origin" },
    base[finished],
  ] as RunEvent[];
  const v = buildQuoteView(events, NOW);
  const redpack = v.carriers.find((c) => c.carrierId === "redpack")!;
  assert.match(redpack.message, /Estafeta sí lo reconoció: «CP 64000 MONTERREY, NUEVO LEON»; parece ser su formulario\.$/);
  assert.equal(redpack.label, "Sin terminar");
  const digest = resultDigest(v);
  assert.match(digest, /Redpack's form did not continue with postal code 64000 \(origin\) and its page showed no error\. Estafeta \("CP 64000 MONTERREY, NUEVO LEON"\) recognized it in this quote: it looks like Redpack's form, not the code\. Do NOT ask the user to confirm it/);
  const guarded = guardNote("La opción más rápida es Estafeta 12:30.", v);
  assert.match(guarded, /Estafeta sí lo reconoció/);
  assert.doesNotMatch(guarded + fallbackNote(v), /¿Me confirmas el código postal/);
});

test("case 9 (99999, no site message): the note still asks to confirm the postal code", () => {
  const events = fs.readFileSync(path.join("fixtures", "records", "two-turn", "quote-2026-11-19T16-16-18-738Z-mg5h.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as RunEvent);
  const v = buildQuoteView(events, NOW);
  assert.match(resultDigest(v), /Ask the user to confirm it and, if it is correct, to quote on FedEx México's site\./);
  assert.match(fallbackNote(v), /¿Me confirmas el código postal de origen\?/);
  assert.match(guardNote("No conseguimos precios.", v), /¿Me confirmas el código postal de origen\?/);
});
