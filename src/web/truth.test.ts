// What the UI says must be true, and the `priority` parameter. Uses the recorded quote of case 7.
// No browser, no network: a fake orchestrator delivers recorded events, a fake model starts the quote.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { createApp } from "./app.js";
import { Conversation } from "../conversation/session.js";
import type { Orchestrator } from "../orchestrator/types.js";
import type { RunEvent } from "../record/events.js";
import { fold } from "../record/state.js";
import { buildQuoteView, interruptView, progressLine } from "../orchestrator/view.js";
import { getConversation, quoteStartedAt, quotedLabel } from "../history/history.js";
import { historyDir } from "../history/fixture.js";

const FIXTURE7 = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "record", "fixtures", "case7-qotf.jsonl");
const case7 = (): RunEvent[] => fs.readFileSync(FIXTURE7, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const until = (seq: number) => case7().filter((e) => e.seq <= seq);

// ---- view helpers ----

test("progress says who is searching and who waits for data, not 'N of M finished'", () => {
  // seq 7: Estafeta, FedEx and DHL started; Redpack and UPS skipped.
  assert.equal(buildQuoteView(until(7)).progress, "3 buscando, 2 esperan un dato.");
  // seq 10: DHL closed as blocked.
  assert.equal(buildQuoteView(until(10)).progress, "2 buscando, 2 esperan un dato, 1 sin precio.");
  assert.equal(buildQuoteView(case7()).progress, "2 con precio, 2 esperan un dato, 1 sin precio.");
  assert.equal(progressLine([]), "");
});

test("a skipped carrier says which data is missing", () => {
  const ups = buildQuoteView(case7()).carriers.find((c) => c.carrierId === "ups")!;
  assert.match(ups.message, /^Falta la fecha de envío\. Si nos lo dices en el chat, cotizamos UPS México aparte\./);
});

test("an interrupted quote never says 'Buscando…': open carriers say it stopped; verified prices stay", () => {
  // Estafeta's 4 prices are verified (seq 46), FedEx never closed, no run.finished.
  const v = interruptView(buildQuoteView(until(49)));
  assert.equal(v.interrupted, true);
  const fedex = v.carriers.find((c) => c.carrierId === "fedex")!;
  assert.deepEqual([fedex.status, fedex.label, fedex.message], ["interrupted", "Se interrumpió", "La cotización se detuvo antes de terminar."]);
  assert.equal(v.carriers.find((c) => c.carrierId === "estafeta")!.status, "quoted");
  assert.equal(v.ranked.length, 4, "the verified prices are still shown");
  assert.match(v.progress, /^La cotización se detuvo antes de terminar\. 1 con precio, 2 esperan un dato, 1 sin precio, 1 sin terminar\.$/);
  assert.ok(v.carriers.every((c) => c.label !== "Buscando…"));
});

test("in replay mode 'Cotizado el…' is the original record's time, not the replay's", () => {
  const replay = case7().map((e) => (e.type === "run.started" ? { ...e, t: "2026-11-20T18:00:00.000Z", runId: "replay-x", replayOf: FIXTURE7 } : e));
  assert.equal(quoteStartedAt(replay), "2026-11-19T04:21:55.804Z");
  assert.equal(quotedLabel(quoteStartedAt(replay)!), "Cotizado el 18 nov a las 22:21");
  const missing = replay.map((e) => (e.type === "run.started" ? { ...e, replayOf: "runs/nope/nope.jsonl" } : e));
  assert.equal(quoteStartedAt(missing), "2026-11-20T18:00:00.000Z", "without the original, the replay's own time");
});

test("priority reorders on the server; by_date only with a deadline", () => {
  const cheap = buildQuoteView(case7());
  assert.equal(cheap.priority, "cheapest");
  assert.equal(cheap.ranked[0].price.priceText, "$488.80");
  const fast = buildQuoteView(case7(), new Date("2026-11-19T04:21:55Z"), { priority: "fastest" });
  assert.equal(fast.priority, "fastest");
  assert.deepEqual([fast.ranked[0].carrierId, fast.ranked[0].price.service], ["estafeta", "12:30"]); // next business day before 12:30
  assert.equal(cheap.canRankByDate, false);
  assert.equal(buildQuoteView(case7(), new Date(), { priority: "by_date" }).priority, "cheapest", "no deadline: by_date is ignored");
  const d = getConversation(historyDir(), "conversation-c7", new Date("2026-11-19T16:00:00Z"), { priority: "fastest" })!;
  const q = d.items.find((i) => i.kind === "quote");
  assert.ok(q && q.kind === "quote" && q.view);
  assert.equal(q.view.ranked[0].price.service, "12:30");
});

// ---- over HTTP: a quote running in this process ----

const RUN = "quote-live";
let delivered: RunEvent[] = until(7);
// Like the real orchestrator: finished() resolves once run.finished has been delivered (see finishRun()).
let finishRun: () => void = () => {};
const done = new Promise<ReturnType<typeof fold>>((r) => { finishRun = () => r(fold(case7())); });
const orchestrator: Orchestrator = {
  async startQuote() { return RUN; },
  subscribe(runId, onEvent) {
    if (runId !== RUN) throw new Error("unknown run");
    delivered.forEach(onEvent);
    return () => {};
  },
  finished: () => done,
};
function quotingClient(): Anthropic {
  const script = [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "request_quote", input: { originZip: "64000", destZip: "22000", parcel: { weight: 10, weightUnit: "kg", length: 40, width: 30, height: 30, lengthUnit: "cm" }, count: 4 } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Estoy cotizando.", citations: null }] },
  ];
  return { messages: { create: async () => ({ model: "claude-haiku-5-5", usage: { input_tokens: 1, output_tokens: 1 }, ...script.shift()! }) } } as unknown as Anthropic;
}

let server: http.Server;
let base = "";
before(async () => {
  const dir = historyDir();
  server = createApp({
    orchestrator, replay: false, historyDir: dir, runsRoot: dir, publicDir: fs.mkdtempSync(path.join(os.tmpdir(), "qb-pub-")),
    newConversation: () => new Conversation(orchestrator, { client: quotingClient(), recordDir: dir }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("GET /api/quotes/:id while running gives the live progress and, for closed carriers, the final label and message", async () => {
  const r = await fetch(base + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "4 cajas de 10 kg de 64000 a 22000, 40x30x30" }) });
  assert.equal((await r.json()).runId, RUN);
  delivered = until(10);
  const v = await (await fetch(`${base}/api/quotes/${RUN}`)).json();
  assert.equal(v.interrupted, undefined, "running in this process: not interrupted");
  assert.equal(v.progress, "2 buscando, 2 esperan un dato, 1 sin precio.");
  const dhl = v.carriers.find((c: { carrierId: string }) => c.carrierId === "dhl");
  assert.equal(dhl.label, "Bloqueada");
  assert.match(dhl.message, /no dejó consultar de forma automática/);
  assert.equal(v.carriers.find((c: { carrierId: string }) => c.carrierId === "estafeta").label, "Buscando…");
  delivered = case7();
  finishRun();
  const fast = await (await fetch(`${base}/api/quotes/${RUN}?priority=fastest`)).json();
  assert.equal(fast.priority, "fastest");
  assert.equal(fast.ranked[0].price.service, "12:30");
  const junk = await (await fetch(`${base}/api/quotes/${RUN}?priority=random`)).json();
  assert.equal(junk.priority, "cheapest");
});

test("GET /api/quotes/:id also serves a past quote from its record on disk, ranked by ?priority", async () => {
  const v = await (await fetch(`${base}/api/quotes/quote-2026-11-19T04-21-55-802Z-qotf?priority=fastest`)).json();
  assert.equal(v.finished, true);
  assert.equal(v.ranked[0].price.service, "12:30");
  assert.equal(v.quotedLabel, "Cotizado el 18 nov a las 22:21");
  assert.equal((await fetch(`${base}/api/quotes/quote-nope`)).status, 404);
});

test("the history detail takes ?priority too", async () => {
  const d = await (await fetch(`${base}/api/conversations/conversation-c7?priority=fastest`)).json();
  const q = d.items.find((i: { kind: string }) => i.kind === "quote");
  assert.equal(q.view.priority, "fastest");
  assert.equal(q.view.ranked[0].price.service, "12:30");
});
