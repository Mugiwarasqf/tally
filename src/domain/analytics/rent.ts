import { fmt } from '../../lib/money';
import type { ISODate } from '../../lib/dates';
import type { TxnPatch } from '../import/pair';
import type { Profile, Txn } from '../types';
import type { CatMap } from './aggregate';
import { detectRecurring } from './recurring';

/**
 * Rent, found by its fingerprint rather than by a keyword.
 *
 * A landlord's bank details rarely say "rent", but the payment is unmistakable: the exact same amount, the same
 * payee, paid by bank transfer or standing order (not a card), on a steady day (usually near the start of the
 * month), and usually the biggest regular outgoing. If exactly one payment fits, and nothing else explains it,
 * it's labelled as housing — with modest confidence, so it lands in the review queue for you to confirm.
 */
const MIN_RENT: number = 30_000; // £300
const MAX_RENT: number = 400_000; // £4,000
const CARD = new Set([')))', 'VIS', 'ATM']);
const LOCKED = new Set(['manual', 'rule', 'learned', 'dictionary']);

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;
const stdev = (xs: number[]): number => {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
};

export interface RentCandidate {
  key: string;
  merchant: string;
  amount: number;
  day: number;
  txnIds: string[];
}

/**
 * With a declared rent: every bank-transfer payment of about that amount, grouped by payee; the payee paid most
 * often is the landlord. No rhythm needed, so one month of statements is enough.
 */
function findDeclaredRent(txns: Txn[], amount: number): RentCandidate | null {
  const groups = new Map<string, Txn[]>();
  for (const t of txns) {
    if (t.amount >= 0 || CARD.has(t.type) || t.catSource === 'own' || t.mkey.startsWith('acct ')) continue;
    if (Math.abs(-t.amount - amount) > Math.max(100, amount * 0.02)) continue;
    groups.set(t.mkey, [...(groups.get(t.mkey) ?? []), t]);
  }
  let best: RentCandidate | null = null;
  for (const series of groups.values()) {
    if (series.some((t) => LOCKED.has(t.catSource) && t.categoryId !== 'housing')) continue; // the user said otherwise
    const s = series.sort((a, b) => a.date.localeCompare(b.date));
    const last = s[s.length - 1]!;
    if (!best || s.length > best.txnIds.length) best = { key: `out:${last.mkey}`, merchant: last.merchant, amount, day: median(s.map((t) => Number(t.date.slice(8, 10)))), txnIds: s.map((t) => t.id) };
  }
  return best;
}

/** The payment that most looks like rent, or null. Only series not already explained are considered. */
export function findRent(txns: Txn[], cats: CatMap, asOf: ISODate, profile?: Profile): RentCandidate | null {
  if (profile?.rentAmount) return findDeclaredRent(txns, profile.rentAmount);
  let best: RentCandidate | null = null;
  for (const r of detectRecurring(txns, cats, asOf)) {
    if (r.direction !== 'out' || r.cadence !== 'monthly') continue;
    const mkey = r.key.slice(4); // strip "out:"
    const series = txns.filter((t) => t.mkey === mkey && t.amount < 0);
    if (series.length < 3) continue;
    // Already housing, or decided by the user / a rule / the dictionary: not ours to change.
    if (series.some((t) => LOCKED.has(t.catSource))) continue;
    if (!series.every((t) => t.categoryId === 'family' || t.categoryId === 'unsorted-out')) continue;
    if (series.some((t) => CARD.has(t.type))) continue; // rent isn't paid by card
    const amounts = series.map((t) => -t.amount);
    const m = median(amounts);
    if (m < MIN_RENT || m > MAX_RENT) continue;
    if ((Math.max(...amounts) - Math.min(...amounts)) / m > 0.03) continue; // rent doesn't vary
    const days = series.map((t) => Number(t.date.slice(8, 10)));
    const day = median(days);
    const steady = stdev(days) <= 2.5 || day <= 7 || day >= 24;
    if (!steady) continue;
    if (!best || m > best.amount) best = { key: r.key, merchant: r.merchant, amount: m, day, txnIds: series.map((t) => t.id) };
  }
  return best;
}

export function rentPatternPatches(txns: Txn[], cats: CatMap, asOf: ISODate, profile?: Profile): TxnPatch[] {
  const rent = findRent(txns, cats, asOf, profile);
  if (!rent) return [];
  const declared = !!profile?.rentAmount;
  const byId = new Map(txns.map((t) => [t.id, t]));
  return rent.txnIds
    .filter((id) => { const t = byId.get(id); return t && !LOCKED.has(t.catSource) && !(t.categoryId === 'housing' && t.catSource === 'heuristic'); })
    .map((id) => ({
      id,
      patch: declared
        ? { categoryId: 'housing', catSource: 'heuristic' as const, confidence: 0.8, reason: `Matches the ${fmt(rent.amount)} a month rent you told Tally about.` }
        : {
          categoryId: 'housing', catSource: 'heuristic' as const, confidence: 0.68,
          reason: `The same ${fmt(rent.amount)} to ${rent.merchant} around the ${rent.day}${['th', 'st', 'nd', 'rd'][rent.day % 10 > 3 || [11, 12, 13].includes(rent.day) ? 0 : rent.day % 10]} every month: looks like rent. Confirm if so.`,
        },
    }));
}
