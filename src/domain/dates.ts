// Calendar dates as "YYYY-MM-DD" strings, with "today" taken in Monterrey (the business's time zone),
// not in the container's UTC: from 18:00 to 23:59 in Monterrey, UTC is already "tomorrow".

export const BUSINESS_TIME_ZONE = "America/Monterrey";

// Today's date in the business time zone, as YYYY-MM-DD. `now` is injectable for tests.
export function todayInBusinessTz(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// True for a real calendar date in strict YYYY-MM-DD form (rejects 2026-02-30, 2026-2-3, etc.).
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Next business day (Mon-Fri) strictly after today in Monterrey, as YYYY-MM-DD. Holidays are not considered.
// Used to fill ship dates of test requests at run time, so request files never go stale.
export function nextBusinessDayInBusinessTz(now: Date = new Date()): string {
  const [y, m, d] = todayInBusinessTz(now).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  do dt.setUTCDate(dt.getUTCDate() + 1);
  while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6);
  return dt.toISOString().slice(0, 10);
}

// YYYY-MM-DD strings compare correctly as strings.
export function isPastDate(iso: string, now: Date = new Date()): boolean {
  return iso < todayInBusinessTz(now);
}
