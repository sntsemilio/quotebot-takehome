// The site's VAT breakdown in the view, and the replay notice. No browser, no network, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { RunEvent } from "../record/events.js";
import { buildQuoteView } from "../orchestrator/view.js";
import { replayNotice, viewOfRecord } from "../history/history.js";

const FIXTURE7 = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "record", "fixtures", "case7-qotf.jsonl");
const case7 = (): RunEvent[] => fs.readFileSync(FIXTURE7, "utf8").trim().split("\n").map((l) => JSON.parse(l));

// FedEx guest results with two open breakdowns, as seen by hand on 2026-11-19.
const EVIDENCE = [
  "FedEx Nacional Económico", "$530.64", "Tarifa base", "$397.78", "IVA", "$73.19", "RECARGO POR COMBUSTIBLE", "$59.67", "Total estimado", "$530.64",
  "FedEx Nacional Día Siguiente", "$612.16", "Tarifa base", "$458.88", "IVA", "$84.45", "RECARGO POR COMBUSTIBLE", "$68.83", "Total estimado", "$612.16",
  "Los montos se muestran en MXN", "Las tarifas que se muestran aquí pueden ser diferentes de los cargos reales de su envío.",
].join("\n");
const fedexEvents = (): RunEvent[] => [
  { seq: 1, t: "2026-11-19T18:00:00.000Z", ms: 0, type: "run.started", runId: "q8", label: "t", carrierIds: ["fedex"] },
  { seq: 2, t: "", ms: 1, type: "request.validated", request: { originZip: "64000", destZip: "06600", parcels: [{ weightKg: 2, lengthCm: 30, widthCm: 20, heightCm: 15 }] } },
  { seq: 3, t: "", ms: 2, type: "carrier.started", carrierId: "fedex", startUrl: "u", budget: { maxSteps: 1, maxSeconds: 1 }, traceFile: "t" },
  { seq: 4, t: "", ms: 3, type: "evidence.captured", carrierId: "fedex", evidenceId: "ev1", reason: "r", url: "u", text: EVIDENCE, capturedAt: "", images: [] },
  // The model listed the breakdown out of order and left the total out: the view shows the page's order, total included.
  { seq: 5, t: "", ms: 4, type: "price.verified", carrierId: "fedex", service: "FedEx Nacional Económico", amount: 530.64, currency: "MXN", includesVAT: true, deliveryDays: null, priceText: "$530.64", evidenceId: "ev1",
    siteNotes: ["Los montos se muestran en MXN", "IVA $73.19", "RECARGO POR COMBUSTIBLE $59.67", "Tarifa base $397.78", "Las tarifas que se muestran aquí pueden ser diferentes de los cargos reales de su envío."],
    vatBreakdown: { vatLine: "IVA $73.19", totalLine: "Total estimado $530.64" } },
  { seq: 6, t: "", ms: 5, type: "price.verified", carrierId: "fedex", service: "FedEx Nacional Día Siguiente", amount: 612.16, currency: "MXN", includesVAT: null, deliveryDays: null, priceText: "$612.16", evidenceId: "ev1",
    siteNotes: ["Los montos se muestran en MXN"] },
  { seq: 7, t: "", ms: 6, type: "carrier.closed", carrierId: "fedex", status: "quoted", reason: "ok", closedBy: "model" },
  { seq: 8, t: "", ms: 7, type: "run.finished", status: "completed" },
] as RunEvent[];

test("an option backed by a breakdown shows the site's lines in the page's order, captioned, and the other notices apart", () => {
  const v = buildQuoteView(fedexEvents());
  const [eco, next] = v.ranked;
  assert.equal(eco.price.includesVAT, true); // the badge reads "IVA incluido"
  assert.deepEqual(eco.breakdown, {
    caption: "Desglose de la página de FedEx",
    lines: ["Tarifa base $397.78", "IVA $73.19", "RECARGO POR COMBUSTIBLE $59.67", "Total estimado $530.64"],
  });
  assert.deepEqual(eco.notices, ["Los montos se muestran en MXN", "Las tarifas que se muestran aquí pueden ser diferentes de los cargos reales de su envío."]);
  // No breakdown: no section, every site note is a notice.
  assert.equal(next.breakdown, undefined);
  assert.deepEqual(next.notices, ["Los montos se muestran en MXN"]);
});

test("in replay mode every quote says it replays a recording, naming it; a live quote never does", () => {
  const replay = case7().map((e) => {
    if (e.type === "run.started") return { ...e, runId: "replay-x", replayOf: FIXTURE7 };
    // What the user asked: another route. The recording's prices are still Monterrey to Tijuana.
    if (e.type === "request.validated") return { ...e, request: { ...e.request, originZip: "01000", destZip: "97000" } };
    return e;
  }) as RunEvent[];
  const expected = "Reproducción de una cotización grabada (Monterrey a Tijuana, 4 cajas de 10 kg). No corresponde a lo que pediste: en modo réplica no se consultan los sitios.";
  assert.equal(replayNotice(replay), expected);
  assert.equal(viewOfRecord("replay-x", replay, null).replayNotice, expected);
  // An interrupted replay keeps the notice.
  assert.equal(viewOfRecord("replay-x", replay.filter((e) => e.type !== "run.finished"), null).replayNotice, expected);
  // A recording that cannot be read: the notice still says it is a replay, without a name.
  const lost = replay.map((e) => (e.type === "run.started" ? { ...e, replayOf: "runs/nope/nope.jsonl" } : e)) as RunEvent[];
  assert.equal(replayNotice(lost), "Reproducción de una cotización grabada. No corresponde a lo que pediste: en modo réplica no se consultan los sitios.");
  // Live: the original record itself, and a live quote, carry no notice.
  assert.equal(replayNotice(case7()), undefined);
  assert.equal(viewOfRecord("q", case7(), null).replayNotice, undefined);
  assert.equal(viewOfRecord("q8", fedexEvents(), null).replayNotice, undefined);
});
