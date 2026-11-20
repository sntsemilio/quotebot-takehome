// deliveryDays is accepted only if what it says is on the page, like priceText. The page shows each
// piece on its own line ("LLEGA EL / vie, nov 20 / ENTREGADO POR / 10:30") and the agent joins them differently in
// each run, so the facts are verified, not the string:
// 1. every date (optional weekday + month + day, the grammar of parseSiteDate) and every time (HH:MM) in the text
//    must appear in the evidence;
// 2. every other word must be a label word or appear in the evidence (separators do not matter);
// 3. a text with no date and no time is accepted only if it appears whole in the evidence and has a letter, so a bare
//    "1", "2" or "--" never passes.
// Known limit: a fact is looked for in the whole page, not in the service's block (FedEx groups several services
// under one "LLEGA EL"); a date given to the wrong service stays possible (NOTES, "siguiente").

const norm = (t: string) =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();

const MONTHS = ["enero", "ene", "febrero", "feb", "marzo", "mar", "abril", "abr", "mayo", "may", "junio", "jun", "julio", "jul",
  "agosto", "ago", "septiembre", "setiembre", "sept", "sep", "octubre", "oct", "noviembre", "nov", "diciembre", "dic"];
const MONTH = `(?:${MONTHS.join("|")})\\.?`;
const WEEKDAY = "(?:lun|mar|mie|jue|vie|sab|dom)[a-z]*\\.?";
// "<weekday> <month> <day>" or "<weekday> <day> [de] <month>", the weekday optional (commas are already spaces).
const DATE = new RegExp(`(?<![a-z0-9])(?:${WEEKDAY} )?(?:${MONTH} \\d{1,2}|\\d{1,2} (?:de )?${MONTH})(?![a-z0-9])`, "g");
const TIME = /(?<![0-9:])\d{1,2}:\d{2}(?![0-9:])/g;
const LABELS = new Set(["llega", "el", "entregado", "entrega", "por", "antes", "de", "las", "a"]);

// A phrase present in the normalized page as whole words.
function onPage(page: string, phrase: string): boolean {
  const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`).test(page);
}

export function deliveryInEvidence(deliveryDays: string, evidenceText: string): boolean {
  const text = norm(deliveryDays);
  const page = norm(evidenceText);
  const dates = text.match(DATE) ?? [];
  const times = text.match(TIME) ?? [];
  if (!dates.length && !times.length) return /\p{L}/u.test(text) && onPage(page, text);
  for (const d of dates) if (!onPage(page, d)) return false;
  for (const t of times) {
    const unpadded = t.replace(/^0(\d:)/, "$1");
    if (!onPage(page, t) && !onPage(page, unpadded) && !onPage(page, unpadded.padStart(5, "0"))) return false;
  }
  const rest = text.replace(DATE, " ").replace(TIME, " ").split(/[^a-z0-9]+/).filter(Boolean);
  return rest.every((w) => /[a-z]/.test(w) && (LABELS.has(w) || onPage(page, w)));
}
