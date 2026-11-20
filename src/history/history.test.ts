// "Mis cotizaciones": list and detail rebuilt from records on disk. Uses the recorded quotes of case 7
// and case 9 (src/record/fixtures) with synthetic conversation records. No network, no browser, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConversation, historyGroup, listConversations, quotedLabel, requestTitle, summaryLine } from "./history.js";
import { NOTE7, RUN7, historyDir } from "./fixture.js";

// Thursday 2026-11-19, 10:00 in Monterrey.
const NOW = new Date("2026-11-19T16:00:00Z");

test("the list is read from disk, newest first, titled from the validated request, with the verified first option", () => {
  const list = listConversations(historyDir(), NOW);
  assert.deepEqual(list.map((c) => [c.id, c.title, c.line, c.group]), [
    // Cities when a quoting site confirmed them (Estafeta: "CP 64000 MONTERREY…", "CP 22000 TIJUANA…").
    ["conversation-c7", "Monterrey a Tijuana, 4 cajas de 10 kg", "FedEx Nacional Económico: 1,955.20 MXN por 4 cajas", "Ayer"],
    ["conversation-c9", "99999 a 06000, 1 caja de 1 kg", "Necesita un dato", "Esta semana"],
    ["conversation-ask", "Hola, ¿cuánto cuesta mandar un regalo a Mérida? Es una caja…", "Sin cotización", "Anteriores"],
  ]);
  assert.equal(list[0].startedAt, "2026-11-19T04:21:54.000Z");
  assert.equal(list[0].updatedAt, "2026-11-19T04:25:02.000Z");
  assert.deepEqual(listConversations(path.join(os.tmpdir(), "qb-no-such-dir"), NOW), []);
});

test("the detail has the turns in order, each quote after the reply that started it, its view and its recorded note", () => {
  const d = getConversation(historyDir(), "conversation-c7", NOW)!;
  assert.equal(d.title, "Monterrey a Tijuana, 4 cajas de 10 kg");
  assert.equal(d.firstMessage, "Cuánto me cobran por 4 cajas de 10 kg, 40x30x30, de 64000 a 22000?");
  assert.deepEqual(d.items.map((i) => i.kind), ["user", "assistant", "quote", "user", "assistant"]);
  const q = d.items[2];
  assert.ok(q.kind === "quote" && q.view);
  assert.equal(q.runId, RUN7);
  assert.equal(q.note, NOTE7, "the note exactly as recorded, without the [result note] tag");
  assert.equal(q.quotedLabel, "Cotizado el 18 nov a las 22:21");
  assert.equal(q.view.finished, true);
  // Same comparison as the live view: verified prices with their totals, in order.
  assert.deepEqual(q.view.ranked.slice(0, 2).map((r) => [r.price.priceText, r.price.total?.formula]), [
    ["$488.80", "4 x 488.80 MXN = 1955.20 MXN"], ["$610.98", "4 x 610.98 MXN = 2443.92 MXN"],
  ]);
  // Days to arrival count from the day it was quoted (Nov 18), not from today.
  assert.deepEqual(q.view.ranked[0].delivery, { minDays: 9, maxDays: 9, source: "site_date", arrivalDate: "2026-11-27", byTime: "21:00" });
  assert.equal(q.view.carriers.find((c) => c.carrierId === "dhl")?.status, "blocked");
  assert.ok(d.items.every((i) => i.kind === "quote" || !i.text.startsWith("[result note]")), "the note is not repeated as a message");
});

test("a conversation without a recorded reply or note still shows its quote; bad or unknown ids give null", () => {
  const dir = historyDir();
  const d = getConversation(dir, "conversation-c9", NOW)!;
  const q = d.items.find((i) => i.kind === "quote");
  assert.ok(q && q.kind === "quote" && q.view);
  assert.equal(q.note, null);
  assert.equal(q.view.ranked.length, 0);
  assert.equal(getConversation(dir, "conversation-nope", NOW), null);
  assert.equal(getConversation(dir, "../../package", NOW), null);
  assert.equal(getConversation(dir, "conversation-c7/../../x", NOW), null);
});

test("summary line and title helpers", () => {
  assert.equal(summaryLine(null), "Sin cotización");
  const dir = historyDir();
  // A record without run.finished: "Cotizando…" only while it runs in this process; otherwise it was interrupted.
  const events = fs.readFileSync(path.join(dir, `${RUN7}.jsonl`), "utf8").trim().split("\n").filter((l) => !l.includes('"run.finished"'));
  fs.writeFileSync(path.join(dir, `${RUN7}.jsonl`), events.join("\n") + "\n");
  assert.equal(listConversations(dir, NOW, { isRunning: (id) => id === RUN7 })[0].line, "Cotizando…");
  assert.equal(listConversations(dir, NOW)[0].line, "Se interrumpió");
  assert.equal(requestTitle({ originZip: "64000", destZip: "97000", parcels: [{ weightKg: 2.5, lengthCm: 1, widthCm: 1, heightCm: 1 }] }), "64000 a 97000, 1 caja de 2.5 kg");
  assert.equal(
    requestTitle({ originZip: "64000", destZip: "44100", parcels: [{ weightKg: 3, lengthCm: 1, widthCm: 1, heightCm: 1 }, { weightKg: 5, lengthCm: 1, widthCm: 1, heightCm: 1 }] }),
    "64000 a 44100, 2 cajas, 8 kg en total",
  );
});

test("groups by calendar day in Monterrey (Hoy, Ayer, Esta semana from Monday, Anteriores) and the quote date label", () => {
  const thu = new Date("2026-11-19T16:00:00Z"); // Thursday in Monterrey
  assert.equal(historyGroup("2026-11-19T06:30:00Z", thu), "Hoy"); // 00:30 Thursday in Monterrey
  assert.equal(historyGroup("2026-11-19T05:30:00Z", thu), "Ayer"); // 23:30 Wednesday in Monterrey, already Thursday in UTC
  assert.equal(historyGroup("2026-11-16T15:00:00Z", thu), "Esta semana"); // Monday
  assert.equal(historyGroup("2026-11-15T15:00:00Z", thu), "Anteriores"); // Sunday of the week before
  const mon = new Date("2026-11-16T16:00:00Z");
  assert.equal(historyGroup("2026-11-14T15:00:00Z", mon), "Anteriores", "on Monday, Saturday is not this week");
  assert.equal(quotedLabel("2026-11-19T04:21:55.804Z"), "Cotizado el 18 nov a las 22:21");
  assert.equal(quotedLabel("2027-01-02T15:05:00Z"), "Cotizado el 2 ene a las 09:05");
});
