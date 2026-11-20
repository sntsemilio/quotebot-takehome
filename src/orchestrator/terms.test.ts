// Estafeta's published service terms (its plugin's data), business days, and the guaranteed-time tiebreak
// for "Más rápido". Over the recorded quote ojy6 (case 7, quoted Thursday 2026-11-19). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { RunEvent } from "../record/events.js";
import { fold } from "../record/state.js";
import { buildQuoteView } from "./view.js";
import { addBusinessDays, meetsDeadline, parseDelivery, rankQuotes } from "./ranking.js";
import { resultDigest } from "../conversation/session.js";
import { estafeta } from "../carriers/estafeta.js";
import { carriers as registry } from "../carriers/index.js";

const OJY6 = path.join("fixtures", "records", "one-turn", "quote-2026-11-19T16-04-14-468Z-ojy6.jsonl");
const events = (): RunEvent[] => fs.readFileSync(OJY6, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const NOW = new Date("2026-11-19T16:04:14Z"); // Thursday, as quoted
const TERMS = estafeta.serviceTerms;

test("ojy6 with 'Más rápido': Estafeta 12:30 first, then Dia Sig., FedEx 10:30, FedEx Día Siguiente, 2 Dias, Terrestre, Económico", () => {
  const v = buildQuoteView(events(), NOW, { priority: "fastest" });
  const rows = v.ranked.map((r) => [r.carrierId, r.price.service, r.delivery?.maxDays, r.delivery?.byTime ?? null, r.delivery?.source]);
  assert.deepEqual(rows, [
    ["estafeta", "12:30", 1, "12:30", "carrier_terms"], // vie 20, antes de las 12:30
    ["estafeta", "Dia Sig.", 1, null, "carrier_terms"], // vie 20 (9 a 18 is a window, not a guarantee)
    ["fedex", "FedEx Nacional 10:30 a.m.", 4, "14:00", "site_date"], // lun 23, por 14:00
    ["fedex", "FedEx Nacional Día Siguiente", 4, "21:00", "site_date"], // lun 23, por 21:00
    ["estafeta", "2 Dias", 4, null, "carrier_terms"], // lun 23
    ["estafeta", "Terrestre", 7, null, "carrier_terms"], // mar 24 a jue 26
    ["fedex", "FedEx Nacional Económico", 8, "21:00", "site_date"], // vie 27
  ]);
  const first = v.ranked[0].delivery!;
  assert.equal(first.label, "Día hábil siguiente, antes de las 12:30");
  assert.equal(first.sourceUrl, "https://www.estafeta.com/nacional");
  assert.equal(first.arrivalDate, undefined, "a published term is not a date of this quote");
  assert.deepEqual([v.ranked[5].delivery?.minDays, v.ranked[5].delivery?.maxDays], [5, 7], "Terrestre: Tue 24 to Thu 26");
  // The note's digest says where it comes from; never "per the site".
  const digest = resultDigest(v);
  assert.match(digest, /1\. Estafeta – 12:30: next business day before 12:30 per Estafeta's published service terms/);
  assert.match(digest, /Estafeta – Terrestre: 3-5 business days per Estafeta's published service terms/);
  assert.doesNotMatch(digest, /Estafeta – [^\n]*per the site/);
});

test("'Más barato' keeps its order; a service not in the terms and a site that gave its delivery behave as before", () => {
  const s = fold(events());
  const order = (rows: ReturnType<typeof rankQuotes>) => rows.map((r) => `${r.carrierId}:${r.price.service}:${r.price.amount}`);
  assert.deepEqual(order(rankQuotes(s, { priority: "cheapest" }, NOW, (id) => registry[id]?.serviceTerms)), order(rankQuotes(s, { priority: "cheapest" }, NOW)));

  assert.equal(parseDelivery({ deliveryDays: null, service: "Express Plus" }, "2026-11-19", TERMS), null, "not in the terms: nothing guessed");
  assert.deepEqual(parseDelivery({ deliveryDays: null, service: "Día Siguiente" }, "2026-11-19", TERMS),
    { minDays: 1, maxDays: 1, source: "service_name" }, "not an exact match: the service's name, as before");
  assert.equal(parseDelivery({ deliveryDays: null, service: " DÍA  sig. " }, "2026-11-19", TERMS)?.source, "carrier_terms", "spaces, accents and case are normalized");
  // The site's own text wins over the published terms.
  assert.deepEqual(parseDelivery({ deliveryDays: "2", service: "12:30" }, "2026-11-19", TERMS), { minDays: 2, maxDays: 2, source: "site_delivery_days" });
  // FedEx has no terms: its rows only gain the guaranteed time the site wrote.
  assert.equal(registry.fedex.serviceTerms, undefined);
  assert.ok(Object.values(registry).filter((p) => p.serviceTerms).every((p) => p.id === "estafeta"), "only Estafeta has terms");
});

test("'Llega a tiempo' with a range claims no more than it knows", () => {
  const terrestre = parseDelivery({ deliveryDays: null, service: "Terrestre" }, "2026-11-19", TERMS)!; // Tue 24 to Thu 26
  assert.equal(meetsDeadline(terrestre, "2026-11-25", "2026-11-19"), null, "deadline on the 4th business day: maybe");
  assert.equal(meetsDeadline(terrestre, "2026-11-26", "2026-11-19"), true, "its last day is on time");
  assert.equal(meetsDeadline(terrestre, "2026-11-23", "2026-11-19"), false, "its first day is already late");
  // Case 5 (deadline Fri 20, first day Tue 24) stays false; a single day is as before.
  const v = buildQuoteView(fs.readFileSync(path.join("fixtures", "records", "two-turn", "quote-2026-11-19T16-09-38-936Z-8vs9.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)), NOW);
  const t = v.ranked.find((r) => r.price.service === "Terrestre")!;
  assert.equal(v.request?.preference?.deadline, "2026-11-20");
  assert.equal(t.meetsDeadline, false);
  assert.equal(meetsDeadline({ minDays: 1, maxDays: 1, source: "service_name" }, "2026-11-19", "2026-11-19"), false);
  assert.equal(meetsDeadline({ minDays: 1, maxDays: 1, source: "service_name" }, "2026-11-20", "2026-11-19"), true);
});

test("business days skip the weekend: 12:30 shipped on a Friday arrives Monday", () => {
  assert.equal(addBusinessDays("2026-11-20", 1), "2026-11-23");
  assert.equal(addBusinessDays("2026-11-21", 1), "2026-11-23", "a Saturday ship date too");
  assert.equal(addBusinessDays("2026-11-19", 5), "2026-11-26");
  assert.deepEqual(parseDelivery({ deliveryDays: null, service: "12:30" }, "2026-11-20", TERMS), {
    minDays: 3, maxDays: 3, source: "carrier_terms", byTime: "12:30", businessDays: { min: 1, max: 1 },
    label: "Día hábil siguiente, antes de las 12:30", sourceUrl: "https://www.estafeta.com/nacional",
  });
});
