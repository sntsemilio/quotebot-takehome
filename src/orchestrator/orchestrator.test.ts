// Orchestrator, ranking and view tests. No network, no browser, no model: runCarrier is a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOrchestrator, type RunCarrierFn } from "./index.js";
import { rankQuotes, parseDelivery } from "./ranking.js";
import { buildQuoteView, zipMentions } from "./view.js";
import type { CarrierPlugin } from "../carriers/types.js";
import type { RunEvent } from "../record/events.js";
import { fold, type RunState } from "../record/state.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qb-orch-"));
const plugin = (id: string, extra: Partial<CarrierPlugin> = {}): CarrierPlugin => ({
  id, name: id.toUpperCase(), startUrl: "https://example.invalid", allowedDomains: ["example.invalid"], notes: "", budget: { maxSteps: 5, maxSeconds: 30 }, ...extra,
});
const request = { originZip: "64000", destZip: "22000", parcels: [{ weightKg: 10, lengthCm: 40, widthCm: 30, heightCm: 30 }] };

// Fake carrier: one evidence, one verified price, closes quoted.
function quotingCarrier(amount: number, service = "Terrestre", deliveryDays: string | null = null): RunCarrierFn {
  return async ({ plugin: p, store }) => {
    store.append("carrier.started", { carrierId: p.id, startUrl: p.startUrl, budget: p.budget, traceFile: "t.zip" });
    store.append("evidence.captured", { carrierId: p.id, evidenceId: `${p.id}-ev1`, reason: "r", url: "u", text: `CP 64000\nMONTERREY, NUEVO LEON\n$${amount}`, capturedAt: "", images: [{ index: 0, file: `runs/x/${p.id}.png`, frame: "main", scrollY: 0 }] });
    store.append("price.verified", { carrierId: p.id, service, amount, currency: "MXN", includesVAT: null, deliveryDays, priceText: `$${amount}`, evidenceId: `${p.id}-ev1` });
    store.append("carrier.closed", { carrierId: p.id, status: "quoted", reason: "ok", closedBy: "model" });
  };
}

test("skips carriers whose needs are missing, runs the rest in parallel, finishes when all closed", async () => {
  const called: string[] = [];
  const fake: RunCarrierFn = async (o) => { called.push(o.plugin.id); await quotingCarrier(100)(o); };
  const orch = createOrchestrator({
    runsRoot: tmp(), runCarrier: fake,
    carriers: { a: plugin("a"), ups: plugin("ups", { needs: [{ field: "shipDate", why: "quotes for a pickup date" }] }) },
  });
  const runId = await orch.startQuote(request, ["a", "ups"]);
  const s = await orch.finished(runId);
  assert.deepEqual(called, ["a"]);
  assert.equal(s.carriers.a.status, "quoted");
  assert.equal(s.carriers.ups.status, "needs_human");
  assert.equal(s.carriers.ups.skipped?.missing[0].field, "shipDate");
  assert.equal(s.finished?.status, "completed");
});

test("invalid request or unknown carrier: request.invalid, no carrier runs", async () => {
  let calls = 0;
  const orch = createOrchestrator({ runsRoot: tmp(), runCarrier: async () => { calls++; }, carriers: { a: plugin("a") } });
  const runId = await orch.startQuote({ ...request, originZip: "640" }, ["a", "nope"]);
  const s = await orch.finished(runId);
  assert.equal(calls, 0);
  assert.equal(s.finished?.status, "error");
  assert.ok(s.requestErrors?.some((e) => e.includes("originZip")));
  assert.ok(s.requestErrors?.some((e) => e.includes("unknown carrier 'nope'")));
});

test("total.computed follows each price.verified for identical parcels (cents, with formula)", async () => {
  const orch = createOrchestrator({ runsRoot: tmp(), runCarrier: quotingCarrier(778.87), carriers: { a: plugin("a") } });
  const runId = await orch.startQuote({ ...request, count: 4 }, ["a"]);
  await orch.finished(runId);
  const events: RunEvent[] = [];
  orch.subscribe(runId, (e) => events.push(e))();
  const types = events.map((e) => e.type);
  const iv = types.indexOf("price.verified");
  assert.equal(types[iv + 1], "total.computed");
  const total = events.find((e) => e.type === "total.computed");
  assert.ok(total && total.type === "total.computed");
  assert.equal(total.total, 3115.48);
  assert.equal(total.formula, "4 x 778.87 MXN = 3115.48 MXN");
  assert.equal(fold(events).carriers.a.prices[0].total?.total, 3115.48);
});

test("global time cap aborts runCarrier through its signal -> cap_time", async () => {
  const slow: RunCarrierFn = async ({ plugin: p, store, signal }) => {
    store.append("carrier.started", { carrierId: p.id, startUrl: p.startUrl, budget: p.budget, traceFile: "t" });
    await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve()));
    store.append("carrier.closed", { carrierId: p.id, status: "budget_exhausted", reason: `global cap: ${(signal!.reason as Error).message}`, closedBy: "code" });
  };
  const orch = createOrchestrator({ runsRoot: tmp(), runCarrier: slow, maxSeconds: 0.05, carriers: { a: plugin("a") } });
  const s = await orch.finished(await orch.startQuote(request, ["a"]));
  assert.equal(s.finished?.status, "cap_time");
  assert.equal(s.carriers.a.status, "budget_exhausted");
  assert.match(s.carriers.a.reason ?? "", /quote time cap/);
});

test("global cost cap (sum over carriers) aborts -> cap_cost", async () => {
  const spender: RunCarrierFn = async ({ plugin: p, store, signal }) => {
    store.append("carrier.started", { carrierId: p.id, startUrl: p.startUrl, budget: p.budget, traceFile: "t" });
    store.append("model.response", { carrierId: p.id, step: 1, model: "claude-opus-5-5", stopReason: "tool_use", usage: {}, costUsd: 0.6, text: "" });
    await new Promise((r) => setTimeout(r, 10));
    store.append("carrier.closed", { carrierId: p.id, status: signal!.aborted ? "budget_exhausted" : "failed", reason: "x", closedBy: "code" });
  };
  const orch = createOrchestrator({ runsRoot: tmp(), runCarrier: spender, maxUsd: 1, carriers: { a: plugin("a"), b: plugin("b") } });
  const s = await orch.finished(await orch.startQuote(request, ["a", "b"]));
  assert.equal(s.finished?.status, "cap_cost");
  assert.equal(s.carriers.a.status, "budget_exhausted");
});

test("a crashing runCarrier is closed as failed so the quote still finishes", async () => {
  const orch = createOrchestrator({ runsRoot: tmp(), runCarrier: async () => { throw new Error("boom"); }, carriers: { a: plugin("a") } });
  const s = await orch.finished(await orch.startQuote(request, ["a"]));
  assert.equal(s.carriers.a.status, "failed");
  assert.match(s.carriers.a.reason ?? "", /boom/);
});

test("replay re-emits a recorded run into a new record, in order, without calling runCarrier", async () => {
  const dir = tmp();
  const src = path.join(dir, "source.jsonl");
  const legacy = [
    { seq: 1, t: "", ms: 0, type: "run.started", runId: "old", label: "after", carrierId: "estafeta" },
    { seq: 2, t: "", ms: 5, type: "request.validated", request },
    { seq: 3, t: "", ms: 10, type: "carrier.started", carrierId: "estafeta", startUrl: "u", budget: { maxSteps: 15, maxSeconds: 150 }, traceFile: "t" },
    { seq: 4, t: "", ms: 200, type: "evidence.captured", carrierId: "estafeta", evidenceId: "ev1", reason: "r", screenshot: "runs/after/old/evidence/estafeta-ev1.png", url: "u", text: "CP 64000\nMONTERREY, NUEVO LEON\nCP 22000\nTIJUANA, BAJA CALIFORNIA\n778.87", capturedAt: "" },
    { seq: 5, t: "", ms: 300, type: "price.verified", carrierId: "estafeta", service: "Terrestre", amount: 778.87, currency: "MXN", includesVAT: true, deliveryDays: null, priceText: "778.87", evidenceId: "ev1" },
    { seq: 6, t: "", ms: 400, type: "carrier.closed", carrierId: "estafeta", status: "quoted", reason: "ok", evidenceId: "ev1", closedBy: "model" },
    { seq: 7, t: "", ms: 410, type: "run.finished", status: "completed" },
  ];
  fs.writeFileSync(src, legacy.map((e) => JSON.stringify(e)).join("\n") + "\n");
  let calls = 0;
  const orch = createOrchestrator({ runsRoot: dir, replayFile: src, replaySpeed: 100, runCarrier: async () => { calls++; } });
  const runId = await orch.startQuote({}, ["ignored-in-replay"]);
  const live: string[] = [];
  orch.subscribe(runId, (e) => live.push(e.type)); // joins early: gets recorded + live without duplicates
  const s = await orch.finished(runId);
  assert.equal(calls, 0);
  assert.match(runId, /^replay-/);
  assert.deepEqual(live, ["run.started", "request.validated", "carrier.started", "evidence.captured", "price.verified", "carrier.closed", "run.finished"]);
  assert.deepEqual(s.carrierIds, ["estafeta"]);
  assert.equal(s.carriers.estafeta.prices[0].image, "runs/after/old/evidence/estafeta-ev1.png");
  const view = buildQuoteView(fs.readFileSync(path.join(dir, "app", `${runId}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
  assert.equal(view.zips[0].seen[0].text, "CP 64000 MONTERREY, NUEVO LEON");
  assert.equal(view.zips[1].seen[0].text, "CP 22000 TIJUANA, BAJA CALIFORNIA");

  // A valid user request replaces the recorded one: count 4 -> totals computed on the recorded prices.
  const run2 = await orch.startQuote({ ...request, count: 4, preference: { priority: "fastest" } }, []);
  const s2 = await orch.finished(run2);
  assert.equal(s2.request?.count, 4);
  assert.equal(s2.carriers.estafeta.prices[0].total?.formula, "4 x 778.87 MXN = 3115.48 MXN");
  const types: string[] = [];
  orch.subscribe(run2, (e) => types.push(e.type))();
  assert.equal(types.filter((t) => t === "request.validated").length, 1);
});

// ---- ranking ------------------------------------------------------------

function stateWith(prices: { c: string; service: string; amount: number; deliveryDays?: string | null; total?: number }[], extra: Partial<RunState> = {}): RunState {
  const s: RunState = { carriers: {}, carrierIds: [], evidence: {}, ...extra };
  for (const p of prices) {
    s.carriers[p.c] ??= { status: "quoted", prices: [], rejectedPrices: 0, steps: 0, toolCalls: 0, failedToolCalls: 0, blockedNavigations: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, maxInputPerStep: 0, costUsd: 0, startedMs: 0 };
    s.carriers[p.c].prices.push({
      service: p.service, amount: p.amount, currency: "MXN", includesVAT: null, deliveryDays: p.deliveryDays ?? null, priceText: String(p.amount), evidenceId: "e",
      siteNotes: [], optionalCharges: [], ...(p.total ? { total: { count: 2, total: p.total, formula: "" } } : {}),
    });
  }
  return s;
}

test("parseDelivery reads only what the site wrote", () => {
  assert.deepEqual(parseDelivery({ deliveryDays: "2-5 días hábiles", service: "x" }), { minDays: 2, maxDays: 5, source: "site_delivery_days" });
  assert.deepEqual(parseDelivery({ deliveryDays: null, service: "Dia Sig." }), { minDays: 1, maxDays: 1, source: "service_name" });
  assert.deepEqual(parseDelivery({ deliveryDays: null, service: "2 Dias" }), { minDays: 2, maxDays: 2, source: "service_name" });
  assert.equal(parseDelivery({ deliveryDays: null, service: "12:30" }), null);
  assert.equal(parseDelivery({ deliveryDays: null, service: "Terrestre" }), null);
});

test("rankQuotes: cheapest compares totals for identical parcels; fastest puts unknown delivery last; by_date puts on-time first", () => {
  const s = stateWith([
    { c: "estafeta", service: "Dia Sig.", amount: 2243.28 },
    { c: "estafeta", service: "Terrestre", amount: 778.87 },
    { c: "fedex", service: "Economy", amount: 700, deliveryDays: "3-5", total: 1400 },
    { c: "dhl", service: "Express", amount: 900, deliveryDays: "1", total: 1800 },
  ], { request: { ...request, count: 2 } });
  const cheap = rankQuotes(s, { priority: "cheapest" });
  // Count 2 -> totals everywhere; the two without total.computed get 2 x amount (1557.74, 4486.56), never their unit price.
  assert.deepEqual(cheap.map((r) => [r.price.service, r.comparable]), [["Economy", 1400], ["Terrestre", 1557.74], ["Express", 1800], ["Dia Sig.", 4486.56]]);
  const fast = rankQuotes(s, { priority: "fastest" });
  assert.deepEqual(fast.map((r) => r.price.service), ["Express", "Dia Sig.", "Economy", "Terrestre"]);
  const now = new Date("2026-11-18T03:30:00Z"); // 2026-11-17 in Monterrey
  const byDate = rankQuotes(s, { priority: "by_date", deadline: "2026-11-18" }, now);
  assert.deepEqual(byDate.map((r) => [r.price.service, r.meetsDeadline]), [
    ["Express", true], ["Dia Sig.", true], ["Terrestre", null], ["Economy", false],
  ]);
  assert.deepEqual(rankQuotes(stateWith([])), []);
});

test("view explains skipped carriers in plain Spanish and flags unconfirmed postal codes", () => {
  const events = [
    { seq: 1, t: "", ms: 0, type: "run.started", runId: "r", label: "t", carrierIds: ["ups", "estafeta"] },
    { seq: 2, t: "", ms: 1, type: "request.validated", request: { ...request, originZip: "99999" } },
    { seq: 3, t: "", ms: 2, type: "carrier.skipped", carrierId: "ups", missing: [{ field: "shipDate", why: "quotes for a pickup date" }] },
    { seq: 4, t: "", ms: 3, type: "evidence.captured", carrierId: "estafeta", evidenceId: "ev1", reason: "r", url: "u", text: "Origen:\nCP 22000\nTIJUANA", capturedAt: "", images: [] },
    { seq: 5, t: "", ms: 4, type: "carrier.closed", carrierId: "estafeta", status: "failed", reason: "site error", closedBy: "model" },
  ] as RunEvent[];
  const v = buildQuoteView(events);
  const ups = v.carriers.find((c) => c.carrierId === "ups")!;
  assert.equal(ups.status, "needs_human");
  assert.match(ups.message, /fecha de envío/);
  assert.equal(v.carriers.find((c) => c.carrierId === "estafeta")!.label, "Falló");
  assert.equal(v.zips[0].seen.length, 0); // 99999 not confirmed by any site
  // Estafeta failed, so its page does not confirm 22000; the same page on a carrier that quoted does.
  assert.deepEqual(zipMentions(events, "22000"), []);
  const quoted = events.map((e) => (e.type === "carrier.closed" ? { ...e, status: "quoted" as const } : e));
  assert.deepEqual(zipMentions(quoted, "22000"), [{ carrierId: "estafeta", text: "CP 22000 TIJUANA" }]);
});

// ---- safe by default: live mode must be explicit ----

async function withLaunchSpy<T>(fn: () => Promise<T>): Promise<{ result: T | Error; launches: number }> {
  const { chromium } = await import("playwright");
  const original = chromium.launch;
  let launches = 0;
  (chromium as { launch: unknown }).launch = async () => {
    launches++;
    throw new Error("test: browser launch blocked");
  };
  try {
    return { result: await fn().catch((e: Error) => e), launches };
  } finally {
    (chromium as { launch: unknown }).launch = original;
  }
}

test("createOrchestrator() without configuration refuses to run live and never opens a browser", async () => {
  const before = fs.existsSync("runs") ? fs.readdirSync("runs", { recursive: true }).length : 0;
  const { result, launches } = await withLaunchSpy(() => createOrchestrator().startQuote(request, ["estafeta"]));
  assert.ok(result instanceof Error && /refusing to run live/.test(result.message), String(result));
  assert.equal(launches, 0);
  const after = fs.existsSync("runs") ? fs.readdirSync("runs", { recursive: true }).length : 0;
  assert.equal(after, before, "no record is written");
});

test("live must be consistent: REPLAY_RUN in the environment or a replayFile with mode live are refused", async () => {
  const prev = process.env.REPLAY_RUN;
  process.env.REPLAY_RUN = "runs/after/some.jsonl";
  try {
    const { result, launches } = await withLaunchSpy(() => createOrchestrator({ mode: "live", runsRoot: tmp() }).startQuote(request, ["estafeta"]));
    assert.ok(result instanceof Error && /REPLAY_RUN is set/.test(result.message), String(result));
    assert.equal(launches, 0);
  } finally {
    if (prev === undefined) delete process.env.REPLAY_RUN;
    else process.env.REPLAY_RUN = prev;
  }
  await assert.rejects(createOrchestrator({ mode: "live", replayFile: "x.jsonl" }).startQuote(request, ["a"]), /conflicting configuration/);
  await assert.rejects(createOrchestrator({ mode: "replay" }).startQuote(request, ["a"]), /needs replayFile/);
});

test("configFromEnv states the mode: replay with REPLAY_RUN, live without it", async () => {
  const { configFromEnv } = await import("./index.js");
  assert.equal(configFromEnv({ REPLAY_RUN: "r.jsonl" }).mode, "replay");
  assert.equal(configFromEnv({}).mode, "live");
});
