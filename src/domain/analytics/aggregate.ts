import { addDays, addMonths, cycleKey, cycleLabel, cycleRange, fmtDay, weekStart } from '../../lib/dates';
import type { ISODate } from '../../lib/dates';
import type { Pence } from '../../lib/money';
import { bucketOf } from '../categorize/categories';
import type { Account, Category, CategoryKind, Txn } from '../types';

export type CatMap = Map<string, Category>;
export const toCatMap = (cats: Category[]): CatMap => new Map(cats.map((c) => [c.id, c]));

/** Kind of a transaction's category; falls back sensibly if a category was deleted. */
export const kindOf = (t: Txn, cats: CatMap): CategoryKind => cats.get(t.categoryId)?.kind ?? (t.amount < 0 ? 'expense' : 'income');

/**
 * How money is bucketed. Transfers between your own accounts are ignored entirely.
 * Refunds inside an expense category reduce spending rather than counting as income.
 */
export interface Totals {
  income: Pence;
  spent: Pence;
  saved: Pence;
  debt: Pence;
  /** What stayed in your pocket: income − spent − saved − debt payments. */
  left: Pence;
}

export const emptyTotals = (): Totals => ({ income: 0, spent: 0, saved: 0, debt: 0, left: 0 });

export function totals(txns: Txn[], cats: CatMap): Totals {
  const r = emptyTotals();
  for (const t of txns) {
    switch (kindOf(t, cats)) {
      case 'income': r.income += t.amount; break;
      case 'expense': r.spent -= t.amount; break;
      case 'saving': r.saved -= t.amount; break;
      case 'debt': r.debt -= t.amount; break;
      case 'transfer': break;
    }
  }
  r.left = r.income - r.spent - r.saved - r.debt;
  return r;
}

// ---- time buckets ----------------------------------------------------------
export type Grain = 'day' | 'week' | 'month';

export interface Bucket extends Totals {
  key: ISODate; // bucket start
  start: ISODate;
  end: ISODate;
  label: string;
}

export function bucketStart(d: ISODate, grain: Grain, startDay: number): ISODate {
  if (grain === 'day') return d;
  if (grain === 'week') return weekStart(d);
  return cycleRange(cycleKey(d, startDay), startDay).start;
}

const nextBucket = (start: ISODate, grain: Grain, startDay: number): ISODate =>
  grain === 'day' ? addDays(start, 1) : grain === 'week' ? addDays(start, 7) : cycleRange(addMonths(cycleKey(start, startDay), 1), startDay).start;

export function buildSeries(txns: Txn[], cats: CatMap, grain: Grain, from: ISODate, to: ISODate, startDay = 1): Bucket[] {
  const groups = new Map<ISODate, Txn[]>();
  for (const t of txns) {
    if (t.date < from || t.date > to) continue;
    const k = bucketStart(t.date, grain, startDay);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }
  const out: Bucket[] = [];
  for (let s = bucketStart(from, grain, startDay); s <= to; s = nextBucket(s, grain, startDay)) {
    const end = addDays(nextBucket(s, grain, startDay), -1);
    out.push({
      key: s,
      start: s,
      end,
      label: grain === 'month' ? cycleLabel(cycleKey(s, startDay), startDay, true) : fmtDay(s),
      ...totals(groups.get(s) ?? [], cats),
    });
  }
  return out;
}

// ---- breakdowns ------------------------------------------------------------
export interface CategoryTotal {
  categoryId: string;
  amount: Pence; // positive
  count: number;
}

/** Spending (or income) by category for the given transactions, largest first. */
export function byCategory(txns: Txn[], cats: CatMap, kind: 'expense' | 'income' = 'expense'): CategoryTotal[] {
  const m = new Map<string, CategoryTotal>();
  for (const t of txns) {
    if (kindOf(t, cats) !== kind) continue;
    const e = m.get(t.categoryId) ?? { categoryId: t.categoryId, amount: 0, count: 0 };
    e.amount += kind === 'expense' ? -t.amount : t.amount;
    e.count++;
    m.set(t.categoryId, e);
  }
  return [...m.values()].filter((c) => c.amount > 0).sort((a, b) => b.amount - a.amount);
}

export interface MerchantTotal {
  mkey: string;
  merchant: string;
  categoryId: string;
  amount: Pence;
  count: number;
}

export function topMerchants(txns: Txn[], cats: CatMap, limit = 8): MerchantTotal[] {
  const m = new Map<string, MerchantTotal>();
  for (const t of txns) {
    if (kindOf(t, cats) !== 'expense' || t.amount >= 0) continue;
    const e = m.get(t.mkey) ?? { mkey: t.mkey, merchant: t.merchant, categoryId: t.categoryId, amount: 0, count: 0 };
    e.amount -= t.amount;
    e.count++;
    m.set(t.mkey, e);
  }
  return [...m.values()].sort((a, b) => b.amount - a.amount).slice(0, limit);
}

// ---- balance over time ------------------------------------------------------
export interface BalancePoint {
  date: ISODate;
  balance: Pence;
}

/**
 * Combined balance across accounts using the end-of-day balances printed on statements.
 * Each account's last known balance is carried forward, so gaps between statements
 * stay flat instead of dropping to zero. Returns [] when no account prints balances.
 */
export function balanceSeries(txns: Txn[], accounts: Account[], from: ISODate, to: ISODate): BalancePoint[] {
  const perAccount = new Map<string, Map<ISODate, Pence>>();
  for (const t of txns) {
    if (t.balance === undefined) continue;
    (perAccount.get(t.accountId) ?? perAccount.set(t.accountId, new Map()).get(t.accountId)!).set(t.date, t.balance);
  }
  const accts = accounts.filter((a) => perAccount.has(a.id));
  if (!accts.length) return [];
  const out: BalancePoint[] = [];
  const last = new Map<string, Pence>();
  // Seed with the latest balance before the window so the line starts at the right level.
  for (const a of accts) {
    const days = [...perAccount.get(a.id)!.keys()].filter((d) => d < from).sort();
    if (days.length) last.set(a.id, perAccount.get(a.id)!.get(days.at(-1)!)!);
  }
  for (let d = from; d <= to; d = addDays(d, 1)) {
    let total = 0;
    let known = 0;
    for (const a of accts) {
      const v = perAccount.get(a.id)!.get(d);
      if (v !== undefined) last.set(a.id, v);
      if (last.has(a.id)) {
        total += last.get(a.id)!;
        known++;
      }
    }
    if (known) out.push({ date: d, balance: total });
  }
  return out;
}

export const dateRange = (txns: Txn[]): { min: ISODate; max: ISODate } | null => {
  if (!txns.length) return null;
  let min = txns[0]!.date;
  let max = min;
  for (const t of txns) {
    if (t.date < min) min = t.date;
    if (t.date > max) max = t.date;
  }
  return { min, max };
};

// ---- the income stem -------------------------------------------------------------------------
export interface IncomeSplit {
  income: Pence;
  needs: Pence;
  wants: Pence;
  debt: Pence;
  saved: Pence;
  /** Income not yet allocated to anything. Negative when you've spent more than came in. */
  left: Pence;
}

/**
 * Where income went: the same totals as `totals()`, but spending is divided into essentials (needs)
 * and discretionary (wants) using each category's bucket. This is what the income flow diagram draws.
 */
export function incomeSplit(txns: Txn[], cats: CatMap): IncomeSplit {
  const r: IncomeSplit = { income: 0, needs: 0, wants: 0, debt: 0, saved: 0, left: 0 };
  for (const t of txns) {
    const c = cats.get(t.categoryId);
    switch (kindOf(t, cats)) {
      case 'income': r.income += t.amount; break;
      case 'expense': if (bucketOf(c) === 'needs') r.needs -= t.amount; else r.wants -= t.amount; break;
      case 'saving': r.saved -= t.amount; break;
      case 'debt': r.debt -= t.amount; break;
      case 'transfer': break;
    }
  }
  r.left = r.income - r.needs - r.wants - r.debt - r.saved;
  return r;
}
