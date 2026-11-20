// Ranking of quotes by the user's preference. Pure function over the folded record: it only ever sees
// VERIFIED prices (state.carriers[*].prices), never model text.
import type { Preference } from "../domain/request.js";
import { isIsoDate, todayInBusinessTz } from "../domain/dates.js";
import { computeTotal } from "../domain/money.js";
import type { RunState, VerifiedPrice } from "../record/state.js";
import type { ServiceTerm } from "../carriers/types.js";

export interface DeliveryEstimate {
  minDays: number; // calendar days from the ship date (also for business-day terms, so they compare with site dates)
  maxDays: number;
  // Where the number came from: a date the site gave ("LLEGA EL lun, nov 23"), a number of days in deliveryDays,
  // the carrier's published terms for that service, or the service's name.
  source: "site_date" | "site_delivery_days" | "carrier_terms" | "service_name";
  arrivalDate?: string; // YYYY-MM-DD, only with source "site_date"
  // A guaranteed time ("12:30"), from the published terms or from the site's text ("ENTREGADO POR 14:00").
  byTime?: string;
  // carrier_terms only: the published term as business days, its Spanish label and where it is published.
  businessDays?: { min: number; max: number };
  label?: string;
  sourceUrl?: string;
}

export interface RankedQuote {
  rank: number;
  carrierId: string;
  price: VerifiedPrice;
  comparable: number; // what is compared for price: total for identical parcels, else unit amount
  delivery: DeliveryEstimate | null; // null = the site did not say
  meetsDeadline: boolean | null; // only for by_date; null = unknown
}

const MONTHS: Record<string, number> = {
  ene: 1, enero: 1, feb: 2, febrero: 2, mar: 3, marzo: 3, abr: 4, abril: 4, may: 5, mayo: 5, jun: 6, junio: 6,
  jul: 7, julio: 7, ago: 8, agosto: 8, sep: 9, sept: 9, septiembre: 9, setiembre: 9, oct: 10, octubre: 10,
  nov: 11, noviembre: 11, dic: 12, diciembre: 12,
};
const MONTH = `(${Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|")})\\.?`;
// "<month> <day>" ("lun, nov 23") or "<day> [de] <month>" ("23 de nov"). A weekday before it is ignored; "mar," is
// read as Tuesday because no day number follows it.
const MONTH_DAY = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})\\b`);
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})\\s+(?:de\\s+)?${MONTH}(?![a-z])`);

function daysBetween(fromIso: string, toIso: string): number {
  const ms = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((ms(toIso) - ms(fromIso)) / 86_400_000);
}

// An absolute date in Spanish, as YYYY-MM-DD. The year is the one that puts the date on or after the ship
// date (a "ene 2" seen on Dec 30 is next year). Invalid dates (feb 30) -> null.
export function parseSiteDate(text: string, shipDate: string): string | null {
  const t = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const md = t.match(MONTH_DAY);
  const dm = md ? null : t.match(DAY_MONTH);
  const month = md ? MONTHS[md[1]] : dm ? MONTHS[dm[2]] : undefined;
  const day = md ? Number(md[2]) : dm ? Number(dm[1]) : undefined;
  if (!month || !day) return null;
  const iso = (y: number) => `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const year = Number(shipDate.slice(0, 4));
  const date = iso(year) >= shipDate ? iso(year) : iso(year + 1);
  return isIsoDate(date) ? date : null;
}

function weekday(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
// N business days after the ship date, skipping Saturday and Sunday (holidays are not handled yet).
export function addBusinessDays(iso: string, n: number): string {
  let d = iso;
  for (let counted = 0; counted < n; ) {
    d = addDays(d, 1);
    const w = weekday(d);
    if (w !== 0 && w !== 6) counted++;
  }
  return d;
}

const normName = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
// "ENTREGADO POR 14:00", "antes de las 12:30", "by 10:30" -> "14:00". Only a time introduced as a limit.
function timeIn(text: string): string | undefined {
  const m = normName(text).match(/\b(?:entregado por|por|antes de(?: las)?|by|before)\s+(\d{1,2}):(\d{2})\b/);
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1].padStart(2, "0")}:${m[2]}` : undefined;
}

// Reads a delivery time from what the site wrote. Never guesses: text it does not understand -> null.
// The service's name is used only when the site gave no delivery text at all (deliveryDays null or empty).
// Before the service's name, the carrier's published terms for a service with exactly that name. What the
// quote says always wins over them.
export function parseDelivery(price: Pick<VerifiedPrice, "deliveryDays" | "service">, shipDate: string = todayInBusinessTz(), terms?: ServiceTerm[]): DeliveryEstimate | null {
  const fromText = (s: string): { minDays: number; maxDays: number } | null => {
    const t = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    if (/\b(dia sig|dia siguiente|next day|siguiente dia)\b/.test(t)) return { minDays: 1, maxDays: 1 };
    const range = t.match(/(\d+)\s*(?:-|a|to)\s*(\d+)/);
    if (range) return { minDays: Number(range[1]), maxDays: Number(range[2]) };
    const single = t.match(/(\d+)\s*(?:dias?|days?|d\b)/) ?? t.match(/^\s*(\d+)\s*$/);
    if (single) return { minDays: Number(single[1]), maxDays: Number(single[1]) };
    return null;
  };
  if (price.deliveryDays && price.deliveryDays.trim()) {
    const byTime = timeIn(price.deliveryDays);
    const time = byTime ? { byTime } : {};
    const arrivalDate = parseSiteDate(price.deliveryDays, shipDate);
    if (arrivalDate) {
      const days = daysBetween(shipDate, arrivalDate);
      return { minDays: days, maxDays: days, source: "site_date", arrivalDate, ...time };
    }
    const d = fromText(price.deliveryDays);
    return d ? { ...d, source: "site_delivery_days", ...time } : null;
  }
  const term = terms?.find((t) => normName(t.service) === normName(price.service));
  if (term) {
    return {
      minDays: daysBetween(shipDate, addBusinessDays(shipDate, term.minBusinessDays)),
      maxDays: daysBetween(shipDate, addBusinessDays(shipDate, term.maxBusinessDays)),
      source: "carrier_terms",
      ...(term.guaranteedBy ? { byTime: term.guaranteedBy } : {}),
      businessDays: { min: term.minBusinessDays, max: term.maxBusinessDays },
      label: term.label,
      sourceUrl: term.sourceUrl,
    };
  }
  const d = fromText(price.service);
  return d ? { ...d, source: "service_name" } : null;
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

// The site's arrival date when it gave one; else a calendar-day estimate, conservative: the slowest day (maxDays).
// A range never claims more than it knows: true only if its last day is on time, false only if its
// first day is already late, otherwise null (no badge).
export function meetsDeadline(delivery: DeliveryEstimate | null, deadline: string, shipDate: string): boolean | null {
  if (!delivery) return null;
  if (delivery.arrivalDate) return delivery.arrivalDate <= deadline;
  if (addDays(shipDate, delivery.maxDays) <= deadline) return true;
  if (delivery.minDays !== delivery.maxDays && addDays(shipDate, delivery.minDays) <= deadline) return null;
  return false;
}

// termsOf: a carrier's published service terms (its plugin's serviceTerms); none = as before.
export function rankQuotes(state: RunState, preference?: Preference, now: Date = new Date(), termsOf?: (carrierId: string) => ServiceTerm[] | undefined): RankedQuote[] {
  const priority = preference?.priority ?? "cheapest";
  const shipDate = state.request?.extras?.shipDate ?? todayInBusinessTz(now);
  const count = state.request?.count ?? 1;
  // With identical parcels every row compares totals, never a total against a unit price. A price missing
  // its total.computed gets the same integer-cents total here.
  const comparable = (p: VerifiedPrice) => (count > 1 ? p.total?.total ?? computeTotal(p.amount, count, p.currency).total : p.amount);
  const rows: Omit<RankedQuote, "rank">[] = [];
  for (const [carrierId, c] of Object.entries(state.carriers)) {
    for (const price of c.prices) {
      const delivery = parseDelivery(price, shipDate, termsOf?.(carrierId));
      rows.push({
        carrierId,
        price,
        comparable: comparable(price),
        delivery,
        meetsDeadline: priority === "by_date" && preference?.deadline ? meetsDeadline(delivery, preference.deadline, shipDate) : null,
      });
    }
  }
  const byPrice = (a: Omit<RankedQuote, "rank">, b: Omit<RankedQuote, "rank">) => a.comparable - b.comparable;
  // Unknown delivery sorts after known.
  const days = (r: Omit<RankedQuote, "rank">) => r.delivery?.maxDays ?? Number.POSITIVE_INFINITY;
  const deadlineOrder = (r: Omit<RankedQuote, "rank">) => (r.meetsDeadline === true ? 0 : r.meetsDeadline === null ? 1 : 2);
  // Same day, the earlier guaranteed time first; no guaranteed time after any.
  const time = (r: Omit<RankedQuote, "rank">) => {
    const t = r.delivery?.byTime;
    return t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : 24 * 60;
  };

  rows.sort((a, b) => {
    if (priority === "fastest") return days(a) - days(b) || time(a) - time(b) || byPrice(a, b);
    if (priority === "by_date") return deadlineOrder(a) - deadlineOrder(b) || byPrice(a, b);
    return byPrice(a, b);
  });
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}
