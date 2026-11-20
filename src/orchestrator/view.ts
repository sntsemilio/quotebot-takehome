// Builds what the UI and the conversation show about a quote, from the record only.
// Prices come from verified events; carrier statuses are explained in plain Spanish for Mariana.
import { fold, type RunState } from "../record/state.js";
import type { RunEvent } from "../record/events.js";
import type { ExtraKey } from "../domain/request.js";
import { carriers as registry } from "../carriers/index.js";
import { caveatFor } from "../carriers/types.js";
import { capKind } from "../agent/caps.js";
import { rankQuotes, type RankedQuote } from "./ranking.js";
import { MONEY, normalizeText } from "../domain/money.js";
import { shipmentText } from "../domain/shipment.js";

// An option as the UI shows it. When a verified vatBreakdown backs the VAT, `breakdown` lists the site's
// breakdown lines (the site notes with an amount, plus the two vatBreakdown lines) in the order the evidence shows
// them, and `notices` the other site notes. Without one, `notices` are all the site notes, as before.
export interface OptionView extends RankedQuote {
  breakdown?: { caption: string; lines: string[] };
  notices: string[];
}

// "interrupted": only from interruptView, for a carrier still open in a record that will never finish.
export type CarrierStatus = RunState["carriers"][string]["status"] | "pending" | "interrupted";
export type Priority = "cheapest" | "fastest" | "by_date";

export interface CarrierView {
  carrierId: string;
  name: string;
  status: CarrierStatus;
  label: string; // short status for the chip
  message: string; // plain-language explanation (Spanish)
  detail?: string; // technical reason from the record
  missing?: { field: ExtraKey; label: string; why: string }[];
  evidenceImage?: string;
  caveat?: string; // known doubt about this status on this site (plugin caveat); also appended to message
  // The carrier closed without a price for a reason the user can work around by quoting on the site
  // (MANUAL_STATUSES). Not for missing data (asked in the chat) nor a rejected postal code (the code is wrong).
  manualQuote?: { url: string; label: string };
}

// Statuses whose row offers "Cotizar en el sitio de …" and "Copiar datos del envío".
export const MANUAL_STATUSES: readonly CarrierStatus[] = ["blocked", "failed", "budget_exhausted", "interrupted", "no_coverage"];
export function manualQuoteFor(carrierId: string, status: CarrierStatus): CarrierView["manualQuote"] {
  const plugin = registry[carrierId];
  if (!plugin || !MANUAL_STATUSES.includes(status)) return undefined;
  return { url: plugin.manualUrl ?? plugin.startUrl, label: `Cotizar en el sitio de ${brandOf(plugin.name)}` };
}

// "DHL México" -> "DHL": the site's brand, as the breakdown's caption and the manual-quote link name it.
const brandOf = (name: string) => name.replace(/\s+México$/, "");

export interface ZipResolution {
  zip: string;
  role: "origin" | "destination";
  // What each site wrote next to the postal code (e.g. "CP 64000 MONTERREY, NUEVO LEON"), verbatim.
  // A carrier that rejected this postal code is not counted here, even if its page repeats the code.
  seen: { carrierId: string; text: string }[];
  // Carriers whose site rejected this postal code (carrier.closed rejectedZip), with the site's message when it
  // showed one (a form that just will not continue has no message).
  rejectedBy: { carrierId: string; siteMessage?: string }[];
}

export interface QuoteView {
  runId?: string;
  finished: boolean;
  runStatus?: string;
  request?: RunState["request"];
  shipmentText?: string; // the validated request as lines to paste into a carrier's site (domain/shipment.ts)
  requestErrors?: string[];
  carriers: CarrierView[];
  ranked: OptionView[];
  zips: ZipResolution[];
  priority: Priority; // the order of `ranked` (the user can change it; the server ranks)
  canRankByDate: boolean; // the request had a deadline, so "Llega a tiempo" is an option
  progress: string; // "3 buscando, 2 esperan un dato"
  interrupted?: boolean; // the record has no run.finished and the quote is not running
  // Replay mode only (the record has run.started.replayOf). Set by history.viewOfRecord, which can read the
  // recording to name it; never present for a live quote.
  replayNotice?: string;
}

// The site's breakdown lines in the evidence's order, and the other notices. No arithmetic: the lines are
// the site's text, already verified against the evidence by report_price.
export function optionView(r: RankedQuote, events: RunEvent[], carrierName: string): OptionView {
  const p = r.price;
  if (!p.vatBreakdown) return { ...r, notices: [...p.siteNotes] };
  const withAmount = p.siteNotes.filter((n) => MONEY.test(n));
  const lines = [...withAmount];
  for (const l of [p.vatBreakdown.vatLine, p.vatBreakdown.totalLine]) {
    if (!lines.some((x) => normalizeText(x) === normalizeText(l))) lines.push(l);
  }
  const ev = events.find((e) => e.type === "evidence.captured" && e.evidenceId === p.evidenceId);
  const text = ev?.type === "evidence.captured" ? normalizeText(ev.text) : "";
  const at = (l: string) => {
    const i = text.indexOf(normalizeText(l));
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };
  lines.sort((a, b) => at(a) - at(b)); // stable: lines not found keep their place at the end
  return {
    ...r,
    breakdown: { caption: `Desglose de la página de ${brandOf(carrierName)}`, lines },
    notices: p.siteNotes.filter((n) => !MONEY.test(n)),
  };
}

// What each carrier is doing, in words, from the same statuses the UI shows.
export function progressLine(carriers: CarrierView[], interrupted = false): string {
  const n = (f: (c: CarrierView) => boolean) => carriers.filter(f).length;
  const searching = n((c) => c.status === "running" || c.status === "pending");
  const waiting = n((c) => Boolean(c.missing));
  const quoted = n((c) => c.status === "quoted");
  const stopped = n((c) => c.status === "interrupted");
  const noPrice = carriers.length - searching - waiting - quoted - stopped;
  const parts = [
    searching ? `${searching} buscando` : "",
    quoted ? `${quoted} con precio` : "",
    waiting ? `${waiting} ${waiting === 1 ? "espera" : "esperan"} un dato` : "",
    noPrice ? `${noPrice} sin precio` : "",
    stopped ? `${stopped} sin terminar` : "",
  ].filter(Boolean);
  const line = parts.length ? `${parts.join(", ")}.` : "";
  return interrupted ? `La cotización se detuvo antes de terminar. ${line}`.trim() : line;
}

// A quote whose record has no run.finished and that no process is running any more. Carriers still open
// say so; verified prices stay, under the same warning. Never "Buscando…" for something that is not running.
export const INTERRUPTED_MESSAGE = "La cotización se detuvo antes de terminar.";
export function interruptView(view: QuoteView): QuoteView {
  if (view.finished) return view;
  const carriers = view.carriers.map((c) =>
    c.status === "running" || c.status === "pending"
      ? { ...c, status: "interrupted" as const, label: STATUS_LABEL.interrupted, message: INTERRUPTED_MESSAGE, manualQuote: manualQuoteFor(c.carrierId, "interrupted") }
      : c,
  );
  return { ...view, carriers, interrupted: true, progress: progressLine(carriers, true) };
}

export const EXTRA_LABELS: Record<ExtraKey, string> = {
  shipDate: "fecha de envío",
  deliveryType: "entrega a domicilio o en sucursal",
  customerType: "persona física o moral",
};

// One missing field, as a phrase after "Falta".
const MISSING_ONE: Record<ExtraKey, string> = {
  shipDate: "la fecha de envío",
  deliveryType: "saber si es entrega a domicilio o en sucursal",
  customerType: "saber si envías como persona física o moral",
};

const STATUS_LABEL: Record<CarrierStatus, string> = {
  pending: "En espera",
  running: "Buscando…",
  quoted: "Cotizada",
  blocked: "Bloqueada",
  failed: "Falló",
  no_coverage: "Sin cobertura",
  needs_human: "Necesita un dato",
  interrupted: "Se interrumpió",
  budget_exhausted: "Sin terminar",
};

const ROLE_ES = { origin: "origen", destination: "destino" } as const;

// "{name} no reconoce el código postal de origen 99999. Su página dice: "…"." Shared by the view and the result note.
// Without a site message: the site did not accept the code but showed no error; never invent its words.
export function rejectionSentence(name: string, role: "origin" | "destination", zip: string, siteMessage?: string): string {
  return siteMessage
    ? `${name} no reconoce el código postal de ${ROLE_ES[role]} ${zip}. Su página dice: "${siteMessage}".`
    : `${name} no aceptó el código postal de ${ROLE_ES[role]} ${zip}; su página no mostró un mensaje de error.`;
}
// A "rejection" the site never stated (the form just would not continue) is not presented as a certainty.
// When another site recognized the same code in this quote, that is said too.
export function unconfirmedZipSentence(name: string, zip: string, seenBy?: { name: string; text: string }): string {
  const base = `El formulario de ${name} no continuó con el CP ${zip} y su página no mostró ningún error. Puede ser el CP o su formulario; si tu CP es correcto, cotiza en su sitio.`;
  return seenBy ? `${base} ${seenBy.name} sí lo reconoció: «${seenBy.text}»; parece ser su formulario.` : base;
}
// A rejected postal code without the site's words.
export const isUnconfirmedRejection = (c: RunState["carriers"][string] | undefined): boolean =>
  Boolean(c && c.status === "needs_human" && c.rejectedZip && !c.siteMessage);
export function zipQuestion(role: "origin" | "destination"): string {
  return `¿Me confirmas el código postal de ${ROLE_ES[role]}?`;
}

// Why code stopped a carrier, from its close reason (caps.ts). Unknown reasons read as "took too long".
function unfinished(name: string, reason: string | undefined): string {
  switch (capKind(reason)) {
    case "steps": return `${name} llegó al máximo de intentos que le damos a cada paquetería sin terminar. No tenemos precio de ${name}.`;
    case "cost": return `${name} llegó al límite de gasto por paquetería sin terminar. No tenemos precio de ${name}.`;
    case "stuck": return `${name} se atoró repitiendo la misma acción. No tenemos precio de ${name}.`;
    default: return `${name} tardó demasiado y dejamos de intentar. No tenemos precio de ${name}.`;
  }
}

// A needs_human the agent closed without a rejected postal code is not missing data (its message says it
// could not finish with the data it had), so its chip says so too.
function labelOf(status: CarrierStatus, c: RunState["carriers"][string] | undefined): string {
  if (status === "needs_human" && c && !c.skipped && !c.rejectedZip && c.closedBy === "model") return "No terminó";
  if (isUnconfirmedRejection(c)) return STATUS_LABEL.budget_exhausted; // "Sin terminar"
  return STATUS_LABEL[status];
}

function carrierName(id: string): string {
  return registry[id]?.name ?? id;
}

function explain(
  id: string, c: RunState["carriers"][string] | undefined, request: RunState["request"],
  seenOf: (role: "origin" | "destination") => { carrierId: string; text: string }[] = () => [],
): Pick<CarrierView, "message" | "missing"> {
  const name = carrierName(id);
  if (!c) return { message: `Aún no empezamos con ${name}.` };
  // A rejected postal code is said as such, with the site's own words when it gave some.
  if (c.status === "needs_human" && c.rejectedZip) {
    const zip = (c.rejectedZip === "origin" ? request?.originZip : request?.destZip) ?? "";
    if (!c.siteMessage) {
      // The site never said so; another site that recognized the code in this quote is named.
      const seen = seenOf(c.rejectedZip)[0];
      return { message: unconfirmedZipSentence(name, zip, seen ? { name: carrierName(seen.carrierId), text: seen.text } : undefined) };
    }
    return { message: `${rejectionSentence(name, c.rejectedZip, zip, c.siteMessage)} Revisa el código postal.` };
  }
  const base = explainStatus(name, c);
  return c.siteMessage ? { ...base, message: `${base.message} Su página dice: "${c.siteMessage}".` } : base;
}

function explainStatus(name: string, c: RunState["carriers"][string]): Pick<CarrierView, "message" | "missing"> {
  switch (c.status) {
    case "running":
      return { message: `Estamos llenando el cotizador de ${name}.` };
    case "quoted":
      return { message: `${name} nos dio ${c.prices.length === 1 ? "1 precio" : `${c.prices.length} precios`}, copiados de su página.` };
    case "blocked":
      return { message: `La página de ${name} no dejó consultar de forma automática (protección contra robots). Puedes cotizar directo en su sitio.` };
    case "failed":
      return { message: `La página de ${name} falló o no respondió como esperábamos. No tenemos precio de ${name}.` };
    case "no_coverage":
      return { message: `${name} dice que no da servicio en esa ruta.` };
    case "budget_exhausted":
      return { message: unfinished(name, c.reason) };
    case "needs_human": {
      if (c.skipped) {
        const missing = c.skipped.missing.map((m) => ({ field: m.field, label: EXTRA_LABELS[m.field], why: m.why }));
        // Says which data is missing first ("Falta la fecha de envío").
        const what = missing.length === 1
          ? `Falta ${MISSING_ONE[missing[0].field]}`
          : `Faltan ${missing.length} datos: ${missing.slice(0, -1).map((m) => m.label).join(", ")} y ${missing[missing.length - 1].label}`;
        return { message: `${what}. Si nos lo dices en el chat, cotizamos ${name} aparte.`, missing };
      }
      // The agent stopped on data it had (case 9: a postal code the form would not take), not on missing data.
      if (c.closedBy === "model") return { message: `${name} no pudo terminar con los datos que le dimos.` };
      return { message: `La página de ${name} pidió un dato que no tenemos. Revisa el detalle.` };
    }
  }
}

// Finds what a site wrote next to a postal code in the captured evidence texts ("CP 64000" + next line "MONTERREY, NUEVO LEON").
// Only carriers that quoted count (the site accepted the data and gave a price); an autocomplete suggestion
// such as "99999 Zac., México" on a site that never quoted does not confirm the code.
export function zipMentions(events: RunEvent[], zip: string): { carrierId: string; text: string }[] {
  const out: { carrierId: string; text: string }[] = [];
  const token = new RegExp(`(^|\\D)${zip}(\\D|$)`);
  const carriers = fold(events).carriers;
  for (const e of events) {
    if (e.type !== "evidence.captured") continue;
    if (carriers[e.carrierId]?.status !== "quoted") continue;
    if (out.some((o) => o.carrierId === e.carrierId)) continue;
    const lines = e.text.split("\n").map((l) => l.trim()).filter(Boolean);
    const i = lines.findIndex((l) => token.test(l) && l.length <= 120);
    if (i < 0) continue;
    const short = lines[i].length <= 12 && lines[i + 1] && !/\d{5}/.test(lines[i + 1]);
    out.push({ carrierId: e.carrierId, text: short ? `${lines[i]} ${lines[i + 1]}` : lines[i] });
  }
  return out;
}

// `priority` overrides the request's own priority for the order; "by_date" only applies when the request
// has a deadline, otherwise the request's priority is kept. The server ranks; the client never reorders.
export function buildQuoteView(events: RunEvent[], now: Date = new Date(), opts: { priority?: Priority } = {}): QuoteView {
  const state = fold(events);
  const ids = state.carrierIds.length ? state.carrierIds : Object.keys(state.carriers);
  const req = state.request;
  const zipResolution = (zip: string, role: "origin" | "destination"): ZipResolution => {
    const rejectedBy = ids
      .filter((id) => state.carriers[id]?.rejectedZip === role)
      .map((id) => ({ carrierId: id, ...(state.carriers[id].siteMessage ? { siteMessage: state.carriers[id].siteMessage } : {}) }));
    const seen = zipMentions(events, zip).filter((m) => !rejectedBy.some((r) => r.carrierId === m.carrierId));
    return { zip, role, seen, rejectedBy };
  };
  const zips: ZipResolution[] = req ? [zipResolution(req.originZip, "origin"), zipResolution(req.destZip, "destination")] : [];
  const seenOf = (role: "origin" | "destination") => zips.find((z) => z.role === role)?.seen ?? [];
  const carriers: CarrierView[] = ids.map((id) => {
    const c = state.carriers[id];
    const status: CarrierStatus = c?.status ?? "pending";
    const evidenceImage = c?.evidenceId ? state.evidence[c.evidenceId]?.images[0]?.file : undefined;
    const caveat = c ? caveatFor(registry[id], c.status, c.reason) : undefined;
    const explained = explain(id, c, state.request, seenOf);
    // An unconfirmed rejection gets the buttons to quote on the site, like an unfinished carrier.
    const manualQuote = manualQuoteFor(id, isUnconfirmedRejection(c) ? "budget_exhausted" : status);
    return {
      carrierId: id, name: carrierName(id), status, label: labelOf(status, c), ...explained,
      ...(caveat ? { message: `${explained.message} ${caveat}`, caveat } : {}),
      detail: c?.reason, evidenceImage,
      ...(manualQuote ? { manualQuote } : {}),
    };
  });
  const deadline = req?.preference?.deadline;
  const asked = opts.priority === "by_date" && !deadline ? undefined : opts.priority;
  const priority: Priority = asked ?? req?.preference?.priority ?? "cheapest";
  return {
    runId: state.runId,
    finished: Boolean(state.finished),
    runStatus: state.finished?.status,
    request: req,
    ...(req ? { shipmentText: shipmentText(req) } : {}),
    requestErrors: state.requestErrors,
    carriers,
    ranked: rankQuotes(state, { ...(req?.preference ?? {}), priority }, now, (id) => registry[id]?.serviceTerms).map((r) =>
      optionView(r, events, carriers.find((c) => c.carrierId === r.carrierId)?.name ?? r.carrierId)),
    zips,
    priority,
    canRankByDate: Boolean(deadline),
    progress: progressLine(carriers),
  };
}
