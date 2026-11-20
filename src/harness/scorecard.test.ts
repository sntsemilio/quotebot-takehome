// The scorecard over real records: "before" from results/ and, as "after", the five recorded runs kept as fixtures
// (fixtures/records). It gives the verdicts of the grades, with the automatic G1, G2 and G4 green for every "after"
// run. No network, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunEvent } from "../record/events.js";
import { automaticGrades, dataRoot, render, resultOf, scorecard, summariesOf, type Grade } from "./scorecard.js";

const grades = JSON.parse(fs.readFileSync(path.join("cases", "grades.json"), "utf8")) as Record<string, Grade>;
// The grades of the five recorded runs used as "after" here.
const AFTER: Record<string, Grade> = {
  "after/case1": { expect: "pass", g3: "pass", note: "8 precios con evidencia." },
  "after/case5": { expect: "pass", g3: "pass", note: "Pide CP y medidas; elige la que llega a tiempo según el sitio." },
  "after/case6": { expect: "pass", g3: "pass", note: "Estafeta y FedEx con evidencia; DHL bloqueada." },
  "after/case7": { expect: "pass", g3: "pass", note: "7 precios, cada uno con su total por 4." },
  "after/case9": { expect: "pass", g3: "pass", note: "Dice que el CP 99999 no siguió y pide confirmarlo." },
};

// A data root like results/: before/ as measured, after/ with the fixtures' summaries and records side by side.
function root(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qb-score-"));
  fs.cpSync(path.join("results", "before"), path.join(dir, "before"), { recursive: true });
  fs.mkdirSync(path.join(dir, "after"));
  for (const l of ["one-turn", "two-turn"]) {
    for (const f of fs.readdirSync(path.join("fixtures", "records", l))) {
      if (f.endsWith(".jsonl") || f.endsWith(".summary.json")) fs.copyFileSync(path.join("fixtures", "records", l, f), path.join(dir, "after", f));
    }
  }
  return dir;
}

test("the scorecard over real records gives the results of the grades, with automatic G1, G2 and G4 green", () => {
  assert.equal(dataRoot(), path.join(".", "results"), "results/ travels with the code and is read first");
  assert.deepEqual(
    Object.keys(grades).sort(),
    ["after/case1", "after/case5", "after/case6", "after/case7", "after/case9", "before/case5", "before/case6", "before/case7"],
    "the repo grades the starting point (3 cases) and the final code (5 cases)",
  );
  const all = { ...grades, ...AFTER };
  const rows = scorecard(root(), all);
  assert.deepEqual(rows.map((r) => `${r.label}/case${r.caseId}`).sort(), Object.keys(all).sort(), "one row per graded run");
  const expected: Record<string, string> = { pass: "pasa", asks: "pregunta", fail: "falla" };
  for (const r of rows) {
    assert.equal(r.result, expected[all[`${r.label}/case${r.caseId}`].expect], `${r.label}/case${r.caseId}`);
    if (r.label === "before") continue;
    assert.deepEqual(r.problems, [], `${r.label}/case${r.caseId}`);
    assert.deepEqual([r.g.g1, r.g.g2, r.g.g4], ["pass", "pass", "pass"], `case ${r.caseId}`);
    assert.equal(r.hiddenErrors, 0, "the records mark every tool error shown to the model");
  }
  const md = render(rows);
  const has = (line: string) => assert.ok(md.includes(line), line);
  has("| 5 | before | falla | 1 min 14 s | $0.5334 | 8 | 9 |"); // before keeps its own count
  has("| 7 | after | pasa | 2 min 22 s | $0.3038 | 23 | 0 |");
  has("- Caso 5: antes falla (1 min 14 s, $0.5334); después pasa (2 min 23 s, $0.2934).");
  has("- Caso 6: antes falla (1 min 37 s, $2.7474); después pasa (2 min 24 s, $0.3316).");
  assert.doesNotMatch(md, /paso \d|after-|\(1\)/, "no intermediate versions and nothing about the process");
});

test("the measured results in results/: before fails its 3 cases, after passes its 5 with automatic G1, G2 and G4 green", () => {
  const rows = scorecard(path.join(".", "results"), grades);
  assert.deepEqual(rows.map((r) => `${r.label}/case${r.caseId}`).sort(), Object.keys(grades).sort(), "one row per graded run");
  for (const r of rows) {
    assert.equal(r.result, r.label === "before" ? "falla" : "pasa", `${r.label}/case${r.caseId}`);
    if (r.label === "before") continue;
    assert.deepEqual(r.problems, [], `${r.label}/case${r.caseId}`);
    assert.deepEqual([r.g.g1, r.g.g2, r.g.g4], ["pass", "pass", "pass"], `case ${r.caseId}`);
    assert.equal(r.hiddenErrors, 0, `case ${r.caseId}: no tool error hidden from the model`);
  }
});

test("a label without a folder is skipped without error; the table says what was not measured", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qb-score-"));
  fs.cpSync(path.join("results", "before"), path.join(dir, "before"), { recursive: true });
  assert.deepEqual(summariesOf(dir, "after"), []);
  const rows = scorecard(dir, grades);
  assert.deepEqual(rows.map((r) => r.label), ["before", "before", "before"]);
  assert.match(render(rows), /- Caso 7: antes falla .*; después sin medir\./);
});

test("the automatic grades catch an amount in the chat, a price without evidence and a carrier left open", () => {
  const turn = (text: string) => ({ seq: 1, t: "", ms: 0, type: "conversation.turn", conversationId: "c", role: "assistant", text }) as RunEvent;
  const quote = [
    { seq: 1, t: "", ms: 0, type: "run.started", runId: "r", label: "t", carrierIds: ["a", "b", "c"] },
    { seq: 2, t: "", ms: 0, type: "carrier.started", carrierId: "a", startUrl: "u", budget: { maxSteps: 1, maxSeconds: 1 }, traceFile: "t" },
    { seq: 3, t: "", ms: 0, type: "evidence.captured", carrierId: "a", evidenceId: "ev1", reason: "r", url: "u", text: "$10.00", capturedAt: "", images: [] },
    { seq: 4, t: "", ms: 0, type: "price.verified", carrierId: "a", service: "S", amount: 10, currency: "MXN", includesVAT: null, deliveryDays: null, priceText: "$10.00", evidenceId: "ev1" },
    { seq: 5, t: "", ms: 0, type: "carrier.closed", carrierId: "a", status: "quoted", reason: "ok", closedBy: "model" },
    { seq: 6, t: "", ms: 0, type: "carrier.started", carrierId: "b", startUrl: "u", budget: { maxSteps: 1, maxSeconds: 1 }, traceFile: "t" },
    { seq: 7, t: "", ms: 0, type: "carrier.skipped", carrierId: "c", missing: [{ field: "shipDate", why: "w" }] },
  ] as RunEvent[];
  const a = automaticGrades([turn("Te sale en $350.")], quote);
  assert.deepEqual([a.g1, a.g2, a.g4], ["fail", "fail", "fail"]);
  assert.equal(a.problems.length, 3);
  const ok = automaticGrades([turn("¿Me das el peso y las medidas?")], null);
  assert.deepEqual([ok.g1, ok.g2, ok.g4], ["pass", "n/a", "n/a"]);
  assert.equal(resultOf({ expect: "pass" }, { g1: "pass", g2: "fail", g3: "pass", g4: "pass" }), "falla");
  assert.equal(resultOf({ expect: "asks" }, { g1: "pass", g2: "n/a", g3: "pass", g4: "n/a" }), "pregunta");
  assert.equal(resultOf(undefined, { g1: "pass", g2: "pass", g3: "pass", g4: "pass" }), "sin calificar");
});
