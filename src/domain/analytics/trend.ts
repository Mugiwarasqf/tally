import { addDays, addMonths, cycleKey, cycleLabel, cycleRange, diffDays } from '../../lib/dates';
import type { CycleKey, ISODate } from '../../lib/dates';
import { fmt } from '../../lib/money';
import type { Pence } from '../../lib/money';
import { ONE_OFF } from '../categorize/categories';
import type { Txn } from '../types';
import { byCategory, dateRange, incomeSplit, totals } from './aggregate';
import type { CatMap } from './aggregate';

/**
 * Spending trend, measured against the history that came BEFORE each month.
 *
 * Each month is compared only with earlier complete months (an "expanding baseline"). Comparing March with an
 * average that includes April would use the future to judge the past, and it would make old months change
 * whenever new statements arrive. With an expanding baseline, "your usual" is what your history said at the
 * time, and it gets sharper as more months are added.
 */
export interface MonthPoint {
  key: CycleKey;
  label: string;
  start: ISODate;
  end: ISODate;
  spent: Pence;
  needs: Pence;
  wants: Pence;
  income: Pence;
  /** The statements cover the whole cycle (within a few days). */
  complete: boolean;
  /** For an unfinished month: spending so far scaled to a full cycle by pace. */
  projected?: Pence;
  /** Mean spend of the earlier complete months. */
  baseline?: Pence;
  /** Standard deviation of those months; the "normal range" is baseline ± sigma. Needs 3+ earlier months. */
  sigma?: Pence;
  /** (value − baseline) ÷ baseline, where value is spent (complete) or projected (unfinished). */
  deviation?: number;
  /** Standard deviations from the baseline. */
  z?: number;
  /** 1 = highest spend so far; `of` is how many months were ranked (including this one). */
  rank?: number;
  of?: number;
}

const TOLERANCE_DAYS = 5;
const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const stdev = (xs: number[]): number => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
};

/**
 * Estimate a full month from part of it. A straight-line pace is misleading when spending is front-loaded
 * (rent on the 1st makes the first days look expensive), so instead ask: in your earlier months, what share
 * of the total had already been spent by this day? Dividing by the median of those shares respects how YOUR
 * months actually run. With fewer than two earlier months it falls back to a straight line.
 */
function projectMonth(spent: Pence, coveredDays: number, prior: MonthPoint[], byCycle: Map<CycleKey, Txn[]>): Pence {
  const cycleDays = (p: MonthPoint) => diffDays(p.start, p.end) + 1;
  const linear = (days: number) => Math.round((spent * days) / coveredDays);
  const shares: number[] = [];
  for (const q of prior) {
    if (q.spent <= 0) continue;
    const cutoff = addDays(q.start, coveredDays - 1);
    const sofar = (byCycle.get(q.key) ?? []).filter((t) => t.date <= cutoff && t.amount < 0).reduce((s, t) => s - t.amount, 0);
    shares.push(Math.min(1, sofar / q.spent));
  }
  const days = prior.length ? cycleDays(prior.at(-1)!) : 30;
  if (shares.length < 2) return linear(days);
  const share = shares.sort((a, b) => a - b)[shares.length >> 1]!;
  // Guard against an extreme share (almost nothing, or everything, spent by now) producing a wild estimate.
  return share >= 0.15 ? Math.round(spent / share) : linear(days);
}

/**
 * Every budget month the data touches, oldest first, each judged against the months before it.
 * One-off categories (visa fees, fines) are left out of the comparison: they are real spending, but a £3,000
 * visa bill says nothing about whether this month's living costs are up or down.
 */
export function spendHistory(all: Txn[], cats: CatMap, startDay: number): MonthPoint[] {
  const range = dateRange(all);
  if (!range) return [];
  const txns = all.filter((t) => !ONE_OFF.has(t.categoryId));
  const byCycle = new Map<CycleKey, Txn[]>();
  for (const t of txns) {
    const k = cycleKey(t.date, startDay);
    (byCycle.get(k) ?? byCycle.set(k, []).get(k)!).push(t);
  }

  const points: MonthPoint[] = [];
  for (let k = cycleKey(range.min, startDay); k <= cycleKey(range.max, startDay); k = addMonths(k, 1)) {
    const { start, end } = cycleRange(k, startDay);
    const part = byCycle.get(k) ?? [];
    const split = incomeSplit(part, cats);
    const complete = start >= addDays(range.min, -TOLERANCE_DAYS) && end <= addDays(range.max, TOLERANCE_DAYS);
    const spent = totals(part, cats).spent;
    const p: MonthPoint = { key: k, label: cycleLabel(k, startDay, true), start, end, spent, needs: split.needs, wants: split.wants, income: split.income, complete };
    if (!complete) {
      const from = start > range.min ? start : range.min;
      const to = end < range.max ? end : range.max;
      const covered = diffDays(from, to) + 1;
      if (covered >= 7) {
        p.projected = projectMonth(spent, covered, points.filter((q) => q.complete), byCycle);
      }
    }
    points.push(p);
  }

  // Judge every month against the complete months that came before it.
  points.forEach((p, i) => {
    const prior = points.slice(0, i).filter((q) => q.complete);
    const value = p.complete ? p.spent : p.projected;
    if (!prior.length || value === undefined) return;
    const spends = prior.map((q) => q.spent);
    p.baseline = Math.round(mean(spends));
    if (prior.length >= 3) {
      p.sigma = Math.round(stdev(spends));
      if (p.sigma > 0) p.z = (value - p.baseline) / p.sigma;
    }
    if (p.baseline > 0) p.deviation = (value - p.baseline) / p.baseline;
    p.rank = 1 + spends.filter((s) => s > value).length;
    p.of = prior.length + 1;
  });
  return points;
}

export interface Trend {
  direction: 'rising' | 'falling' | 'steady';
  /** Least-squares change per month. */
  perMonth: Pence;
  /** perMonth as a share of the average. */
  pct: number;
  months: number;
  r2: number;
  confidence: 'low' | 'fair' | 'good';
}

/** A straight line through the most recent complete months (up to a year). Needs at least three. */
export function trendOf(points: MonthPoint[]): Trend | null {
  const ys = points.filter((p) => p.complete).slice(-12).map((p) => p.spent);
  const n = ys.length;
  if (n < 3) return null;
  const xs = ys.map((_, i) => i);
  const mx = mean(xs);
  const my = mean(ys);
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const sxy = xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0);
  const slope = sxx ? sxy / sxx : 0;
  const ssTot = ys.reduce((s, y) => s + (y - my) ** 2, 0);
  const ssRes = ys.reduce((s, y, i) => s + (y - (my + slope * (xs[i]! - mx))) ** 2, 0);
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  const pct = my > 0 ? slope / my : 0;
  return {
    direction: Math.abs(pct) < 0.015 ? 'steady' : pct > 0 ? 'rising' : 'falling',
    perMonth: Math.round(slope),
    pct,
    months: n,
    r2,
    confidence: n >= 6 && r2 >= 0.5 ? 'good' : n >= 4 && r2 >= 0.25 ? 'fair' : 'low',
  };
}

export interface CategoryTrend {
  categoryId: string;
  current: Pence;
  baseline: Pence;
  delta: Pence;
  pct: number;
  direction: 'up' | 'down' | 'flat';
  /** Recent complete months, then the chosen month last. */
  series: Pence[];
}

/** How each category compares with its own earlier history. Biggest movers (in pounds) first. */
export function categoryTrends(txns: Txn[], cats: CatMap, key: CycleKey, startDay: number, limit = 8): CategoryTrend[] {
  const range = dateRange(txns);
  if (!range) return [];
  const spendIn = (k: CycleKey): Map<string, Pence> => {
    const { start, end } = cycleRange(k, startDay);
    return new Map(byCategory(txns.filter((t) => t.date >= start && t.date <= end), cats).map((c) => [c.categoryId, c.amount]));
  };
  const priorKeys: CycleKey[] = [];
  for (let k = addMonths(key, -1), i = 0; i < 12; k = addMonths(k, -1), i++) {
    const { start, end } = cycleRange(k, startDay);
    if (start >= addDays(range.min, -TOLERANCE_DAYS) && end <= addDays(range.max, TOLERANCE_DAYS)) priorKeys.push(k);
    else if (end < range.min) break;
  }
  if (!priorKeys.length) return [];
  const prior = priorKeys.map(spendIn);
  const cur = spendIn(key);
  const ids = new Set([...cur.keys(), ...prior.flatMap((m) => [...m.keys()])]);
  return [...ids]
    .filter((id) => !ONE_OFF.has(id)) // a one-off has no "usual" to move against
    .map((id) => {
      const baseline = Math.round(mean(prior.map((m) => m.get(id) ?? 0)));
      const current = cur.get(id) ?? 0;
      const delta = current - baseline;
      const pct = baseline > 0 ? delta / baseline : current > 0 ? 1 : 0;
      const series = [...prior].reverse().slice(-5).map((m) => m.get(id) ?? 0).concat(current);
      return { categoryId: id, current, baseline, delta, pct, direction: (pct > 0.1 ? 'up' : pct < -0.1 ? 'down' : 'flat') as CategoryTrend['direction'], series };
    })
    .filter((c) => Math.abs(c.delta) >= 1000)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit);
}

const ordinal = (n: number) => `${n}${[, 'st', 'nd', 'rd'][n % 10 > 3 || [11, 12, 13].includes(n) ? 0 : n % 10] ?? 'th'}`;

/** Plain-English reading of one month against its history, plus the longer-run direction. */
export function describeHistory(p: MonthPoint, trend: Trend | null): string[] {
  const out: string[] = [];
  const value = p.complete ? p.spent : p.projected;
  if (p.baseline === undefined || value === undefined || p.deviation === undefined) {
    return ['There isn’t enough earlier history yet to compare against. Each month you add makes this sharper.'];
  }
  const pct = Math.round(Math.abs(p.deviation) * 100);
  const earlier = (p.of ?? 1) - 1;
  const rel = pct < 3 ? 'in line with' : `${pct}% ${p.deviation > 0 ? 'above' : 'below'}`;
  out.push(`${p.complete ? 'You spent' : 'On pace to spend'} ${fmt(value, { whole: true })}, ${rel} your usual ${fmt(p.baseline, { whole: true })} (the average of ${earlier} earlier month${earlier === 1 ? '' : 's'}).`);
  if (p.z !== undefined) {
    out.push(Math.abs(p.z) < 1 ? 'That sits inside your normal range.' : p.z > 0 ? `That’s ${p.z.toFixed(1)} standard deviations above normal, an unusually expensive month.` : `That’s ${Math.abs(p.z).toFixed(1)} standard deviations below normal, an unusually frugal month.`);
  }
  if (p.rank !== undefined && p.of !== undefined && p.of >= 4) {
    out.push(p.rank === 1 ? `It’s your highest of ${p.of} months.` : p.rank === p.of ? `It’s your lowest of ${p.of} months.` : `It’s the ${ordinal(p.rank)}-highest of ${p.of} months.`);
  }
  if (trend && trend.direction !== 'steady') {
    out.push(`Over the last ${trend.months} months your spending has been ${trend.direction === 'rising' ? 'rising' : 'falling'} by about ${fmt(Math.abs(trend.perMonth), { whole: true })} a month${trend.confidence === 'low' ? ' (a tentative trend)' : ''}.`);
  } else if (trend) {
    out.push('Month to month, your spending has been steady.');
  }
  return out;
}
