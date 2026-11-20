// Contract tests for src/record (no network, no browser). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunStore, readEvents } from "./store.js";
import { fold } from "./state.js";
import type { RunEvent } from "./events.js";

function tmpStore() {
  return new RunStore(fs.mkdtempSync(path.join(os.tmpdir(), "qb-record-")), "r1");
}

test("subscribe receives each event after it is on disk; unsubscribe stops it; a throwing listener does not break recording", () => {
  const store = tmpStore();
  const seen: string[] = [];
  const onDiskAtNotify: number[] = [];
  const off = store.subscribe((e) => {
    seen.push(e.type);
    onDiskAtNotify.push(readEvents(store.file).length);
  });
  store.subscribe(() => {
    throw new Error("listener bug");
  });
  store.append("run.started", { runId: "r1", label: "t", carrierIds: ["estafeta"] });
  store.append("request.invalid", { errors: ["x"] });
  off();
  store.append("run.finished", { status: "error" });
  assert.deepEqual(seen, ["run.started", "request.invalid"]);
  assert.deepEqual(onDiskAtNotify, [1, 2]);
  assert.equal(store.events().length, 3);
});

test("carrier.skipped is terminal needs_human with the missing data; a later close does not reopen it", () => {
  const store = tmpStore();
  store.append("run.started", { runId: "r1", label: "t", carrierIds: ["ups", "estafeta"] });
  store.append("carrier.skipped", { carrierId: "ups", missing: [{ field: "shipDate", why: "the site quotes for a pickup date" }] });
  store.append("carrier.closed", { carrierId: "ups", status: "failed", reason: "should be ignored", closedBy: "code" });
  const s = fold(store.events());
  assert.deepEqual(s.carrierIds, ["ups", "estafeta"]);
  assert.equal(s.carriers.ups.status, "needs_human");
  assert.equal(s.carriers.ups.skipped?.missing[0].field, "shipDate");
  assert.match(s.carriers.ups.reason ?? "", /shipDate/);
});

test("multi-image evidence, notes and charges, and total.computed fold onto the verified price", () => {
  const store = tmpStore();
  const c = "estafeta";
  store.append("run.started", { runId: "r1", label: "t", carrierIds: [c] });
  store.append("carrier.started", { carrierId: c, startUrl: "u", budget: { maxSteps: 15, maxSeconds: 150 }, traceFile: "t.zip" });
  store.append("evidence.captured", {
    carrierId: c, evidenceId: "ev1", reason: "results", url: "u", text: "...", capturedAt: "now",
    images: [
      { index: 0, file: "runs/t/r1/evidence/estafeta-ev1-0.png", frame: "main", scrollY: 0 },
      { index: 1, file: "runs/t/r1/evidence/estafeta-ev1-1.png", frame: "main", scrollY: 900 },
    ],
  });
  const priceSeq = store.append("price.verified", {
    carrierId: c, service: "Terrestre", amount: 450, currency: "MXN", includesVAT: true, deliveryDays: "2-5", priceText: "$450.00", evidenceId: "ev1",
    siteNotes: ["Los precios incluyen I.V.A."], optionalCharges: [{ name: "Manejo Especial", amountText: "$348.00", amount: 348 }], imageIndex: 1,
  });
  store.append("total.computed", { carrierId: c, service: "Terrestre", count: 3, unitAmount: 450, total: 1350, currency: "MXN", formula: "3 x 450.00 MXN = 1350.00 MXN", evidenceId: "ev1", priceSeq });
  store.append("carrier.closed", { carrierId: c, status: "quoted", reason: "ok", closedBy: "model" });
  const p = fold(store.events()).carriers[c].prices[0];
  assert.equal(p.image, "runs/t/r1/evidence/estafeta-ev1-1.png");
  assert.deepEqual(p.siteNotes, ["Los precios incluyen I.V.A."]);
  assert.equal(p.optionalCharges[0].amount, 348);
  assert.deepEqual(p.total, { count: 3, total: 1350, formula: "3 x 450.00 MXN = 1350.00 MXN" });
});

test("step-1 records still fold (legacy run.started.carrierId and evidence screenshot)", () => {
  const legacy = [
    { seq: 1, t: "", ms: 0, type: "run.started", runId: "old", label: "after", carrierId: "estafeta", requestFile: "cases/requests/case7.json" },
    { seq: 2, t: "", ms: 1, type: "carrier.started", carrierId: "estafeta", startUrl: "u", budget: { maxSteps: 15, maxSeconds: 150 }, traceFile: "t" },
    { seq: 3, t: "", ms: 2, type: "evidence.captured", carrierId: "estafeta", evidenceId: "ev1", reason: "r", screenshot: "runs/after/old/evidence/estafeta-ev1.png", url: "u", text: "$1.00", capturedAt: "" },
    { seq: 4, t: "", ms: 3, type: "price.verified", carrierId: "estafeta", service: "S", amount: 1, currency: "MXN", includesVAT: null, deliveryDays: null, priceText: "$1.00", evidenceId: "ev1" },
    { seq: 5, t: "", ms: 4, type: "carrier.closed", carrierId: "estafeta", status: "quoted", reason: "ok", closedBy: "model" },
  ] as RunEvent[];
  const s = fold(legacy);
  assert.deepEqual(s.carrierIds, ["estafeta"]);
  assert.equal(s.carriers.estafeta.status, "quoted");
  assert.equal(s.carriers.estafeta.prices[0].image, "runs/after/old/evidence/estafeta-ev1.png");
  assert.deepEqual(s.carriers.estafeta.prices[0].siteNotes, []);
});

test("replayOf and per-image text fold/round-trip; conversation.turn is a valid event that the quote fold ignores", () => {
  const store = tmpStore();
  store.append("run.started", { runId: "r1", label: "t", carrierIds: ["estafeta"], replayOf: "runs/after/x.jsonl" });
  store.append("evidence.captured", {
    carrierId: "estafeta", evidenceId: "ev1", reason: "r", url: "u", text: "a $1.00", capturedAt: "",
    images: [{ index: 0, file: "f0.png", frame: "main", scrollY: 0, text: "a" }, { index: 1, file: "f1.png", frame: "main", scrollY: 900, text: "$1.00" }],
  });
  store.append("conversation.turn", { conversationId: "c1", role: "user", text: "hola" });
  const s = fold(store.events());
  assert.equal(s.replayOf, "runs/after/x.jsonl");
  assert.equal(s.evidence.ev1.images[1].text, "$1.00");
  assert.deepEqual(Object.keys(s.carriers), []);
});

// ---- record contract: tool errors and site messages ----

test("carrier.closed siteMessage/rejectedZip fold onto the carrier; the first close still wins", () => {
  const store = tmpStore();
  store.append("run.started", { runId: "r1", label: "t", carrierIds: ["fedex"] });
  store.append("carrier.started", { carrierId: "fedex", startUrl: "u", budget: { maxSteps: 20, maxSeconds: 180 }, traceFile: "t.zip" });
  store.append("carrier.closed", {
    carrierId: "fedex", status: "needs_human", reason: "origin postal code not found", evidenceId: "ev1", closedBy: "model",
    siteMessage: "Error: No podemos encontrar este código postal.", rejectedZip: "origin",
  });
  store.append("carrier.closed", { carrierId: "fedex", status: "failed", reason: "late", closedBy: "code", siteMessage: "otra cosa", rejectedZip: "destination" });
  const x = fold(store.events()).carriers.fedex;
  assert.equal(x.status, "needs_human");
  assert.equal(x.siteMessage, "Error: No podemos encontrar este código postal.");
  assert.equal(x.rejectedZip, "origin");
  assert.equal(x.evidenceId, "ev1");
});

test("carrier.notice changes no state; step.failed counts the same with shownToModel true or false", () => {
  const store = tmpStore();
  store.append("run.started", { runId: "r1", label: "t", carrierIds: ["estafeta"] });
  store.append("carrier.started", { carrierId: "estafeta", startUrl: "u", budget: { maxSteps: 4, maxSeconds: 60 }, traceFile: "t.zip" });
  store.append("step.failed", { carrierId: "estafeta", step: 0, tool: "wait_ready", args: { text: "Desde" }, error: "not visible", shownToModel: false });
  store.append("step.failed", { carrierId: "estafeta", step: 2, tool: "click", args: {}, error: "not found", shownToModel: true });
  const before = structuredClone(fold(store.events()).carriers.estafeta);
  store.append("carrier.notice", { carrierId: "estafeta", step: 2, text: "2 turns left." });
  const after = fold(store.events()).carriers.estafeta;
  assert.deepEqual(after, before);
  assert.equal(after.failedToolCalls, 2);
  assert.equal(after.toolCalls, 2);
});

test("an older record (no shownToModel, no siteMessage) still folds", () => {
  const old = [
    { seq: 1, t: "", ms: 0, type: "run.started", runId: "old", label: "after-2t", carrierIds: ["fedex"] },
    { seq: 2, t: "", ms: 1, type: "carrier.started", carrierId: "fedex", startUrl: "u", budget: { maxSteps: 20, maxSeconds: 180 }, traceFile: "t" },
    { seq: 3, t: "", ms: 2, type: "step.failed", carrierId: "fedex", step: 3, tool: "wait_for", args: { text: "Desde" }, error: "did not appear" },
    { seq: 4, t: "", ms: 3, type: "carrier.closed", carrierId: "fedex", status: "no_coverage", reason: "No podemos encontrar este código postal", closedBy: "model" },
    { seq: 5, t: "", ms: 4, type: "conversation.turn", conversationId: "c", role: "assistant", text: "nota" },
  ] as RunEvent[];
  const x = fold(old).carriers.fedex;
  assert.equal(x.status, "no_coverage");
  assert.equal(x.failedToolCalls, 1);
  assert.equal(x.siteMessage, undefined);
  assert.equal(x.rejectedZip, undefined);
});
