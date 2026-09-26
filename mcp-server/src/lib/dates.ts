/**
 * All date math uses UTC "day numbers" (whole days since 1970-01-01) so that
 * NAV dates never drift across time zones. Public APIs speak ISO `YYYY-MM-DD`.
 */

const DAY_MS = 86_400_000;
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export function ymdToDay(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function isoToDay(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return ymdToDay(y, m, d);
}

export function dayToIso(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** mfapi.in format: `24-09-2026`. */
export function ddmmyyyyToIso(s: string): string {
  const [d, m, y] = s.split('-');
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** AMFI format: `24-Sep-2026`. Returns null when unparseable. */
export function amfiDateToIso(s: string): string | null {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s.trim());
  if (!match) return null;
  const month = MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

/** Today's date in India (NAVs are published on IST business days). */
export function todayIst(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Calendar-aware month arithmetic; clamps the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

export function addYears(iso: string, years: number): string {
  return addMonths(iso, Math.round(years * 12));
}

export function addDays(iso: string, days: number): string {
  return dayToIso(isoToDay(iso) + days);
}

/** Builds the date of `day` in the given month, clamped to the month length. */
export function dateInMonth(y: number, m: number, day: number): string {
  const d = Math.min(day, daysInMonth(y, m));
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Accepts `YYYY-MM-DD` (preferred), `DD-MM-YYYY` or `DD/MM/YYYY` and returns
 * a validated ISO date. Throws a message the LLM can act on.
 */
export function parseDateArg(value: string, field = 'date'): string {
  const s = value.trim();
  let iso: string | null = null;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split('-');
    iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  } else if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(s)) {
    const [d, m, y] = s.split(/[-/]/);
    iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  if (iso) {
    const [y, m, d] = iso.split('-').map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m)) return iso;
  }
  throw new Error(`Invalid ${field} "${value}". Use YYYY-MM-DD.`);
}

export function yearsBetween(fromDay: number, toDay: number): number {
  return (toDay - fromDay) / 365;
}
