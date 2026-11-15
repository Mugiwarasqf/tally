// All money in the app is an integer number of minor units (pence, kobo, cents). Negative = money out.
// The type keeps its historical name; nothing here assumes pounds. The sign comes from the active region.
import { region } from './region';

export type Pence = number;

// Number grouping is the same (1,234.56) in all supported regions; the sign is added by hand so every browser
// shows the same symbol (some locales print "NGN" instead of "₦").
const two = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

export const toPence = (pounds: number): Pence => Math.round(pounds * 100);
export const toPounds = (p: Pence): number => p / 100;

/** The active currency sign: £, ₦ or $. */
export const sym = (): string => region().symbol;

/** £1,234.56 — negatives get a real minus sign. */
export function fmt(p: Pence, opts: { whole?: boolean; sign?: boolean } = {}): string {
  const body = sym() + (opts.whole ? whole.format(Math.abs(Math.round(p / 100))) : two.format(Math.abs(p) / 100));
  if (p < 0 && (!opts.whole || Math.round(p / 100) !== 0)) return `−${body}`;
  return opts.sign && p > 0 ? `+${body}` : body;
}

/** £1.2k / £3.4m for axis ticks and tight spaces. */
export function fmtCompact(p: Pence): string {
  const v = Math.abs(p) / 100;
  const sign = p < 0 ? '−' : '';
  const s = sym();
  if (v >= 1_000_000_000) return `${sign}${s}${trim(v / 1_000_000_000)}bn`;
  if (v >= 1_000_000) return `${sign}${s}${trim(v / 1_000_000)}m`;
  if (v >= 10_000) return `${sign}${s}${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${sign}${s}${trim(v / 1000)}k`;
  return `${sign}${s}${Math.round(v)}`;
}
const trim = (n: number) => String(Math.round(n * 10) / 10);

/**
 * Parse a money string into minor units. Handles £ ₦ $ €, GBP/NGN/USD codes, commas, spaces, (12.00),
 * trailing minus (12.00-), CR/DR/D suffixes and a leading minus.
 * Returns null when the text is not a money amount.
 */
export function parseMoney(input: string): Pence | null {
  let s = input.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/GBP|NGN|USD|EUR|[£₦$€\s]/gi, '');
  if (/(?:DR|D)$/i.test(s)) { neg = true; s = s.replace(/(?:DR|D)$/i, ''); }
  else if (/CR$/i.test(s)) s = s.replace(/CR$/i, '');
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  else if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(s)) return null;
  const p = Math.round(parseFloat(s.replace(/,/g, '')) * 100);
  return neg ? -p : p;
}

/** Round to a tidy budget figure (never below zero): the nearest £5, $5 or ₦5,000. */
export const roundTo5 = (p: Pence): Pence => {
  const step = 500 * region().scale;
  return Math.max(0, Math.round(p / step) * step);
};
