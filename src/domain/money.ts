// Normalizes and compares price texts as they appear on carrier sites ("$1,234.50", "1 234,50 MXN", NBSPs...).

// Collapses the whitespace variants sites use (NBSP, narrow NBSP, tabs, newlines) and lowercases,
// so "containment" checks are not defeated by invisible formatting.
export function normalizeText(s: string): string {
  return s.replace(/[   \s]+/g, " ").trim().toLowerCase();
}

// Extracts the first amount in a price text. Returns null if there is no number.
// Separator rule: the last "." or "," is decimal only when followed by 1-2 digits; otherwise all separators are thousands.
export function parseAmount(text: string): number | null {
  const m = text.replace(/[    ]/g, "").match(/\d[\d.,]*/);
  if (!m) return null;
  const t = m[0].replace(/[.,]+$/, "");
  const dec = Math.max(t.lastIndexOf("."), t.lastIndexOf(","));
  if (dec < 0) return Number(t);
  const frac = t.slice(dec + 1);
  if (frac.length === 1 || frac.length === 2) {
    return Number(`${t.slice(0, dec).replace(/[.,]/g, "")}.${frac}`);
  }
  return Number(t.replace(/[.,]/g, ""));
}

// Total for N identical parcels, computed in integer cents (no float drift). Returns the formula as text
// so the record shows how the number was obtained.
export function computeTotal(unitAmount: number, count: number, currency: string): { total: number; formula: string } {
  const cents = Math.round(unitAmount * 100) * count;
  const total = cents / 100;
  const fmt = (n: number) => n.toFixed(2);
  return { total, formula: `${count} x ${fmt(unitAmount)} ${currency} = ${fmt(total)} ${currency}` };
}

export function amountsMatch(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.01;
}

// An amount in a text: "$" before a number, a number with "MXN" or "pesos", "MXN" before a number, or a number with
// 2 decimals that is not a weight or a size. The word "peso" alone (weight) is not money.
// Used for the chat replies and the result note (no amounts there) and the price breakdown lines in the view.
export const MONEY = /\$\s?\d|\d\s*(?:mxn|pesos?)\b|\bmxn\s*\$?\s*\d|\d[\d,]*\.\d{2}\b(?!\s*(?:kg|kgs|kilos?|lb|lbs|cm|cms|in|g)\b)/i;

// Lines that look like money: "$", "MXN", or a number with 2 decimals. Used to build evidence excerpts.
export const MONEY_LINE = /\$|mxn|\d[\d.,]*[.,]\d{2}\b/i;

// A price text must have a digit and a price shape: "$", "MXN" or a number with 2 decimals.
// Rejects bare numbers like "10", which could match a weight ("10 kg") or a postal code.
export function looksLikePrice(priceText: string): boolean {
  return /\d/.test(priceText) && MONEY_LINE.test(priceText);
}

// True if `priceText` appears in `evidenceText` (after normalization) as a whole token: the characters
// right before and after it are not a digit, nor a separator that is part of a number ("1.10", "10,5").
// A separator NOT touching a digit (e.g. a sentence-ending period after "$350") is allowed.
export function textContainsToken(evidenceText: string, priceText: string): boolean {
  const hay = normalizeText(evidenceText);
  const needle = normalizeText(priceText);
  if (!needle) return false;
  const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
  const isSep = (c: string | undefined) => c === "." || c === ",";
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const b1 = hay[i - 1], b2 = hay[i - 2];
    const a1 = hay[i + needle.length], a2 = hay[i + needle.length + 1];
    const badBefore = isDigit(b1) || (isSep(b1) && isDigit(b2));
    const badAfter = isDigit(a1) || (isSep(a1) && isDigit(a2));
    if (!badBefore && !badAfter) return true;
  }
  return false;
}
