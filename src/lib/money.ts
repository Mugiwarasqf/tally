// All money in the app is an integer number of pence. Negative = money out.
export type Pence = number;

const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const gbpWhole = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });

export const toPence = (pounds: number): Pence => Math.round(pounds * 100);
export const toPounds = (p: Pence): number => p / 100;

/** £1,234.56 — negatives get a real minus sign. */
export function fmt(p: Pence, opts: { whole?: boolean; sign?: boolean } = {}): string {
  const f = opts.whole ? gbpWhole : gbp;
  const body = f.format(Math.abs(opts.whole ? Math.round(p / 100) : p / 100));
  if (p < 0) return `−${body}`;
  return opts.sign && p > 0 ? `+${body}` : body;
}

/** £1.2k / £3.4m for axis ticks and tight spaces. */
export function fmtCompact(p: Pence): string {
  const v = Math.abs(p) / 100;
  const sign = p < 0 ? '−' : '';
  if (v >= 1_000_000) return `${sign}£${trim(v / 1_000_000)}m`;
  if (v >= 10_000) return `${sign}£${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${sign}£${trim(v / 1000)}k`;
  return `${sign}£${Math.round(v)}`;
}
const trim = (n: number) => String(Math.round(n * 10) / 10);

/**
 * Parse a money string into pence. Handles £, commas, spaces, (12.00),
 * trailing minus (12.00-), CR/DR/D suffixes and a leading minus.
 * Returns null when the text is not a money amount.
 */
export function parseMoney(input: string): Pence | null {
  let s = input.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[£$€\s]/g, '');
  if (/(?:DR|D)$/i.test(s)) { neg = true; s = s.replace(/(?:DR|D)$/i, ''); }
  else if (/CR$/i.test(s)) s = s.replace(/CR$/i, '');
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(s)) return null;
  const p = Math.round(parseFloat(s.replace(/,/g, '')) * 100);
  return neg ? -p : p;
}

/** Round to the nearest £5 (never below £0) — used for suggested budgets. */
export const roundTo5 = (p: Pence): Pence => Math.max(0, Math.round(p / 500) * 500);
