import { addDays, addMonths, diffDays, makeDate } from '../../lib/dates';
import type { ISODate } from '../../lib/dates';
import { fmt } from '../../lib/money';
import type { Pence } from '../../lib/money';
import type { PinnedRecurring, Txn } from '../types';
import { kindOf } from './aggregate';
import type { CatMap } from './aggregate';

export type Cadence = 'weekly' | 'fortnightly' | 'monthly' | 'yearly';

export interface Recurring {
  key: string; // merchant key (+ direction)
  merchant: string;
  categoryId: string;
  direction: 'out' | 'in';
  cadence: Cadence;
  /** Median charge, positive pence. */
  amount: Pence;
  lastDate: ISODate;
  nextDate: ISODate;
  occurrences: number;
  /** Every date it was paid, oldest first (one per day). */
  dates: ISODate[];
  /** Typical days between payments. */
  gap: number;
  /** Cost per year at the current cadence and amount. */
  annual: Pence;
  /** Set when the latest charge differs noticeably from the one before. */
  change?: { from: Pence; to: Pence };
  /** Marked as recurring by the user rather than detected. */
  pinned?: boolean;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const CADENCES: Array<{ id: Cadence; min: number; max: number; tol: number; per: number; need: number }> = [
  { id: 'weekly', min: 6, max: 8, tol: 1, per: 52, need: 4 },
  { id: 'fortnightly', min: 13, max: 16, tol: 3, per: 26, need: 3 }, // also catches twice-a-month pay (15th and 30th)
  { id: 'monthly', min: 27, max: 34, tol: 4, per: 12, need: 3 },
  { id: 'yearly', min: 355, max: 375, tol: 10, per: 1, need: 2 },
];

/** The date a payment on this rhythm falls due after `last`. */
export function stepDate(last: ISODate, c: Cadence): ISODate {
  if (c === 'weekly') return addDays(last, 7);
  if (c === 'fortnightly') return addDays(last, 14);
  const key = c === 'monthly' ? addMonths(last.slice(0, 7), 1) : addMonths(last.slice(0, 7), 12);
  const [y, m] = key.split('-').map(Number);
  const dim = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return makeDate(y!, m!, Math.min(Number(last.slice(8, 10)), dim));
}

/**
 * Find payments that repeat on a regular rhythm with similar amounts: subscriptions,
 * rent, bills, salary. Groceries and the like never qualify because their timing and
 * amounts wander. Anything that stopped more than two cycles before `asOf` is treated as lapsed.
 *
 * `asOf` should be the last day your statements cover, not today: with stale statements,
 * today would make every payment look lapsed.
 */
export function detectRecurring(txns: Txn[], cats: CatMap, asOf: ISODate): Recurring[] {
  const groups = new Map<string, Txn[]>();
  for (const t of txns) {
    const kind = kindOf(t, cats);
    if (kind === 'transfer' || kind === 'saving') continue;
    if (cats.get(t.categoryId)?.id === 'cash' || t.type === 'ATM') continue;
    const dir = t.amount < 0 ? 'out' : 'in';
    if (dir === 'in' && kind !== 'income') continue;
    const k = `${dir}:${t.mkey}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }
  const out: Recurring[] = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    // Collapse same-day duplicates so a double swipe doesn't look like a rhythm.
    const days = [...new Map(list.map((t) => [t.date, t])).values()];
    if (days.length < 2) continue;
    const gaps = days.slice(1).map((t, i) => diffDays(days[i]!.date, t.date));
    const mg = median(gaps);
    const cad = CADENCES.find((c) => mg >= c.min && mg <= c.max);
    if (!cad || days.length < cad.need) continue;
    const regular = gaps.filter((g) => Math.abs(g - mg) <= cad.tol).length / gaps.length;
    if (regular < 0.7) continue;
    const amounts = days.map((t) => Math.abs(t.amount));
    const med = median(amounts);
    const spread = Math.sqrt(amounts.reduce((s, a) => s + (a - med) ** 2, 0) / amounts.length) / (med || 1);
    // Weekly or fortnightly pay for shift workers varies with hours, so income gets a looser amount test.
    const looseIncome = key.startsWith('in:') && (cad.id === 'weekly' || cad.id === 'fortnightly');
    if (spread > (looseIncome ? 0.6 : 0.35)) continue;
    const last = days.at(-1)!;
    const next = stepDate(last.date, cad.id);
    if (diffDays(next, asOf) > mg * 2) continue; // lapsed
    const prev = days.at(-2)!;
    const change = Math.abs(Math.abs(last.amount) - Math.abs(prev.amount)) / (Math.abs(prev.amount) || 1) > 0.05
      ? { from: Math.abs(prev.amount), to: Math.abs(last.amount) }
      : undefined;
    out.push({
      key, merchant: last.merchant, categoryId: last.categoryId,
      direction: last.amount < 0 ? 'out' : 'in', cadence: cad.id,
      amount: Math.round(med), lastDate: last.date, nextDate: next, occurrences: days.length,
      dates: days.map((t) => t.date), gap: mg,
      annual: Math.round(med * cad.per), change,
    });
  }
  return out.sort((a, b) => a.nextDate.localeCompare(b.nextDate));
}

const PER: Record<PinnedRecurring['cadence'], { per: number; gap: number }> = { weekly: { per: 52, gap: 7 }, fortnightly: { per: 26, gap: 14 }, monthly: { per: 12, gap: 30 } };

/**
 * Detected payments plus the ones the user marked as recurring. A pinned payment uses the user's cadence and
 * amount, works from a single occurrence, and never lapses on its own: if it stops arriving, that's a missed
 * payment worth flagging, not a reason to drop it.
 */
export function withPinned(detected: Recurring[], pins: PinnedRecurring[], txns: Txn[]): Recurring[] {
  if (!pins.length) return detected;
  const pinned = new Set(pins.map((p) => p.key));
  const out = detected.filter((r) => !pinned.has(r.key));
  for (const p of pins) {
    const mkey = p.key.slice(4);
    const list = txns.filter((t) => t.amount < 0 && t.mkey === mkey).sort((a, b) => a.date.localeCompare(b.date));
    const days = [...new Map(list.map((t) => [t.date, t])).values()];
    const last = days.at(-1);
    if (!last) continue; // nothing on the statements for it (yet)
    out.push({
      key: p.key, merchant: last.merchant, categoryId: last.categoryId, direction: 'out', cadence: p.cadence,
      amount: p.amount, lastDate: last.date, nextDate: stepDate(last.date, p.cadence), occurrences: days.length,
      dates: days.map((t) => t.date), gap: PER[p.cadence].gap, annual: p.amount * PER[p.cadence].per, pinned: true,
    });
  }
  return out.sort((a, b) => a.nextDate.localeCompare(b.nextDate));
}

export interface LikelyRecurring {
  key: string; // "out:<mkey>"
  mkey: string;
  merchant: string;
  categoryId: string;
  count: number;
  lastDate: ISODate;
  /** Latest amount, positive pence. */
  amount: Pence;
  cadence: PinnedRecurring['cadence'];
  /** Plain-English evidence, strongest first. */
  reasons: string[];
  score: number;
}

/** Categories whose payees are usually on a plan or contract. */
const BILL_LIKE: Record<string, string> = {
  bills: 'A phone, energy, broadband or insurance provider',
  subscriptions: 'A subscription service',
  debt: 'A card or loan repayment',
  housing: 'A housing payment',
};
/** Everyday spending: never suggested on its own, however often it happens. */
const EVERYDAY = new Set(['groceries', 'eating-out', 'transport', 'shopping', 'cash', 'family', 'remittance', 'entertainment', 'personal-care', 'gifts', 'fees', 'unsorted-out']);
const STANDING = new Set(['DD', 'SO']);

/**
 * Payees that look like a bill but haven't repeated enough for detection to be sure. Each comes with the evidence
 * so the user decides; nothing is added until they confirm.
 */
export function likelyRecurring(txns: Txn[], cats: CatMap, known: Recurring[], dismissed: string[]): LikelyRecurring[] {
  const skip = new Set([...known.map((r) => r.key), ...dismissed]);
  const groups = new Map<string, Txn[]>();
  for (const t of txns) {
    if (t.amount >= 0 || t.type === 'ATM') continue;
    const kind = kindOf(t, cats);
    if (kind === 'transfer' || kind === 'saving') continue;
    if (skip.has(`out:${t.mkey}`)) continue;
    (groups.get(t.mkey) ?? groups.set(t.mkey, []).get(t.mkey)!).push(t);
  }
  const out: LikelyRecurring[] = [];
  for (const [mkey, list] of groups) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const last = list.at(-1)!;
    const cat = last.categoryId;
    const reasons: string[] = [];
    let score = 0;
    const standing = list.some((t) => STANDING.has(t.type));
    if (standing) { score += 3; reasons.push(list.some((t) => t.type === 'DD') ? 'Paid by Direct Debit' : 'Paid by standing order'); }
    if (EVERYDAY.has(cat) && !standing) continue;
    if (BILL_LIKE[cat]) { score += 2; reasons.push(BILL_LIKE[cat]!); }
    const days = [...new Map(list.map((t) => [t.date, t])).values()];
    const gaps = days.slice(1).map((t, i) => diffDays(days[i]!.date, t.date));
    const g = gaps.length ? median(gaps) : 0;
    const cadence: PinnedRecurring['cadence'] = g >= 6 && g <= 8 ? 'weekly' : g >= 12 && g <= 16 ? 'fortnightly' : 'monthly';
    if (gaps.length && ((g >= 6 && g <= 8) || (g >= 12 && g <= 16) || (g >= 25 && g <= 35))) { score += 1; reasons.push(`Paid ${days.length} times, about ${g} days apart`); }
    const amounts = list.map((t) => -t.amount);
    if (amounts.length >= 2 && amounts.filter((a) => a === amounts.at(-1)).length >= 2) { score += 1; reasons.push(`The same ${fmt(amounts.at(-1)!)} each time`); }
    if (score < 2) continue;
    if (reasons.length && list.length === 1 && !standing) reasons.push('Seen once so far');
    out.push({ key: `out:${mkey}`, mkey, merchant: last.merchant, categoryId: cat, count: list.length, lastDate: last.date, amount: -last.amount, cadence, reasons, score });
  }
  return out.sort((a, b) => b.score - a.score || b.lastDate.localeCompare(a.lastDate));
}

export interface DueItem {
  recurring: Recurring;
  date: ISODate;
  /** Due dates the statements don't reach yet were stepped past, so this one is an expectation, not a record. */
  projected: boolean;
}

/**
 * Outgoing recurring payments due in the `days` after `from` (normally today). When statements end before today,
 * each payment's due date is rolled forward on its rhythm until it reaches `from`, so "coming up" always means
 * coming up from now, not from the last statement.
 */
export function dueSoon(recurring: Recurring[], from: ISODate, days = 30): DueItem[] {
  const to = addDays(from, days);
  const out: DueItem[] = [];
  for (const r of recurring) {
    if (r.direction !== 'out' || r.cadence === 'yearly') continue;
    let d = r.nextDate;
    let projected = false;
    for (let i = 0; i < 60 && d < from; i++) { d = stepDate(d, r.cadence); projected = true; }
    if (d <= to) out.push({ recurring: r, date: d, projected });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Monthly-equivalent cost of a recurring payment. */
export const perMonth = (r: Recurring): Pence =>
  Math.round(r.annual / 12);
