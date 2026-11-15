import { addDays, addMonths, cycleRange, diffDays, dow } from '../../lib/dates';
import type { ISODate } from '../../lib/dates';
import { fmt } from '../../lib/money';
import type { Pence } from '../../lib/money';
import type { Txn } from '../types';
import { byCategory, kindOf } from './aggregate';
import type { CatMap } from './aggregate';
import { everyday } from '../../lib/region';

export interface CategoryChange {
  categoryId: string;
  current: Pence;
  previous: Pence;
  delta: Pence;
}

/** Biggest movers between two cycles, by amount (not percent, so £3 → £9 doesn't top the list). */
export function categoryChanges(txns: Txn[], cats: CatMap, key: string, startDay: number, limit = 6): CategoryChange[] {
  const part = (k: string) => {
    const { start, end } = cycleRange(k, startDay);
    return byCategory(txns.filter((t) => t.date >= start && t.date <= end), cats);
  };
  const cur = new Map(part(key).map((c) => [c.categoryId, c.amount]));
  const prev = new Map(part(addMonths(key, -1)).map((c) => [c.categoryId, c.amount]));
  const ids = new Set([...cur.keys(), ...prev.keys()]);
  return [...ids]
    .map((id) => ({ categoryId: id, current: cur.get(id) ?? 0, previous: prev.get(id) ?? 0, delta: (cur.get(id) ?? 0) - (prev.get(id) ?? 0) }))
    .filter((c) => Math.abs(c.delta) >= everyday(5))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit);
}

export interface Flag {
  kind: 'unusual' | 'double';
  txn: Txn;
  other?: Txn;
  note: string;
}

const MONEY_CATS_SKIP = new Set(['cash', 'transport', 'groceries', 'eating-out']);

/**
 * Charges worth a second look: a payment far above what that merchant normally costs,
 * and the same amount charged twice by the same merchant within two days.
 */
export function findFlags(txns: Txn[], cats: CatMap, since: ISODate): Flag[] {
  const flags: Flag[] = [];
  const spend = txns.filter((t) => t.amount < 0 && kindOf(t, cats) === 'expense').sort((a, b) => a.date.localeCompare(b.date));
  const byMerchant = new Map<string, Txn[]>();
  for (const t of spend) (byMerchant.get(t.mkey) ?? byMerchant.set(t.mkey, []).get(t.mkey)!).push(t);

  for (const list of byMerchant.values()) {
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!;
      if (t.date < since) continue;
      const earlier = list.slice(0, i).map((x) => -x.amount);
      if (earlier.length >= 4) {
        const sorted = [...earlier].sort((a, b) => a - b);
        const med = sorted[sorted.length >> 1]!;
        if (-t.amount > med * 2.5 && -t.amount >= everyday(20)) {
          flags.push({ kind: 'unusual', txn: t, note: `Usually about ${fmt(med, { whole: true })} here` });
        }
      }
      const prev = list[i - 1];
      if (prev && prev.amount === t.amount && -t.amount >= everyday(5) && diffDays(prev.date, t.date) <= 2 && !MONEY_CATS_SKIP.has(t.categoryId) && prev.id !== t.id) {
        flags.push({ kind: 'double', txn: t, other: prev, note: 'Same amount charged twice within two days' });
      }
    }
  }
  return flags.sort((a, b) => b.txn.date.localeCompare(a.txn.date));
}

/** Average spend per weekday (Monday first) over the window. */
export function weekdayPattern(txns: Txn[], cats: CatMap, from: ISODate, to: ISODate): Array<{ day: string; average: Pence }> {
  const sums = Array<number>(7).fill(0);
  const counts = Array<number>(7).fill(0);
  for (let d = from; d <= to; d = addDays(d, 1)) counts[(dow(d) + 6) % 7]!++;
  for (const t of txns) {
    if (t.date < from || t.date > to || kindOf(t, cats) !== 'expense') continue;
    sums[(dow(t.date) + 6) % 7]! -= t.amount;
  }
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return names.map((day, i) => ({ day, average: counts[i]! ? Math.round(sums[i]! / counts[i]!) : 0 }));
}

/** Daily spending, for calendar heat maps. */
export function dailySpend(txns: Txn[], cats: CatMap, from: ISODate, to: ISODate): Map<ISODate, Pence> {
  const m = new Map<ISODate, Pence>();
  for (const t of txns) {
    if (t.date < from || t.date > to || kindOf(t, cats) !== 'expense') continue;
    m.set(t.date, (m.get(t.date) ?? 0) - t.amount);
  }
  return m;
}
