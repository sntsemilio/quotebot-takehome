// "Mis cotizaciones" (DA6): past conversations and their quotes, read from the records already on disk
// (runs/<label>/conversation-*.jsonl and the quote records they name by runId). Nothing new is stored: the list and
// the detail are rebuilt from the files, so they survive a server restart. Prices come only from buildQuoteView
// (verified events), never from the model's text.
import fs from "node:fs";
import path from "node:path";
import { readEvents } from "../record/store.js";
import type { RunEvent } from "../record/events.js";
import type { QuoteRequest } from "../domain/request.js";
import { BUSINESS_TIME_ZONE } from "../domain/dates.js";
import { buildQuoteView, interruptView, type Priority, type QuoteView } from "../orchestrator/view.js";

export type HistoryGroup = "Hoy" | "Ayer" | "Esta semana" | "Anteriores";

export interface ConversationSummary {
  id: string;
  title: string; // from the last validated request (cities when a site confirmed them), else the first message
  line: string; // first option and its price from the verified view, or the quote's state
  startedAt: string;
  updatedAt: string;
  group: HistoryGroup;
  route?: string; // "Monterrey a Tijuana" or "64000 a 22000": for the empty-state suggestions
  routeZips?: { origin: string; destination: string }; // what a suggestion writes in the composer
}

export type TimelineItem =
  | { kind: "user" | "assistant"; text: string; t: string }
  | { kind: "quote"; runId: string; quotedAt: string | null; quotedLabel: string | null; view: QuoteView | null; note: string | null };

export interface ConversationDetail {
  id: string;
  title: string;
  startedAt: string;
  updatedAt: string;
  firstMessage: string; // for "Cotizar de nuevo"
  items: TimelineItem[];
}

export interface HistoryOptions {
  // Whether a quote is still running in this process. A record without run.finished that is not running was
  // Interrupted. Default: nothing runs (records read from disk only).
  isRunning?: (runId: string) => boolean;
  priority?: Priority; // order of the options
}

const CONVERSATION_ID = /^conversation-[\w.-]+$/;
const RUN_ID = /^[\w.-]+$/;
const NOTE_PREFIX = "[result note] ";
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

type Turn = Extract<RunEvent, { type: "conversation.turn" }>;

// Calendar date and time in Monterrey for an instant.
function localParts(d: Date): { date: string; y: number; m: number; day: number; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, y: Number(parts.year), m: Number(parts.month), day: Number(parts.day), time: `${parts.hour}:${parts.minute}` };
}

// "Cotizado el 18 nov a las 22:21" (Monterrey time): prices change, so a past quote always says when it was made.
export function quotedLabel(iso: string): string {
  const p = localParts(new Date(iso));
  return `Cotizado el ${p.day} ${MONTHS[p.m - 1]} a las ${p.time}`;
}

const dayNumber = (isoDate: string) => {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

// Hoy, Ayer, Esta semana (from Monday) or Anteriores, by calendar day in Monterrey.
export function historyGroup(iso: string, now: Date): HistoryGroup {
  const today = dayNumber(localParts(now).date);
  const day = dayNumber(localParts(new Date(iso)).date);
  const diff = today - day;
  if (diff <= 0) return "Hoy";
  if (diff === 1) return "Ayer";
  const weekday = (new Date(today * 86_400_000).getUTCDay() + 6) % 7; // Monday = 0
  return diff <= weekday ? "Esta semana" : "Anteriores";
}

// When the prices were read. A replay re-emits another record: its prices are from the original run (replayOf), so
// "Cotizado el…" uses that run's start, not the replay's. The original is looked up as recorded, then in
// results/<label>/ (the copy that travels with the code); if neither exists, the replay's own start is used.
export function quoteStartedAt(events: RunEvent[]): string | null {
  const started = events.find((e) => e.type === "run.started");
  const own = started?.t ?? events[0]?.t ?? null;
  return recordingOf(events)?.find((e) => e.type === "run.started")?.t ?? own;
}

// The recording a replay re-emits (run.started.replayOf), as recorded or in results/<label>/; null when the record is
// not a replay or the recording cannot be read.
function recordingOf(events: RunEvent[]): RunEvent[] | null {
  const started = events.find((e) => e.type === "run.started");
  const replayOf = started?.type === "run.started" ? started.replayOf : undefined;
  if (!replayOf) return null;
  for (const file of [replayOf, path.join("results", path.basename(path.dirname(replayOf)), path.basename(replayOf))]) {
    try {
      if (fs.existsSync(file)) return readEvents(file);
    } catch {
      // an unreadable recording: try the next place
    }
  }
  return null;
}

// In replay mode every request replays the same recording, so each quote says so above its prices, naming
// the recording ("Monterrey a Tijuana, 4 cajas de 10 kg"). Undefined for a live quote (no replayOf).
export function replayNotice(events: RunEvent[]): string | undefined {
  const started = events.find((e) => e.type === "run.started");
  if (started?.type !== "run.started" || !started.replayOf) return undefined;
  const recording = recordingOf(events);
  const request = recording?.find((e) => e.type === "request.validated");
  const title = request?.type === "request.validated" ? requestTitle(request.request, buildQuoteView(recording!)) : null;
  return `Reproducción de una cotización grabada${title ? ` (${title})` : ""}. No corresponde a lo que pediste: en modo réplica no se consultan los sitios.`;
}

const kg = (n: number) => n.toLocaleString("es-MX", { maximumFractionDigits: 2 });
const SMALL_WORDS = new Set(["de", "del", "la", "las", "los", "el", "y"]);

// The city a quoting site wrote next to a postal code ("CP 64000 MONTERREY, NUEVO LEON" -> "Monterrey"), or null
// when the text does not look like a place name.
export function cityFrom(seenText: string, zip: string): string | null {
  const raw = seenText.replace(/\bC\.?P\.?\b/gi, " ").replace(zip, " ").split(",")[0].replace(/\s+/g, " ").trim();
  if (!/^[\p{L} .'-]{3,40}$/u.test(raw)) return null;
  return raw
    .toLowerCase()
    .split(" ")
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

// "Monterrey a Tijuana" when quoting sites confirmed the codes; each side falls back to its postal code.
export function routeOf(r: QuoteRequest, view?: QuoteView | null): string {
  const side = (zip: string, role: "origin" | "destination") => {
    const seen = view?.zips.find((z) => z.role === role && z.zip === zip)?.seen[0];
    return (seen && cityFrom(seen.text, zip)) || zip;
  };
  return `${side(r.originZip, "origin")} a ${side(r.destZip, "destination")}`;
}

// "Monterrey a Tijuana, 4 cajas de 10 kg" / "64000 a 97000, 1 caja de 3 kg" / "…, 3 cajas, 12 kg en total".
export function requestTitle(r: QuoteRequest, view?: QuoteView | null): string {
  const route = routeOf(r, view);
  if (r.parcels.length > 1) return `${route}, ${r.parcels.length} cajas, ${kg(r.parcels.reduce((s, p) => s + p.weightKg, 0))} kg en total`;
  const n = r.count ?? 1;
  return `${route}, ${n} ${n === 1 ? "caja" : "cajas"} de ${kg(r.parcels[0]?.weightKg ?? 0)} kg`;
}

function shorten(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

const money = (n: number, currency: string) => `${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

// The short line under a title: the first option with its price as the site showed it (and the total for identical
// boxes), or the state of the quote.
export function summaryLine(view: QuoteView | null): string {
  if (!view) return "Sin cotización";
  if (view.interrupted) return "Se interrumpió";
  if (!view.finished) return "Cotizando…";
  const first = view.ranked[0];
  if (first) {
    const carrier = view.carriers.find((c) => c.carrierId === first.carrierId)?.name ?? first.carrierId;
    const service = first.price.service;
    const name = service.toLowerCase().startsWith(carrier.split(/\s+/)[0].toLowerCase()) ? service : `${carrier.split(/\s+/)[0]} ${service}`;
    const count = view.request?.count ?? 1;
    const price = count > 1 && first.price.total
      ? `${money(first.price.total.total, first.price.currency)} por ${count} cajas`
      : `${first.price.priceText} ${first.price.currency}`;
    return `${name}: ${price}`;
  }
  const rejected = view.zips.some((z) => z.rejectedBy.length);
  if (!rejected && view.carriers.some((c) => c.missing)) return "Necesita un dato";
  return "Sin precio";
}

function turnsOf(file: string): Turn[] {
  return readEvents(file).filter((e): e is Turn => e.type === "conversation.turn");
}

function readQuote(dir: string, runId: string): { events: RunEvent[]; startedAt: string | null } | null {
  if (!RUN_ID.test(runId)) return null;
  const file = path.join(dir, `${runId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  try {
    const events = readEvents(file);
    return { events, startedAt: quoteStartedAt(events) };
  } catch {
    return null;
  }
}

// The view as it was: ship-date-relative numbers (days to arrival) use the day it was quoted, not today. A record
// without run.finished that is not running in this process is shown as interrupted.
export function viewOfRecord(runId: string, events: RunEvent[], startedAt: string | null, opts: HistoryOptions = {}): QuoteView {
  const built = buildQuoteView(events, startedAt ? new Date(startedAt) : new Date(), { priority: opts.priority });
  const notice = replayNotice(events);
  const view = notice ? { ...built, replayNotice: notice } : built;
  return !view.finished && !(opts.isRunning?.(runId) ?? false) ? interruptView(view) : view;
}

function runIdsOf(turns: Turn[]): string[] {
  return [...new Set(turns.map((t) => t.runId).filter((r): r is string => Boolean(r)))];
}

// One shipment = same origin, destination, boxes and count. A follow-up for other carriers is the same
// shipment; a corrected postal code is a new one.
function sameShipment(a: QuoteRequest, b: QuoteRequest): boolean {
  return a.originZip === b.originZip && a.destZip === b.destZip && (a.count ?? 1) === (b.count ?? 1) && JSON.stringify(a.parcels) === JSON.stringify(b.parcels);
}

function summarize(dir: string, id: string, turns: Turn[], now: Date, opts: HistoryOptions): ConversationSummary {
  const firstUser = turns.find((t) => t.role === "user")?.text ?? "";
  // The latest quote of the conversation sets the shipment (a corrected postal code makes a new one).
  const views: QuoteView[] = [];
  for (const runId of runIdsOf(turns)) {
    const q = readQuote(dir, runId);
    if (q) views.push(viewOfRecord(runId, q.events, q.startedAt, opts));
  }
  const latest = views[views.length - 1] ?? null;
  // The summary is the shipment's, not its last quote's: a follow-up for Redpack and UPS without prices does
  // not turn the conversation into "Sin precio" nor lose the cities another quote of the same shipment confirmed.
  const shipment = latest?.request ? views.filter((v) => v.request && sameShipment(v.request, latest.request!)) : [];
  const priced = [...shipment].reverse().find((v) => v.finished && v.ranked.length);
  const view = latest && latest.request
    ? { ...latest, zips: latest.zips.map((z) => ({ ...z, seen: shipment.flatMap((v) => v.zips.find((x) => x.role === z.role && x.zip === z.zip)?.seen ?? []) })) }
    : latest;
  const updatedAt = turns[turns.length - 1].t;
  return {
    id,
    title: view?.request ? requestTitle(view.request, view) : shorten(firstUser) || "Conversación sin mensajes",
    line: summaryLine(priced ?? latest),
    startedAt: turns[0].t,
    updatedAt,
    group: historyGroup(updatedAt, now),
    ...(view?.request ? { route: routeOf(view.request, view), routeZips: { origin: view.request.originZip, destination: view.request.destZip } } : {}),
  };
}

// Every conversation in `dir`, the most recently active first. Unreadable files are skipped, not fatal.
export function listConversations(dir: string, now: Date = new Date(), opts: HistoryOptions = {}): ConversationSummary[] {
  if (!fs.existsSync(dir)) return [];
  const out: ConversationSummary[] = [];
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(/^(conversation-[\w.-]+)\.jsonl$/);
    if (!m) continue;
    try {
      const turns = turnsOf(path.join(dir, name));
      if (turns.length) out.push(summarize(dir, m[1], turns, now, opts));
    } catch {
      // a broken record must not hide the others
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

// The conversation's messages in order, with each quote placed right after the reply that started it, its view
// rebuilt from its record and its note exactly as recorded in the "[result note]" turn. Tool turns are not shown.
export function getConversation(dir: string, id: string, now: Date = new Date(), opts: HistoryOptions = {}): ConversationDetail | null {
  if (!CONVERSATION_ID.test(id)) return null;
  const file = path.join(dir, `${id}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const turns = turnsOf(file);
  if (!turns.length) return null;
  const notes = new Map<string, string>();
  for (const t of turns) if (t.runId && t.role === "assistant" && t.text.startsWith(NOTE_PREFIX)) notes.set(t.runId, t.text.slice(NOTE_PREFIX.length));
  const placed = new Set<string>();
  const quoteItem = (runId: string): TimelineItem => {
    placed.add(runId);
    const q = readQuote(dir, runId);
    return {
      kind: "quote", runId, quotedAt: q?.startedAt ?? null, quotedLabel: q?.startedAt ? quotedLabel(q.startedAt) : null,
      view: q ? viewOfRecord(runId, q.events, q.startedAt, opts) : null, note: notes.get(runId) ?? null,
    };
  };
  const items: TimelineItem[] = [];
  for (const t of turns) {
    if (t.role === "tool" || t.text.startsWith(NOTE_PREFIX)) continue;
    items.push({ kind: t.role, text: t.text, t: t.t });
    if (t.role === "assistant" && t.runId && !placed.has(t.runId)) items.push(quoteItem(t.runId));
  }
  // A quote whose starting reply was never recorded (the turn failed) still shows, at the end.
  for (const runId of runIdsOf(turns)) if (!placed.has(runId)) items.push(quoteItem(runId));
  const summary = summarize(dir, id, turns, now, opts);
  return {
    id, title: summary.title, startedAt: summary.startedAt, updatedAt: summary.updatedAt,
    firstMessage: turns.find((t) => t.role === "user")?.text ?? "", items,
  };
}
