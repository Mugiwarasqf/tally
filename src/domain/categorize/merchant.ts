import { DEFAULT_CATEGORIES } from './categories';
import type { CompiledDict } from './dictionary';
import { DICTIONARY, REGION_DICTIONARY } from './dictionary';
import { region } from '../../lib/region';

const KIND = new Map(DEFAULT_CATEGORIES.map((c) => [c.id, c.kind]));
/** Card payments: the second statement line is the merchant's registered city (Uber says "London" everywhere), not useful detail. */
const CARD = new Set(['VIS', ')))']);

/** A statement description turned into something readable plus a stable key to learn against. */
export interface Described {
  merchant: string; // display name
  mkey: string; // normalised key — rules and learning match on this
  payee: string; // cleaned first meaningful line (people's names live here)
  detail: string; // reference / location
  raw: string;
  fx?: string;
  /** Clock time when the statement prints one (cash machines, Post Office counters): "17:18". */
  time?: string;
  /** Location as printed: the town on a card row, or the machine/branch on a cash row. */
  place?: string;
  /** Sort code + account number when a TFR names another account. */
  otherAccount?: string;
  dict?: CompiledDict;
  /** Upper-cased text of every line, for keyword checks. */
  haystack: string;
}

const FX_RE = /^([A-Z]{3}) ([\d,]+\.\d{2}) @ ([\d.]+)$/;
const ACCT_RE = /^(\d{6})\s+(\d{8})$/;
const TIME_RE = /^(.*?)[,\s]*@\s?(\d{1,2}:\d{2})\b/; // "HFX MANCHES@17:18", "TESCO MANCH @20:31"
const PLACE_RE = /^[A-Za-z][A-Za-z ,'&-]{1,24}$/; // a town, not a reference, phone number or web address

/** Time and place, when the statement prints them. */
function whenWhere(type: string, lines: string[]): { time?: string; place?: string } {
  for (const l of lines) {
    const m = TIME_RE.exec(l);
    if (m) return { time: m[2]!.padStart(5, '0'), place: titleCase(m[1]!.trim()) || undefined };
  }
  // Card rows: the line after the merchant is the town the merchant is registered in.
  if (CARD.has(type)) {
    const town = lines.slice(1).find((l) => PLACE_RE.test(l) && !/^visa rate$/i.test(l) && !/^INT'L/i.test(l));
    if (town) return { place: titleCase(town) };
  }
  return {};
}

const clean = (s: string): string =>
  s
    .replace(/^(?:SUMUP|SQ|ZETTLE_?|PAYPAL|PP|IZ)\s*\*\s*/i, '') // payment-processor prefixes
    .replace(/\b(?=[A-Z0-9]*\d)[A-Z0-9]{8,}\b/g, '') // long reference codes
    .replace(/\s+-\s*\d+$/, '') // "POUNDLAND LTD - 19"
    .replace(/\s+\d{2,}$/, '') // "ASDA STORES 4788"
    .replace(/\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const titleCase = (s: string): string => {
  if (s !== s.toUpperCase() && s !== s.toLowerCase()) return s; // already mixed case
  return s.toLowerCase().replace(/(^|[\s\-/(])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
};

export const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Look a description up in the built-in dictionary, honouring money direction. A spending entry never
 * explains money coming IN ("SMITH J | Food" is a person paying you back, not groceries); those fall through
 * to the income heuristics (refund, person, salary).
 */
export function lookup(haystack: string, amount: number): CompiledDict | undefined {
  const dir = amount >= 0 ? 'in' : 'out';
  return [...(REGION_DICTIONARY[region().id] ?? []), ...DICTIONARY].find((d) => {
    if (d.dir) return d.dir === dir && d.re.test(haystack);
    if (dir === 'in' && KIND.get(d.category) === 'expense') return false;
    return d.re.test(haystack);
  });
}

export function describe(type: string, rawLines: string[], amount: number): Described {
  let fx: string | undefined;
  const lines = rawLines
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => {
      const m = FX_RE.exec(l);
      if (m) {
        fx = l;
        return false;
      }
      return !/^visa rate$/i.test(l);
    });
  const raw = rawLines.join(' | ');
  const haystack = lines.join(' ').toUpperCase();
  const base = { raw, fx, haystack, ...whenWhere(type, lines) };

  // Transfer naming another account: "112233 12345678 / INTERNET TRANSFER"
  const acct = ACCT_RE.exec(lines[0] ?? '');
  if (acct) {
    const sc = acct[1]!;
    const num = acct[2]!;
    return {
      ...base,
      merchant: `Transfer · ${sc.slice(0, 2)}-${sc.slice(2, 4)}-${sc.slice(4)} ${num}`,
      mkey: `acct ${sc} ${num}`,
      payee: '',
      detail: lines.slice(1).join(' · '),
      otherAccount: `${sc} ${num}`,
    };
  }

  if (type === 'ATM' || /^CASH (IN|OUT)?\s?P\.?O\./i.test(lines[0] ?? '') || /^CASH IN\b/i.test(lines[0] ?? '')) {
    const dep = amount > 0;
    // Time and place are already picked out of these lines; the raw text stays on the transaction for the details view.
    return { ...base, merchant: dep ? 'Cash deposit' : 'Cash withdrawal', mkey: dep ? 'cash deposit' : 'cash withdrawal', payee: '', detail: '' };
  }

  if (/NON-?STERLING/i.test(haystack)) {
    return { ...base, merchant: 'Non-sterling transaction fee', mkey: 'non sterling fee', payee: '', detail: '' };
  }

  // First line that is a real name, not a card-network reference ("INT'L 0063509621").
  const candidates = lines.filter((l) => !/^INT'L\s+\d+$/i.test(l));
  let idx = 0;
  let payee = '';
  for (; idx < candidates.length; idx++) {
    payee = clean(candidates[idx]!);
    if (payee && /[A-Za-z]{2}/.test(payee)) break;
    payee = '';
  }
  if (!payee) payee = clean(candidates[0] ?? '') || 'Unknown';

  const dict = lookup(haystack, amount);
  // Card rows for a recognised merchant: the remaining lines are its town or web address, already captured as `place`.
  const detail = dict && CARD.has(type) ? '' : candidates.slice(idx + 1).join(' · ');
  const merchant = dict?.name ?? titleCase(payee);
  const mkey = slug(dict?.name ?? payee) || slug(raw) || 'unknown';
  return { ...base, merchant, mkey, payee, detail, dict };
}
