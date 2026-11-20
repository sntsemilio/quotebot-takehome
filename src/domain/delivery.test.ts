// The delivery verifier over the recorded runs in fixtures/records (no network). Every reported deliveryDays is
// checked against the evidence.captured of its own evidenceId: its dates and times must be on the page, its other
// words labels or page words; a text without dates or times must be on the page whole, with a letter.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { RunEvent } from "../record/events.js";
import { deliveryInEvidence } from "./delivery.js";

const files = ["one-turn", "two-turn"].flatMap((l) =>
  fs.readdirSync(path.join("fixtures", "records", l)).filter((f) => f.startsWith("quote-")).map((f) => path.join("fixtures", "records", l, f)));
const read = (f: string) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l) as RunEvent);

function deliveryCounts() {
  const counts: Record<string, { accepted: number; dropped: number; none: number; droppedTexts: string[] }> = {};
  for (const f of files) {
    const events = read(f);
    const evidence = new Map<string, string>();
    for (const e of events) if (e.type === "evidence.captured") evidence.set(e.evidenceId, e.text);
    for (const e of events) {
      if (e.type !== "price.verified") continue;
      const c = (counts[e.carrierId] ??= { accepted: 0, dropped: 0, none: 0, droppedTexts: [] });
      if (e.deliveryDays == null) { c.none++; continue; }
      if (deliveryInEvidence(e.deliveryDays, evidence.get(e.evidenceId) ?? "")) c.accepted++;
      else { c.dropped++; c.droppedTexts.push(`${e.service}: ${JSON.stringify(e.deliveryDays)}`); }
    }
  }
  return counts;
}

test("over the recorded runs, FedEx 12 accepted and 1 dropped ('--'); Estafeta 0 accepted, 8 dropped, 8 without delivery", () => {
  assert.equal(files.length, 5);
  const c = deliveryCounts();
  assert.deepEqual([c.fedex.accepted, c.fedex.dropped, c.fedex.none], [12, 1, 0], c.fedex.droppedTexts.join("; "));
  assert.deepEqual(c.fedex.droppedTexts, ['FedEx Nacional 8:30 a.m.: "--"']);
  assert.deepEqual([c.estafeta.accepted, c.estafeta.dropped, c.estafeta.none], [0, 8, 8]);
  assert.ok(c.estafeta.droppedTexts.every((t) => /: "[12]"$/.test(t)), c.estafeta.droppedTexts.join("; "));
});

test("the facts are verified, not the string: the agent's different joins pass, a date not on the page does not", () => {
  const evidenceOf = (suffix: string) => {
    const f = files.find((x) => x.endsWith(`${suffix}.jsonl`))!;
    return read(f).filter((e) => e.type === "evidence.captured").map((e) => (e.type === "evidence.captured" ? e.text : "")).join("\n");
  };
  const hekq = evidenceOf("hekq");
  const page8vs9 = evidenceOf("8vs9");
  assert.ok(deliveryInEvidence("vie, nov 20 10:30", hekq));
  assert.ok(deliveryInEvidence("LLEGA EL vie, nov 20 - ENTREGADO POR 12:00", page8vs9));
  assert.ok(!deliveryInEvidence("LLEGA EL sáb, nov 21", hekq), "a date that is not on the page");
  assert.ok(!deliveryInEvidence("LLEGA EL vie, nov 20, ENTREGADO POR 11:00", hekq), "a time that is not on the page");
  assert.ok(!deliveryInEvidence("LLEGA EL vie, nov 20, garantizado", hekq), "a word that is neither a label nor on the page");
  // The literal form: whole on the page and with a letter; a bare number or a dash never passes.
  assert.ok(deliveryInEvidence("3 a 5 días hábiles", "Terrestre\n3 a 5 dias habiles\n$120.00"));
  for (const t of ["1", "2", "--"]) assert.ok(!deliveryInEvidence(t, "Dia Sig.\n1\n2\n--\n$2,243.28"), t);
  assert.ok(!deliveryInEvidence("1 día", "Dia Sig.\n$2,243.28"), "not on the page");
});
