// "Cotizar en el sitio de …" and "Copiar datos del envío" for carriers we could not quote, and the guard that
// none of it changes the result note's digest, its fallback or the carriers' messages. No browser, no network, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { RunEvent } from "../record/events.js";
import type { QuoteRequest } from "../domain/request.js";
import { buildQuoteView, interruptView, MANUAL_STATUSES } from "../orchestrator/view.js";
import { resultDigest, fallbackNote } from "../conversation/session.js";
import { viewOfRecord } from "../history/history.js";
import { shipmentText } from "../domain/shipment.js";
import { carriers as registry } from "../carriers/index.js";

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "record", "fixtures");
const load = (f: string): RunEvent[] => fs.readFileSync(path.join(DIR, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const NOW = new Date("2026-11-18T03:30:00Z");

// The golden file holds the result note's digest, the fallback note and each carrier's chip and message for the
// recorded quotes of cases 7 and 9.
test("no regression in the digest, the fallback note or the carriers' messages (cases 7 and 9)", () => {
  const golden = JSON.parse(fs.readFileSync(path.join(DIR, "note-no-regression.json"), "utf8"));
  assert.deepEqual(Object.keys(golden), ["case7-qotf.jsonl", "case9-ntk3.jsonl"]);
  for (const [file, want] of Object.entries(golden)) {
    const v = buildQuoteView(load(file), NOW);
    const got = {
      digest: resultDigest(v),
      fallbackNote: fallbackNote(v),
      carriers: v.carriers.map((c) => ({ carrierId: c.carrierId, status: c.status, label: c.label, message: c.message })),
    };
    assert.deepEqual(got, want, file);
  }
});

const REQUEST: QuoteRequest = { originZip: "64000", destZip: "22000", parcels: [{ weightKg: 10, lengthCm: 40, widthCm: 30, heightCm: 30 }], count: 4 };
const ids = ["estafeta", "fedex", "redpack", "dhl", "ups"];
// One record with every way a carrier can end: dhl blocked, ups failed, fedex out of turns, estafeta no coverage,
// redpack still open (interrupted once the record is abandoned).
const closings = (): RunEvent[] => {
  const ev: RunEvent[] = [
    { seq: 1, t: "2026-11-19T18:00:00.000Z", ms: 0, type: "run.started", runId: "q9", label: "t", carrierIds: ids },
    { seq: 2, t: "", ms: 1, type: "request.validated", request: REQUEST },
  ] as RunEvent[];
  const close = (carrierId: string, status: string, reason: string) =>
    ev.push({ seq: ev.length + 1, t: "", ms: ev.length, type: "carrier.closed", carrierId, status, reason, closedBy: "code" } as RunEvent);
  for (const id of ids) ev.push({ seq: ev.length + 1, t: "", ms: ev.length, type: "carrier.started", carrierId: id, startUrl: "u", budget: { maxSteps: 1, maxSeconds: 1 }, traceFile: "t" } as RunEvent);
  close("dhl", "blocked", "ERR_HTTP2_PROTOCOL_ERROR");
  close("ups", "failed", "the site answered with a download");
  close("fedex", "budget_exhausted", "cap: steps");
  close("estafeta", "no_coverage", "the site says it does not serve this route");
  return ev;
};

test("manualQuote only for blocked, failed, unfinished (also interrupted) and no coverage, with the README's pages", () => {
  const v = interruptView(buildQuoteView(closings(), NOW));
  const by = Object.fromEntries(v.carriers.map((c) => [c.carrierId, c]));
  assert.deepEqual(by.dhl.manualQuote, { url: "https://www.dhl.com/mx-es/home/envio/cotizacion-envio.html", label: "Cotizar en el sitio de DHL" });
  assert.deepEqual(by.ups.manualQuote, { url: "https://www.ups.com/mx/es/support/shipping-support/shipping-costs-rates.page", label: "Cotizar en el sitio de UPS" });
  assert.deepEqual(by.fedex.manualQuote, { url: "https://www.fedex.com/es-mx/online/rating.html", label: "Cotizar en el sitio de FedEx" });
  assert.deepEqual(by.estafeta.manualQuote, { url: "https://www.estafeta.com/cotizar-envio", label: "Cotizar en el sitio de Estafeta" });
  assert.equal(by.redpack.status, "interrupted");
  assert.deepEqual(by.redpack.manualQuote, { url: "https://www.redpack.com.mx/es/cotizador/", label: "Cotizar en el sitio de Redpack" });
  assert.deepEqual([...MANUAL_STATUSES].sort(), ["blocked", "budget_exhausted", "failed", "interrupted", "no_coverage"]);
  // Every plugin names its page; they are the README's quote pages.
  for (const id of ids) assert.ok(registry[id].manualUrl?.startsWith("https://"), id);

  // Still open in a quote that is running, quoted, waiting for data, a rejected postal code, or a "No terminó":
  // no link. The first two have nothing to work around; the others are fixed in the chat.
  const running = buildQuoteView(closings(), NOW).carriers.find((c) => c.carrierId === "redpack")!;
  assert.equal(running.status, "running");
  assert.equal(running.manualQuote, undefined);
  const case9 = buildQuoteView(load("case9-ntk3.jsonl"), NOW).carriers;
  const case7 = buildQuoteView(load("case7-qotf.jsonl"), NOW).carriers;
  for (const c of [...case9, ...case7]) {
    if (MANUAL_STATUSES.includes(c.status)) assert.ok(c.manualQuote, `${c.carrierId} ${c.status}`);
    else assert.equal(c.manualQuote, undefined, `${c.carrierId} ${c.status} (${c.label})`);
  }
  assert.ok(case7.find((c) => c.carrierId === "dhl")?.manualQuote, "case 7: DHL blocked");
  assert.ok(case9.find((c) => c.carrierId === "estafeta")?.manualQuote, "case 9: Estafeta failed");
  assert.equal(case7.find((c) => c.carrierId === "fedex")?.manualQuote, undefined, "case 7: FedEx quoted");
  assert.ok(case9.some((c) => c.status === "needs_human" && c.missing), "case 9 has carriers waiting for data");
  assert.ok(case9.some((c) => c.status === "needs_human" && !c.missing), "case 9 has a rejected postal code");
  // The history shows the same rows.
  const history = viewOfRecord("q9", closings(), null).carriers.find((c) => c.carrierId === "dhl")!;
  assert.equal(history.manualQuote?.label, "Cotizar en el sitio de DHL");
});

test("shipmentText, with 4 boxes and 1, with and without a ship date", () => {
  assert.equal(shipmentText({ ...REQUEST, extras: { shipDate: "2026-11-20" } }),
    "Origen: CP 64000\nDestino: CP 22000\nPaquetes: 4 cajas de 10 kg, 40 × 30 × 30 cm\nFecha de envío: 20 nov 2026");
  assert.equal(shipmentText(REQUEST), "Origen: CP 64000\nDestino: CP 22000\nPaquetes: 4 cajas de 10 kg, 40 × 30 × 30 cm");
  const one: QuoteRequest = { originZip: "64000", destZip: "06600", parcels: [{ weightKg: 2, lengthCm: 30, widthCm: 20, heightCm: 15 }] };
  assert.equal(shipmentText(one), "Origen: CP 64000\nDestino: CP 06600\nPaquetes: 1 caja de 2 kg, 30 × 20 × 15 cm");
  assert.equal(shipmentText({ ...one, count: 1, extras: { shipDate: "2027-01-05", deliveryType: "home" } }),
    "Origen: CP 64000\nDestino: CP 06600\nPaquetes: 1 caja de 2 kg, 30 × 20 × 15 cm\nFecha de envío: 5 ene 2027");
  // Boxes that differ, one after the other; decimals as the request has them.
  assert.equal(shipmentText({ ...one, parcels: [one.parcels[0], { weightKg: 1.5, lengthCm: 25, widthCm: 20, heightCm: 10 }] }).split("\n")[2],
    "Paquetes: 1 caja de 2 kg, 30 × 20 × 15 cm; 1 caja de 1.5 kg, 25 × 20 × 10 cm");
  // In the view, from the validated request; nothing without one.
  assert.equal(buildQuoteView(closings(), NOW).shipmentText, shipmentText(REQUEST));
  assert.equal(buildQuoteView([], NOW).shipmentText, undefined);
});
