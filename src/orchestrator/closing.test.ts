// Totals tied to their price, site arrival dates, postal codes "seen" only on carriers that quoted, and case 9
// without a site message. Uses the recorded quotes of case 7 (qotf) and case 9 (ntk3),
// trimmed to the events the fold reads (src/record/fixtures). No network, no browser, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunEvent } from "../record/events.js";
import { fold } from "../record/state.js";
import { computeTotal } from "../domain/money.js";
import { meetsDeadline, parseDelivery, rankQuotes } from "./ranking.js";
import { buildQuoteView, zipMentions } from "./view.js";
import { fallbackNote, guardNote, resultDigest } from "../conversation/session.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "record", "fixtures");
const load = (f: string): RunEvent[] => fs.readFileSync(path.join(fixtures, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const case7 = () => load("case7-qotf.jsonl");
const case9 = () => load("case9-ntk3.jsonl");
// Case 7 ran at 22:21 on 2026-11-18 in Monterrey: that is the ship date.
const NOW7 = new Date("2026-11-19T04:21:55Z");

// The same record as watchTotals writes it: each total points to the price.verified before it.
function withPriceSeq(events: RunEvent[]): RunEvent[] {
  let lastPrice = -1;
  return events.map((e) => {
    if (e.type === "price.verified") lastPrice = e.seq;
    return e.type === "total.computed" ? { ...e, priceSeq: lastPrice } : e;
  });
}

// ---- 1. totals tied to their price ----

for (const [label, events] of [["without priceSeq (older record)", case7()], ["with priceSeq", withPriceSeq(case7())]] as const) {
  test(`case 7 ${label}: each price has its own total and the order compares totals`, () => {
    if (label === "without priceSeq (older record)") assert.ok(events.every((e) => e.type !== "total.computed" || e.priceSeq === undefined));
    const s = fold(events);
    const all = [...s.carriers.estafeta.prices, ...s.carriers.fedex.prices];
    assert.equal(all.length, 10);
    for (const p of all) {
      assert.deepEqual(p.total && { total: p.total.total, formula: p.total.formula }, { ...computeTotal(p.amount, 4, "MXN") }, `${p.service} ${p.priceText}`);
    }
    const ranked = buildQuoteView(events, NOW7).ranked;
    assert.deepEqual(ranked.map((r) => (r.carrierId === "fedex" ? r.price.priceText : `estafeta ${r.price.service}`)), [
      "$488.80", "$610.98", "estafeta Terrestre", "$1,304.55", "$1,419.46", "$1,630.68", "$1,774.31",
      "estafeta Dia Sig.", "estafeta 2 Dias", "estafeta 12:30",
    ]);
    assert.ok(ranked.every((r) => r.comparable === r.price.total!.total), "every row compares its own total");
  });
}

test("priceSeq ties a total to that exact price even when service, evidence and amount repeat", () => {
  const base = { t: "", ms: 0, carrierId: "fedex", service: "Económico", currency: "MXN", evidenceId: "ev1" };
  const price = (seq: number, deliveryDays: string) =>
    ({ ...base, seq, type: "price.verified", amount: 100, includesVAT: null, deliveryDays, priceText: "$100.00" }) as RunEvent;
  const total = (seq: number, priceSeq: number, n: number) =>
    ({ ...base, seq, type: "total.computed", count: n, unitAmount: 100, total: 100 * n, formula: `${n} x 100.00 MXN`, priceSeq }) as RunEvent;
  // Totals in reverse order; the second carries a different count so the two can be told apart.
  const s = fold([price(1, "nov 23"), price(2, "nov 27"), total(3, 2, 3), total(4, 1, 2)]);
  assert.deepEqual(s.carriers.fedex.prices.map((p) => [p.deliveryDays, p.total?.count]), [["nov 23", 2], ["nov 27", 3]]);
});

// ---- 2. arrival dates from the site ----

test("parseDelivery reads site dates, gives null for text it does not understand, keeps Estafeta as it was", () => {
  assert.deepEqual(parseDelivery({ deliveryDays: "LLEGA EL lun, nov 23 - ENTREGADO POR 14:00", service: "FedEx Nacional Día Siguiente" }, "2026-11-18"),
    { minDays: 5, maxDays: 5, source: "site_date", arrivalDate: "2026-11-23", byTime: "14:00" }); // the site's guaranteed time
  assert.equal(parseDelivery({ deliveryDays: "--", service: "FedEx Nacional Día Siguiente" }, "2026-11-18"), null, "the service name is not used when the site gave text");
  assert.deepEqual(parseDelivery({ deliveryDays: "dic 30", service: "x" }, "2026-12-28"), { minDays: 2, maxDays: 2, source: "site_date", arrivalDate: "2026-12-30" });
  assert.deepEqual(parseDelivery({ deliveryDays: "ene 2", service: "x" }, "2026-12-30"), { minDays: 3, maxDays: 3, source: "site_date", arrivalDate: "2027-01-02" });
  // Weekday "mar" (Tuesday) is not read as March; "<day> de <month>" works too.
  assert.equal(parseDelivery({ deliveryDays: "LLEGA EL mar, nov 24", service: "x" }, "2026-11-18")?.arrivalDate, "2026-11-24");
  assert.equal(parseDelivery({ deliveryDays: "Llega el 3 de dic.", service: "x" }, "2026-11-18")?.arrivalDate, "2026-12-03");
  // Estafeta (case 7): "1" in deliveryDays, and "Dia Sig." by name when deliveryDays is null.
  assert.deepEqual(parseDelivery({ deliveryDays: "1", service: "Dia Sig." }, "2026-11-18"), { minDays: 1, maxDays: 1, source: "site_delivery_days" });
  assert.deepEqual(parseDelivery({ deliveryDays: null, service: "Dia Sig." }, "2026-11-18"), { minDays: 1, maxDays: 1, source: "service_name" });
  assert.deepEqual(parseDelivery({ deliveryDays: "2", service: "2 Dias" }, "2026-11-18"), { minDays: 2, maxDays: 2, source: "site_delivery_days" });
});

test("meetsDeadline compares the site's arrival date directly", () => {
  const d = parseDelivery({ deliveryDays: "LLEGA EL lun, nov 23", service: "x" }, "2026-11-18");
  assert.equal(meetsDeadline(d, "2026-11-23", "2026-11-18"), true);
  assert.equal(meetsDeadline(d, "2026-11-22", "2026-11-18"), false);
});

test("in case 7, a 'Día Siguiente' that arrives Nov 23 is not fastest; the digest says where each time came from", () => {
  const events = case7();
  const s = fold(events);
  const fast = rankQuotes(s, { priority: "fastest" }, NOW7);
  // Estafeta's "Dia Sig." (1 day) first; then 2 days: FedEx's Nov 20 options and Estafeta's "2 Dias". On the
  // same day the earlier guaranteed time goes first (10:30 a.m. "POR 14:00" before Día Siguiente "POR 21:00"), then
  // no guaranteed time ("2 Dias"); price only breaks what is left.
  assert.deepEqual(fast.slice(0, 4).map((r) => [r.carrierId, r.price.priceText, r.delivery?.maxDays, r.delivery?.byTime]), [
    ["estafeta", "2,243.28", 1, undefined], ["fedex", "$1,774.31", 2, "14:00"], ["fedex", "$1,630.68", 2, "21:00"], ["estafeta", "2,306.44", 2, undefined],
  ]);
  // The "Día Siguiente" at $1,304.55 arrives Nov 23: 5 days, not 1 (it used to count as 1 by its name).
  const nextDay = fast.find((r) => r.price.priceText === "$1,304.55")!;
  assert.deepEqual(nextDay.delivery, { minDays: 5, maxDays: 5, source: "site_date", arrivalDate: "2026-11-23", byTime: "21:00" });

  // "Dia Sig." by name only: drop its deliveryDays.
  const byName = events.map((e) => (e.type === "price.verified" && e.service === "Dia Sig." ? { ...e, deliveryDays: null } : e));
  const digest = resultDigest(buildQuoteView(byName, NOW7));
  assert.match(digest, /FedEx México – FedEx Nacional Económico: arrives 2026-11-27 per the site/);
  assert.match(digest, /Estafeta – 2 Dias: delivery 2 day\(s\) per the site/);
  // Without the site's text, Estafeta's published terms apply (said as such), before the service's name.
  assert.match(digest, /Estafeta – Dia Sig\.: next business day per Estafeta's published service terms/);
  assert.match(digest, /Estafeta – 12:30: next business day before 12:30 per Estafeta's published service terms/);
});

// ---- 3. a postal code is "seen" only on carriers that quoted ----

test("a postal code only in the evidence of a carrier without a price is not seen", () => {
  const events = case9();
  // FedEx's autocomplete showed "99999 Zac., México" and its later pages repeat 06000, but FedEx never quoted.
  assert.ok(events.some((e) => e.type === "evidence.captured" && e.carrierId === "fedex" && e.text.includes("99999 Zac., México")));
  assert.deepEqual(zipMentions(events, "99999"), []);
  assert.deepEqual(zipMentions(events, "06000"), []);
  const v = buildQuoteView(events);
  assert.deepEqual(v.zips.map((z) => z.seen), [[], []]);
  // Case 7: Estafeta quoted, so its "CP 64000" confirms the code. (FedEx also quoted, but its only line with 64000
  // is a sentence longer than 120 characters, which zipMentions skips as before.)
  assert.deepEqual(zipMentions(case7(), "64000"), [{ carrierId: "estafeta", text: "CP 64000 MONTERREY, NUEVO LEON" }]);
});

// ---- 4. case 9: the postal code not taken, without a site message ----

test("case 9 as recorded: the view and the fallback note do not say 'pidió un dato que no tenemos'; the digest marks the agent's account", () => {
  const v = buildQuoteView(case9());
  const fedex = v.carriers.find((c) => c.carrierId === "fedex")!;
  assert.equal(fedex.status, "needs_human");
  assert.match(fedex.message, /^FedEx México no pudo terminar con los datos que le dimos\./);
  assert.equal(fedex.label, "No terminó", "the chip matches the message (no data was missing)");
  for (const c of v.carriers) assert.doesNotMatch(c.message, /pidió un dato que no tenemos/, c.carrierId);
  const note = fallbackNote(v);
  assert.doesNotMatch(note, /pidió un dato que no tenemos/);
  assert.match(note, /FedEx México no pudo terminar con los datos que le dimos\./);
  const digest = resultDigest(v);
  assert.match(digest, /- FedEx México: needs_human\. .*\n {2}agent's account \(not the site's words\): "FedEx does not accept origin postal code 99999\./);
  assert.match(digest, /- Estafeta: failed\. .*\n {2}agent's account \(not the site's words\): "After submitting origin 99999/);
  assert.doesNotMatch(digest, /Redpack[^\n]*\n {2}agent's account/, "skipped carriers get no account line");
  assert.doesNotMatch(digest, /NOT confirmed/, "no prices: no unconfirmed-code warning");
});

// No longer "no aceptó": the site never said so. With nobody else recognizing 99999, it may be the code or
// the form, so the question stays (case 9's grade asks for it).
test("rejectedZip without siteMessage is not a certainty, in the view, the zips, the digest, the fallback and the guard", () => {
  const events = case9().map((e) => (e.type === "carrier.closed" && e.carrierId === "fedex" ? { ...e, rejectedZip: "origin" as const } : e));
  const v = buildQuoteView(events);
  const sentence = "El formulario de FedEx México no continuó con el CP 99999 y su página no mostró ningún error. Puede ser el CP o su formulario; si tu CP es correcto, cotiza en su sitio.";
  const fedex = v.carriers.find((c) => c.carrierId === "fedex")!;
  assert.equal(fedex.message, sentence);
  assert.equal(fedex.label, "Sin terminar");
  assert.equal(fedex.manualQuote?.label, "Cotizar en el sitio de FedEx");
  assert.deepEqual(v.zips[0].rejectedBy, [{ carrierId: "fedex" }]);
  const digest = resultDigest(v);
  assert.match(digest, /FedEx México's form did not continue with postal code 99999 \(origin\) and its page showed no error: it may be the code or the form\. Ask the user to confirm it and, if it is correct, to quote on FedEx México's site\./);
  assert.doesNotMatch(digest, /REJECTED/);
  const note = fallbackNote(v);
  assert.ok(note.startsWith(`${sentence} ¿Me confirmas el código postal de origen?`), note);
  assert.doesNotMatch(note, /no aceptó|FedEx México no reconoce|undefined/); // no quote is made up for FedEx
  assert.equal(guardNote("Estafeta falló y DHL bloqueó la consulta.", v), `Estafeta falló y DHL bloqueó la consulta. ${sentence} ¿Me confirmas el código postal de origen?`);
});
