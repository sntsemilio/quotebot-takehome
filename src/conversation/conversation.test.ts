// Conversation tests with a fake model client and a fake orchestrator. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { prepareQuote } from "./requestQuote.js";
import { Conversation, resultDigest, fallbackNote } from "./session.js";
import { buildQuoteView } from "../orchestrator/view.js";
import type { CarrierPlugin } from "../carriers/types.js";
import type { Orchestrator } from "../orchestrator/types.js";
import type { RunEvent } from "../record/events.js";

const NOW = new Date("2026-11-18T03:30:00Z"); // 2026-11-17 21:30 in Monterrey
const p = (id: string, extra: Partial<CarrierPlugin> = {}): CarrierPlugin => ({
  id, name: id[0].toUpperCase() + id.slice(1), startUrl: "u", allowedDomains: [], notes: "", budget: { maxSteps: 1, maxSeconds: 1 }, ...extra,
});
const plugins = { estafeta: p("estafeta"), redpack: p("redpack", { needs: [{ field: "deliveryType", why: "home or branch" }, { field: "customerType", why: "individual or business" }] }) };
const box = { weight: 2, weightUnit: "kg", length: 30, width: 20, height: 15, lengthUnit: "cm" };

test("prepareQuote converts lb/in in code (case 3)", () => {
  const r = prepareQuote({ originZip: "22010", destZip: "77500", parcel: { weight: 5, weightUnit: "lb", length: 12, width: 10, height: 8, lengthUnit: "in" }, carriers: ["estafeta"] }, plugins, NOW);
  assert.ok(r.ok);
  assert.deepEqual(r.request.parcels[0], { weightKg: 2.27, lengthCm: 30.48, widthCm: 25.4, heightCm: 20.32 });
});

test("prepareQuote returns validation errors verbatim and never fills a postal code", () => {
  const r = prepareQuote({ originZip: "Guadalajara", destZip: "", parcel: box }, plugins, NOW);
  assert.ok(!r.ok && r.kind === "invalid");
  assert.match(r.message, /originZip must be a 5-digit postal code/);
  assert.match(r.message, /destZip must be a 5-digit postal code/);
  const u = prepareQuote({ originZip: "64000", destZip: "06600", parcel: { ...box, weightUnit: "oz" } }, plugins, NOW);
  assert.ok(!u.ok && /weightUnit must be kg or lb/.test(u.message));
});

test("prepareQuote: missing carrier data does not block; those carriers wait, the rest are launched", () => {
  const base = { originZip: "64000", destZip: "06600", parcel: box };
  const r = prepareQuote(base, plugins, NOW);
  assert.ok(r.ok);
  assert.deepEqual(r.carrierIds, ["estafeta", "redpack"]); // orchestrator records carrier.skipped for redpack
  assert.deepEqual(r.launched, ["estafeta"]);
  assert.deepEqual(r.waiting.map((w) => [w.carrierId, w.needs.map((n) => n.field)]), [["redpack", ["deliveryType", "customerType"]]]);
  const withData = prepareQuote({ ...base, extras: { deliveryType: "home", customerType: "business" } }, plugins, NOW);
  assert.ok(withData.ok && withData.waiting.length === 0 && withData.launched.length === 2);
  // Only carriers that lack data: nothing to quote yet, ask first.
  const onlyRedpack = prepareQuote({ ...base, carriers: ["redpack"] }, plugins, NOW);
  assert.ok(!onlyRedpack.ok && onlyRedpack.kind === "missing_needs" && /Redpack \(redpack\) needs: extras\.deliveryType/.test(onlyRedpack.message));
});

test("prepareQuote follow-up: same shipment without carriers quotes only the waiting ones; a different shipment quotes all", () => {
  const base = { originZip: "64000", destZip: "06600", parcel: box };
  const first = prepareQuote(base, plugins, NOW);
  assert.ok(first.ok);
  const followUp = { request: first.request, waiting: first.waiting.map((w) => w.carrierId) };
  const again = prepareQuote({ ...base, extras: { deliveryType: "branch", customerType: "individual" } }, plugins, NOW, followUp);
  assert.ok(again.ok);
  assert.deepEqual(again.carrierIds, ["redpack"]);
  assert.deepEqual(again.launched, ["redpack"]);
  const other = prepareQuote({ ...base, destZip: "97000" }, plugins, NOW, followUp);
  assert.ok(other.ok && other.carrierIds.length === 2);
});

test("prepareQuote: count, preference with a Monterrey date, unknown carrier", () => {
  const r = prepareQuote({ originZip: "03100", destZip: "72000", parcel: box, count: 4, carriers: ["estafeta"], preference: { priority: "by_date", deadline: "2026-11-18" } }, plugins, NOW);
  assert.ok(r.ok);
  assert.equal(r.request.count, 4);
  assert.deepEqual(r.request.preference, { priority: "by_date", deadline: "2026-11-18" });
  const bad = prepareQuote({ originZip: "03100", destZip: "72000", parcel: box, carriers: ["ups"] }, plugins, NOW);
  assert.ok(!bad.ok && /unknown carrier 'ups'/.test(bad.message));
});

// ---- conversation loop with fakes ----------------------------------------

function fakeClient(responses: Partial<Anthropic.Message>[]) {
  const calls: unknown[] = [];
  const client = {
    messages: {
      create: async (req: unknown) => {
        calls.push(req);
        const r = responses.shift();
        if (!r) throw new Error("no more scripted responses");
        return { model: "claude-haiku-5-5", usage: { input_tokens: 100, output_tokens: 20 }, stop_reason: "end_turn", ...r };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const quotedEvents = [
  { seq: 1, t: "", ms: 0, type: "run.started", runId: "q1", label: "t", carrierIds: ["estafeta"] },
  { seq: 2, t: "", ms: 1, type: "request.validated", request: { originZip: "64000", destZip: "22000", parcels: [{ weightKg: 10, lengthCm: 40, widthCm: 30, heightCm: 30 }] } },
  { seq: 3, t: "", ms: 2, type: "evidence.captured", carrierId: "estafeta", evidenceId: "ev1", reason: "r", url: "u", text: "CP 64000\nMONTERREY, NUEVO LEON\nCP 22000\nTIJUANA, BAJA CALIFORNIA\n778.87", capturedAt: "", images: [] },
  { seq: 4, t: "", ms: 3, type: "price.verified", carrierId: "estafeta", service: "Terrestre", amount: 778.87, currency: "MXN", includesVAT: true, deliveryDays: null, priceText: "778.87", evidenceId: "ev1", siteNotes: ["Cotización Aproximada"] },
  { seq: 5, t: "", ms: 4, type: "carrier.closed", carrierId: "estafeta", status: "quoted", reason: "ok", closedBy: "model" },
  { seq: 6, t: "", ms: 5, type: "run.finished", status: "completed" },
] as RunEvent[];

function fakeOrchestrator() {
  const started: { request: unknown; carrierIds: string[] }[] = [];
  const orch: Orchestrator = {
    async startQuote(request, carrierIds) { started.push({ request, carrierIds }); return "q1"; },
    subscribe(_runId, onEvent) { quotedEvents.forEach(onEvent); return () => {}; },
    async finished() { throw new Error("unused"); },
  };
  orch.finished = async () => (await import("../record/state.js")).fold(quotedEvents);
  return { orch, started };
}

test("a question turn does not start a quote (case 10 shape)", async () => {
  const { client } = fakeClient([{ content: [{ type: "text", text: "Para cotizar necesito: CP de origen, CP de destino en Oaxaca, peso y medidas.", citations: null }] as Anthropic.ContentBlock[] }]);
  const { orch, started } = fakeOrchestrator();
  const conv = new Conversation(orch, { client, plugins, now: () => NOW, recordDir: null });
  const r = await conv.send("hola, cuánto sale enviar algo a Oaxaca?");
  assert.equal(r.runId, undefined);
  assert.equal(started.length, 0);
});

test("request_quote starts right away with carriers that have their data; the result tells the model who waits for what", async () => {
  const { client, calls } = fakeClient([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "request_quote", input: { originZip: "64000", destZip: "22000", parcel: { ...box, weight: 10 } } }] as Anthropic.ContentBlock[] },
    { content: [{ type: "text", text: "Ya estoy cotizando con Estafeta. Para Redpack dime si es a domicilio o sucursal y si eres persona física o moral.", citations: null }] as Anthropic.ContentBlock[] },
  ]);
  const { orch, started } = fakeOrchestrator();
  const conv = new Conversation(orch, { client, plugins, now: () => NOW, recordDir: null });
  const r = await conv.send("10 kg de 64000 a 22000, 30x20x15");
  assert.equal(r.runId, "q1");
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].carrierIds, ["estafeta", "redpack"]); // redpack -> carrier.skipped in the orchestrator
  assert.equal(calls.length, 2);
  // calls share the conversation's messages array by reference: inspect the final history.
  const toolResult = conv.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b) => b.type === "tool_result" && b.tool_use_id === "t1") as Anthropic.ToolResultBlockParam;
  assert.equal(toolResult.is_error, undefined);
  assert.match(String(toolResult.content), /Quote started \(q1\) with: Estafeta\./);
  assert.match(String(toolResult.content), /Not launched, waiting for data[\s\S]*Redpack \(redpack\) needs: extras\.deliveryType/);
  assert.match(String(toolResult.content), /carriers: \["redpack"\]/);
  assert.ok(conv.usage.costUsd > 0);
});

test("follow-up: when the user gives the missing data, the new quote is only for the waiting carriers", async () => {
  const quote = (id: string, input: Record<string, unknown>) => ({ stop_reason: "tool_use" as const, content: [{ type: "tool_use", id, name: "request_quote", input }] as Anthropic.ContentBlock[] });
  const shipment = { originZip: "64000", destZip: "22000", parcel: { ...box, weight: 10 } };
  const { client } = fakeClient([
    quote("t1", shipment),
    { content: [{ type: "text", text: "Cotizando con Estafeta; para Redpack necesito dos datos.", citations: null }] as Anthropic.ContentBlock[] },
    // The model forgets to name carriers: code still limits the follow-up to the waiting carrier.
    quote("t2", { ...shipment, extras: { deliveryType: "home", customerType: "individual" } }),
    { content: [{ type: "text", text: "Listo, cotizando Redpack.", citations: null }] as Anthropic.ContentBlock[] },
  ]);
  const { orch, started } = fakeOrchestrator();
  const conv = new Conversation(orch, { client, plugins, now: () => NOW, recordDir: null });
  await conv.send("10 kg de 64000 a 22000, 30x20x15");
  await conv.send("A domicilio, persona física");
  assert.equal(started.length, 2);
  assert.deepEqual(started[1].carrierIds, ["redpack"]);
});

test("end to end without network: the orchestrator records the waiting carrier as skipped and the view says what is missing", async () => {
  const { createOrchestrator } = await import("../orchestrator/index.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const ran: string[] = [];
  const orch = createOrchestrator({
    runsRoot: fs.mkdtempSync(path.join(os.tmpdir(), "qb-needs-")),
    carriers: plugins,
    runCarrier: async ({ plugin: pl, store }) => {
      ran.push(pl.id);
      store.append("carrier.closed", { carrierId: pl.id, status: "failed", reason: "fake", closedBy: "code" });
    },
  });
  const { client } = fakeClient([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "request_quote", input: { originZip: "64000", destZip: "22000", parcel: { ...box, weight: 10 } } }] as Anthropic.ContentBlock[] },
    { content: [{ type: "text", text: "Cotizando.", citations: null }] as Anthropic.ContentBlock[] },
  ]);
  const conv = new Conversation(orch, { client, plugins, now: () => NOW, recordDir: null });
  const r = await conv.send("10 kg de 64000 a 22000, 30x20x15");
  const state = await orch.finished(r.runId!);
  assert.deepEqual(ran, ["estafeta"]); // redpack never launched
  const events: RunEvent[] = [];
  orch.subscribe(r.runId!, (e) => events.push(e));
  const redpack = buildQuoteView(events).carriers.find((c) => c.carrierId === "redpack")!;
  assert.equal(state.carriers.redpack.status, "needs_human");
  assert.equal(redpack.label, "Necesita un dato");
  // The test plugin has no registry entry, so the view uses the id as name; the missing data is spelled out.
  // The message says first which data is missing.
  assert.match(redpack.message, /^Faltan 2 datos: entrega a domicilio o en sucursal y persona física o moral\. Si nos lo dices en el chat, cotizamos .* aparte\./);
  assert.deepEqual(redpack.missing?.map((m) => m.field), ["deliveryType", "customerType"]);
});

test("result note: digest has no amounts; a note with money is replaced by the code fallback", async () => {
  const view = buildQuoteView(quotedEvents);
  const digest = resultDigest(view);
  assert.doesNotMatch(digest, /778|\$|MXN/);
  assert.match(digest, /CP 64000 MONTERREY, NUEVO LEON/);
  const { client } = fakeClient([{ content: [{ type: "text", text: "Lo más barato es Estafeta Terrestre por $778.87.", citations: null }] as Anthropic.ContentBlock[] }]);
  const { orch } = fakeOrchestrator();
  const conv = new Conversation(orch, { client, plugins, now: () => NOW, recordDir: null });
  conv.messages.push({ role: "user", content: "x" }, { role: "assistant", content: "ok" });
  const r = await conv.describeResult("q1");
  assert.equal(r.noteSource, "fallback");
  assert.equal(r.note, fallbackNote(view));
  assert.doesNotMatch(r.note, /778/);

  // A price with the site's breakdown. Its lines carry amounts: none reaches the digest; the VAT is said in words.
  const BREAKDOWN_TEXT = "Tarifa base\n$397.78\nIVA\n$73.19\nRECARGO POR COMBUSTIBLE\n$59.67\nTotal estimado\n$530.64\nLos montos se muestran en MXN";
  const withBreakdown = [
    ...quotedEvents.slice(0, 4).map((e) => (e.type === "run.started" ? { ...e, carrierIds: ["estafeta", "fedex"] } : e)),
    { seq: 10, t: "", ms: 6, type: "evidence.captured", carrierId: "fedex", evidenceId: "ev2", reason: "r", url: "u", text: `FedEx Nacional Económico\n$530.64\n${BREAKDOWN_TEXT}`, capturedAt: "", images: [] },
    { seq: 11, t: "", ms: 7, type: "price.verified", carrierId: "fedex", service: "FedEx Nacional Económico", amount: 530.64, currency: "MXN", includesVAT: true, deliveryDays: null, priceText: "$530.64", evidenceId: "ev2",
      siteNotes: ["Tarifa base $397.78", "IVA $73.19", "RECARGO POR COMBUSTIBLE $59.67", "Total estimado $530.64", "Los montos se muestran en MXN"],
      vatBreakdown: { vatLine: "IVA $73.19", totalLine: "Total estimado $530.64" } },
    { seq: 12, t: "", ms: 8, type: "carrier.closed", carrierId: "fedex", status: "quoted", reason: "ok", closedBy: "model" },
    { ...quotedEvents[4], seq: 13 }, { ...quotedEvents[5], seq: 14 },
  ] as RunEvent[];
  const d2 = resultDigest(buildQuoteView(withBreakdown));
  assert.doesNotMatch(d2, /397|73\.19|59\.67|530|778|\$/);
  assert.match(d2, /FedEx Nacional Económico: .*VAT included per the site's breakdown, site notes: "Los montos se muestran en MXN"/);
  assert.doesNotMatch(d2, /Tarifa base|Total estimado|RECARGO/);
});

// ---- integration additions: conversation record and plugin caveats ----

test("each turn goes to the conversation record as conversation.turn, with cost and the quote's runId", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { readEvents } = await import("../record/store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qb-conv-"));
  const { client } = fakeClient([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "request_quote", input: { originZip: "64000", destZip: "22000", parcel: box, carriers: ["estafeta"] } }] as Anthropic.ContentBlock[] },
    { content: [{ type: "text", text: "Cotizando.", citations: null }] as Anthropic.ContentBlock[] },
  ]);
  const { orch } = fakeOrchestrator();
  const conv = new Conversation(orch, { client, plugins, now: () => NOW, recordDir: dir });
  await conv.send("2 kg de 64000 a 22000, 30x20x15 cm, con Estafeta");
  const events = readEvents(conv.recordFile!);
  assert.deepEqual(events.map((e) => e.type === "conversation.turn" && e.role), ["user", "tool", "assistant"]);
  const [, tool, assistant] = events as Extract<RunEvent, { type: "conversation.turn" }>[];
  assert.equal(tool.runId, "q1");
  assert.equal(assistant.runId, "q1");
  assert.equal(assistant.model, "claude-haiku-5-5");
  assert.ok((tool.costUsd ?? 0) > 0 && (assistant.costUsd ?? 0) > 0); // cost lands on the turn its call produced
  assert.equal(events.every((e) => e.type === "conversation.turn" && e.conversationId === conv.conversationId), true);
  // Turns produced by model calls carry the call's stop reason and output tokens; the user turn does not.
  assert.deepEqual(events.map((e) => e.type === "conversation.turn" && [e.stopReason, e.outputTokens, e.thinkingBlocks]), [
    [undefined, undefined, undefined], ["tool_use", 20, 0], ["end_turn", 20, 0],
  ]);
});

const caveatEvents = (status: "no_coverage" | "failed", carrierId: string, reason: string) =>
  [
    { seq: 1, t: "", ms: 0, type: "run.started", runId: "q2", label: "t", carrierIds: [carrierId] },
    { seq: 2, t: "", ms: 1, type: "carrier.closed", carrierId, status, reason, closedBy: status === "failed" ? "code" : "model" },
    { seq: 3, t: "", ms: 2, type: "run.finished", status: "completed" },
  ] as RunEvent[];

test("view: plugin caveats are shown with the status (Redpack no_coverage; UPS only for the download reason)", async () => {
  const { DOWNLOAD_REASON } = await import("../browser/blocking.js");
  const redpack = buildQuoteView(caveatEvents("no_coverage", "redpack", "SIN COBERTURA")).carriers[0];
  assert.match(redpack.caveat ?? "", /colonia/);
  assert.match(redpack.message, /no da servicio en esa ruta\. Ojo: no pudimos elegir la colonia/);
  const upsDownload = buildQuoteView(caveatEvents("failed", "ups", DOWNLOAD_REASON)).carriers[0];
  assert.match(upsDownload.message, /en un navegador normal sí cargó \(verificado el 16 nov\)/);
  assert.equal(upsDownload.detail, "probable bloqueo: responde con una descarga al navegador automatizado");
  const upsOther = buildQuoteView(caveatEvents("failed", "ups", "could not open start page: net::ERR_NAME_NOT_RESOLVED")).carriers[0];
  assert.equal(upsOther.caveat, undefined);
});

test("result note always carries the caveat, even when the model's note leaves it out", async () => {
  const events = caveatEvents("no_coverage", "redpack", "SIN COBERTURA");
  const { client } = fakeClient([{ content: [{ type: "text", text: "Redpack no cubre esa ruta.", citations: null }] as Anthropic.ContentBlock[] }]);
  const orch: Orchestrator = {
    async startQuote() { return "q2"; },
    subscribe(_id, onEvent) { events.forEach(onEvent); return () => {}; },
    async finished() { return (await import("../record/state.js")).fold(events); },
  };
  const conv = new Conversation(orch, { client, plugins, now: () => NOW, recordDir: null });
  const r = await conv.describeResult("q2");
  assert.equal(r.noteSource, "model");
  assert.match(r.note, /^Redpack no cubre esa ruta\. Ojo: no pudimos elegir la colonia/);
});

// ---- what the site said reaches the user and the note is never cut ----

const SITE_MSG = "Error: No podemos encontrar este código postal. Revisa si es correcto e inténtalo de nuevo.";
// Case 9: FedEx rejects origin 99999 with its own message; Estafeta fails; DHL is
// blocked; Redpack and UPS wait for data the chat already asked for.
const case9Events = [
  { type: "run.started", runId: "q9", label: "t", carrierIds: ["estafeta", "dhl", "fedex", "redpack", "ups"] },
  { type: "request.validated", request: { originZip: "99999", destZip: "06000", parcels: [{ weightKg: 2, lengthCm: 30, widthCm: 20, heightCm: 15 }] } },
  { type: "carrier.skipped", carrierId: "redpack", missing: [{ field: "deliveryType", why: "home or branch" }] },
  { type: "carrier.skipped", carrierId: "ups", missing: [{ field: "shipDate", why: "ship date" }] },
  { type: "carrier.started", carrierId: "fedex", startUrl: "u", budget: { maxSteps: 20, maxSeconds: 180 }, traceFile: "t" },
  { type: "evidence.captured", carrierId: "fedex", evidenceId: "ev1", reason: "zip error", url: "u", text: `Código postal de origen\n99999\n${SITE_MSG}`, capturedAt: "", images: [] },
  { type: "carrier.closed", carrierId: "fedex", status: "needs_human", reason: "origin postal code not found", evidenceId: "ev1", closedBy: "model", siteMessage: SITE_MSG, rejectedZip: "origin" },
  { type: "carrier.closed", carrierId: "estafeta", status: "failed", reason: "site error", closedBy: "model" },
  { type: "carrier.closed", carrierId: "dhl", status: "blocked", reason: "HTTP 403", closedBy: "code" },
  { type: "run.finished", status: "completed" },
].map((e, i) => ({ seq: i + 1, t: "", ms: i, ...e })) as RunEvent[];

const ZIP_SENTENCE = `FedEx México no reconoce el código postal de origen 99999. Su página dice: "${SITE_MSG}".`;

function eventsOrchestrator(events: RunEvent[]): Orchestrator {
  return {
    async startQuote() { return "q9"; },
    subscribe(_id, onEvent) { events.forEach(onEvent); return () => {}; },
    async finished() { return (await import("../record/state.js")).fold(events); },
  };
}

test("case 9 view names 99999, quotes the site and asks to check it; the rejecting site does not 'confirm' the code", () => {
  const view = buildQuoteView(case9Events);
  const fedex = view.carriers.find((c) => c.carrierId === "fedex")!;
  assert.equal(fedex.label, "Necesita un dato");
  assert.equal(fedex.message, `${ZIP_SENTENCE} Revisa el código postal.`);
  assert.deepEqual(view.zips[0], { zip: "99999", role: "origin", seen: [], rejectedBy: [{ carrierId: "fedex", siteMessage: SITE_MSG }] });
  assert.deepEqual(view.zips[1].rejectedBy, []);
});

test("case 9 fallback starts with the rejected code and the question, names FedEx once, no Redpack/UPS requests", () => {
  const view = buildQuoteView(case9Events);
  const note = fallbackNote(view);
  assert.ok(note.startsWith(`${ZIP_SENTENCE} ¿Me confirmas el código postal de origen?`), note);
  assert.equal(note.match(/FedEx/g)?.length, 1);
  assert.doesNotMatch(note, /Redpack|UPS|Para cotizar con/);
  assert.match(note, /No conseguimos ningún precio/);
  assert.match(note, /Estafeta/);
  assert.match(note, /DHL México/);
  assert.doesNotMatch(note, /Ningún sitio confirmó/, "06000: nothing says it is wrong, and there are no prices");
  const digest = resultDigest(view);
  assert.match(digest, new RegExp(`Postal code 99999 \\(origin\\) was REJECTED by FedEx México: "${SITE_MSG.replace(/[.]/g, "\\.")}"\\. Ask the user to confirm it\\.`));
  assert.doesNotMatch(digest, /06000 \(destination\) was NOT confirmed/);
  // Carriers waiting for data are not in the digest at all (the model cannot misreport what it does not get).
  assert.doesNotMatch(digest, /Redpack|UPS|not launched/);
});

test("everything blocked and no rejection: no postal code warning in the note or the digest", () => {
  const events = [
    { type: "run.started", runId: "qb", label: "t", carrierIds: ["estafeta", "dhl"] },
    { type: "request.validated", request: { originZip: "64000", destZip: "22000", parcels: [{ weightKg: 2, lengthCm: 30, widthCm: 20, heightCm: 15 }] } },
    { type: "carrier.closed", carrierId: "estafeta", status: "blocked", reason: "captcha", closedBy: "model" },
    { type: "carrier.closed", carrierId: "dhl", status: "blocked", reason: "HTTP 403", closedBy: "code" },
    { type: "run.finished", status: "completed" },
  ].map((e, i) => ({ seq: i + 1, t: "", ms: i, ...e })) as RunEvent[];
  const view = buildQuoteView(events);
  assert.doesNotMatch(fallbackNote(view), /código postal/);
  assert.doesNotMatch(resultDigest(view), /Postal code/);
});

test("budget_exhausted says which limit stopped the carrier; chip 'Sin terminar'; any other status adds the site's words", () => {
  const closed = (reason: string, status = "budget_exhausted", extra: Record<string, unknown> = {}) =>
    buildQuoteView([
      { seq: 1, t: "", ms: 0, type: "run.started", runId: "x", label: "t", carrierIds: ["fedex"] },
      { seq: 2, t: "", ms: 1, type: "carrier.closed", carrierId: "fedex", status, reason, closedBy: "code", ...extra },
    ] as RunEvent[]).carriers[0];
  const steps = closed("step cap reached (20 model turns)");
  assert.equal(steps.label, "Sin terminar");
  assert.equal(steps.message, "FedEx México llegó al máximo de intentos que le damos a cada paquetería sin terminar. No tenemos precio de FedEx México.");
  const tooLong = "FedEx México tardó demasiado y dejamos de intentar. No tenemos precio de FedEx México.";
  assert.equal(closed("time cap reached (180s)").message, tooLong);
  assert.equal(closed("global cap: quote time cap reached (600s)").message, tooLong);
  assert.equal(closed("harness time cap (10 min)").message, tooLong);
  const cost = "FedEx México llegó al límite de gasto por paquetería sin terminar. No tenemos precio de FedEx México.";
  assert.equal(closed("cost cap reached ($1.020 > $1)").message, cost);
  assert.equal(closed("global cap: quote cost cap reached ($3.100 > $3)").message, cost);
  assert.equal(closed("stuck: repeated the same action on the same page 3 times").message, "FedEx México se atoró repitiendo la misma acción. No tenemos precio de FedEx México.");
  assert.equal(
    closed("SIN COBERTURA", "no_coverage", { siteMessage: "SIN COBERTURA", evidenceId: "ev1" }).message,
    'FedEx México dice que no da servicio en esa ruta. Su página dice: "SIN COBERTURA".',
  );
});

test("guards complete the model's note: the rejected code with the question, and every launched carrier without a price", async () => {
  const { client } = fakeClient([{ content: [{ type: "text", text: "Estafeta falló.", citations: null }] as Anthropic.ContentBlock[] }]);
  const conv = new Conversation(eventsOrchestrator(case9Events), { client, plugins, now: () => NOW, recordDir: null });
  const r = await conv.describeResult("q9");
  assert.equal(r.noteSource, "model");
  assert.ok(r.note.startsWith(`Estafeta falló. ${ZIP_SENTENCE} ¿Me confirmas el código postal de origen?`), r.note);
  assert.match(r.note, /DHL México/);
  assert.equal(r.note.match(/FedEx/g)?.length, 1, "the rejection sentence already names FedEx");
  assert.doesNotMatch(r.note, /Redpack|UPS/);
  // A note that already mentions the code and every carrier is left as the model wrote it.
  const full = "FedEx no encontró el código postal 99999; ¿lo revisas? Estafeta falló y DHL bloqueó la consulta.";
  const { client: c2 } = fakeClient([{ content: [{ type: "text", text: full, citations: null }] as Anthropic.ContentBlock[] }]);
  const r2 = await new Conversation(eventsOrchestrator(case9Events), { client: c2, plugins, now: () => NOW, recordDir: null }).describeResult("q9");
  assert.equal(r2.note, full);
});

test("a note cut by max_tokens is never shown; the turn records stopReason, output tokens and thinking blocks", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { readEvents } = await import("../record/store.js");
  const { client, calls } = fakeClient([{
    stop_reason: "max_tokens",
    usage: { input_tokens: 700, output_tokens: 1024 } as Anthropic.Usage,
    content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "FedEx México no d", citations: null }] as Anthropic.ContentBlock[],
  }]);
  const conv = new Conversation(eventsOrchestrator(case9Events), { client, plugins, now: () => NOW, recordDir: fs.mkdtempSync(path.join(os.tmpdir(), "qb-note-")) });
  const r = await conv.describeResult("q9");
  assert.equal(r.noteSource, "fallback:max_tokens");
  assert.equal(r.note, fallbackNote(buildQuoteView(case9Events)));
  assert.doesNotMatch(r.note, /no d$/);
  const req = calls[0] as Record<string, unknown>;
  assert.equal(req.max_tokens, 1024);
  assert.deepEqual(req.output_config, { effort: "low" });
  assert.equal("thinking" in req, false, "thinking left unset: effort is the control");
  const turn = readEvents(conv.recordFile!).find((e) => e.type === "conversation.turn" && e.text.startsWith("[result note]"));
  assert.ok(turn && turn.type === "conversation.turn");
  assert.equal(turn.stopReason, "max_tokens");
  assert.equal(turn.outputTokens, 1024);
  assert.equal(turn.thinkingBlocks, 1);
});

test("any stop_reason other than end_turn falls back with its name; thinking blocks never reach the note", async () => {
  const { client } = fakeClient([{ stop_reason: "refusal", content: [{ type: "text", text: "No.", citations: null }] as Anthropic.ContentBlock[] }]);
  const r = await new Conversation(eventsOrchestrator(case9Events), { client, plugins, now: () => NOW, recordDir: null }).describeResult("q9");
  assert.equal(r.noteSource, "fallback:refusal");
  const text = "FedEx no reconoce el código postal 99999. Estafeta y DHL no dieron precio.";
  const { client: c2 } = fakeClient([{ content: [{ type: "thinking", thinking: "razonando en secreto", signature: "s" }, { type: "text", text, citations: null }] as Anthropic.ContentBlock[] }]);
  const r2 = await new Conversation(eventsOrchestrator(case9Events), { client: c2, plugins, now: () => NOW, recordDir: null }).describeResult("q9");
  assert.equal(r2.noteSource, "model");
  assert.equal(r2.note, text);
});
