import { addDays, diffDays } from '../../lib/dates';
import type { CycleKey, ISODate } from '../../lib/dates';
import { fmt, roundTo5 } from '../../lib/money';
import type { Pence } from '../../lib/money';
import type { ReportSnapshot, Txn } from '../types';
import type { CatMap } from './aggregate';
import type { CycleView } from './budget';
import type { AccountCoverage, Span } from './coverage';
import type { Schedule } from './schedule';
import { categoryTrends, describeHistory, trendOf } from './trend';
import type { CategoryTrend, MonthPoint, Trend } from './trend';

/**
 * The month-end report card.
 *
 * Each dimension turns a deviation from plan into a 0–100 score by interpolating between control points
 * (so 4.9% over and 5.1% over score almost the same, not a letter apart), and the overall grade is the
 * weighted average of the dimensions that apply. Dimensions that don't apply (no debt, no savings goal)
 * are left out and the remaining weights are rescaled.
 */
export type DimKey = 'spending' | 'categories' | 'history' | 'savings' | 'debt' | 'bills';

export interface Dimension {
  key: DimKey;
  label: string;
  weight: number;
  score: number;
  grade: string;
  /** One line explaining the grade. */
  detail: string;
}

export type CatStatus = 'under' | 'on' | 'over' | 'unbudgeted';

export interface CategoryResult {
  categoryId: string;
  planned: Pence; // already adjusted for how much of the month the statements cover
  actual: Pence;
  variance: Pence; // actual − planned
  status: CatStatus;
  score: number;
  grade: string;
  drivers: Array<{ merchant: string; amount: Pence; count: number }>;
}

export interface WaterfallStep { label: string; value: Pence; kind: 'total' | 'delta' }
export interface Badge { key: string; label: string; icon: string; detail: string }
export interface Suggestion { categoryId: string; from: Pence; to: Pence; reason: string }

export interface AccountCover {
  accountId: string;
  name: string;
  share: number; // 0..1 of the month's days covered
  missing: Span[];
}

export interface ReportCard {
  month: CycleKey;
  start: ISODate;
  end: ISODate;
  /** The statements don't cover the whole month, so budgets were scaled to the days covered. */
  provisional: boolean;
  coverage: { share: number; accounts: AccountCover[] };
  hasPlan: boolean;
  overall: { score: number; grade: string } | null;
  dims: Dimension[];
  categories: CategoryResult[];
  planned: Pence;
  actual: Pence;
  waterfall: WaterfallStep[];
  /** The headline comparison: this month against everything before it. */
  history: { point: MonthPoint | null; trend: Trend | null; lines: string[]; categories: CategoryTrend[]; points: MonthPoint[] };
  /** Spending below (positive) or above (negative) your usual for the days covered. The cost-cutting scoreboard. */
  vsUsual: Pence | null;
  badges: Badge[];
  comment: string[];
  suggestions: Suggestion[];
  previous?: { score: number; grade: string; delta: number };
}

// ---- scoring ------------------------------------------------------------------------------
type Points = Array<[x: number, y: number]>;

/** Straight-line interpolation between control points (sorted by x), clamped at both ends. */
export function interpolate(points: Points, x: number): number {
  if (x <= points[0]![0]) return points[0]![1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x0, y0] = points[i - 1]!;
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points.at(-1)![1];
}

/** Fraction over plan → score. 0% over = 100; 5% = 90 (A-); 10% = 80 (B-); 20% = 70; 35% = 60; 100% = 0. */
const OVER: Points = [[0, 100], [0.05, 90], [0.1, 80], [0.2, 70], [0.35, 60], [0.6, 30], [1, 0]];
/** Share of a target achieved → score. */
const ACHIEVED: Points = [[0, 0], [0.25, 60], [0.5, 70], [0.75, 80], [0.9, 90], [1, 100]];
/** Share of categories on plan → score. */
const HIT_RATE: Points = [[0, 0], [0.2, 30], [0.4, 60], [0.55, 70], [0.7, 80], [0.85, 90], [1, 100]];

const LADDER: Array<[number, string]> = [
  [97, 'A+'], [93, 'A'], [90, 'A-'], [87, 'B+'], [83, 'B'], [80, 'B-'], [77, 'C+'], [73, 'C'], [70, 'C-'], [67, 'D+'], [63, 'D'], [60, 'D-'],
];
export const gradeOf = (score: number): string => LADDER.find(([min]) => score >= min)?.[1] ?? 'F';
const letter = (g: string) => g[0]!;
const rankOf = (g: string) => 'FDCBA'.indexOf(letter(g));

// ---- coverage ------------------------------------------------------------------------------
/** Days in [start, end] that no span covers, as ranges. */
export function missingWithin(spans: Span[], start: ISODate, end: ISODate): Span[] {
  const out: Span[] = [];
  let cursor = start;
  for (const s of [...spans].sort((a, b) => a.start.localeCompare(b.start))) {
    if (s.end < cursor) continue;
    if (s.start > end) break;
    if (s.start > cursor) out.push({ start: cursor, end: addDays(s.start, -1) });
    cursor = addDays(s.end, 1);
    if (cursor > end) break;
  }
  if (cursor <= end) out.push({ start: cursor, end });
  return out;
}

function coverageOf(coverage: AccountCoverage[], start: ISODate, end: ISODate) {
  const days = diffDays(start, end) + 1;
  const accounts = coverage
    .filter((c) => c.spans.length)
    .map((c) => {
      const missing = missingWithin(c.spans, start, end);
      const missed = missing.reduce((s, m) => s + diffDays(m.start, m.end) + 1, 0);
      return { accountId: c.account.id, name: c.account.name, share: Math.max(0, (days - missed) / days), missing };
    });
  // A month is only as complete as its least-covered account.
  const share = accounts.length ? Math.min(...accounts.map((a) => a.share)) : 0;
  return { share, accounts };
}

// ---- the card ------------------------------------------------------------------------------------
export interface ReportInput {
  cycle: CycleView;
  txns: Txn[];
  cats: CatMap;
  schedules: Schedule[];
  coverage: AccountCoverage[];
  history: MonthPoint[];
  startDay: number;
  previous?: ReportSnapshot;
  /** Average monthly spend per category before this month; used to measure how much you cut. */
  typical?: Map<string, Pence>;
}

const WEIGHTS: Record<DimKey, number> = { spending: 25, categories: 20, history: 20, savings: 15, debt: 10, bills: 10 };
const LABELS: Record<DimKey, string> = {
  spending: 'Spending discipline', categories: 'Category accuracy', history: 'Versus your history',
  savings: 'Savings goal', debt: 'Debt plan', bills: 'Bills on time',
};

export function buildReportCard(i: ReportInput): ReportCard {
  const { cycle, txns, cats } = i;
  const cover = coverageOf(i.coverage, cycle.start, cycle.end);
  const provisional = cover.share < 0.97;
  const share = cover.share > 0 ? cover.share : 1;

  const inMonth = txns.filter((t) => t.date >= cycle.start && t.date <= cycle.end);

  // ---- per category -----------------------------------------------------------------------
  const lines = cycle.lines.filter((l) => l.category.kind === 'expense');
  const driversFor = (id: string) => {
    const by = new Map<string, { merchant: string; amount: Pence; count: number }>();
    for (const t of inMonth) {
      if (t.categoryId !== id || t.amount >= 0) continue;
      const e = by.get(t.mkey) ?? { merchant: t.merchant, amount: 0, count: 0 };
      e.amount -= t.amount;
      e.count++;
      by.set(t.mkey, e);
    }
    return [...by.values()].sort((a, b) => b.amount - a.amount).slice(0, 2);
  };

  const categories: CategoryResult[] = lines.map((l) => {
    const planned = Math.round(l.budget * share);
    const actual = l.spent;
    const variance = actual - planned;
    const budgeted = l.budget > 0;
    const tol = Math.max(Math.round(planned * 0.1), 1000);
    const status: CatStatus = !budgeted ? 'unbudgeted' : variance <= 0 ? 'under' : variance <= tol ? 'on' : 'over';
    const overFrac = Math.max(0, variance) / Math.max(planned, budgeted ? 5000 : 10_000);
    const score = Math.round(interpolate(OVER, overFrac));
    return { categoryId: l.category.id, planned, actual, variance, status, score, grade: gradeOf(score), drivers: driversFor(l.category.id) };
  }).sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));

  const budgeted = categories.filter((c) => c.status !== 'unbudgeted');
  const planned = budgeted.reduce((s, c) => s + c.planned, 0);
  const actual = categories.reduce((s, c) => s + c.actual, 0);
  const hasPlan = planned > 0;

  // ---- history (the headline comparison) ------------------------------------------------------
  const point = i.history.find((p) => p.key === cycle.key) ?? null;
  const trend = trendOf(i.history.filter((p) => p.key <= cycle.key));
  const histLines = point ? describeHistory(point, trend) : ['There isn’t enough earlier history yet to compare against. Each month you add makes this sharper.'];
  const catTrends = categoryTrends(txns, cats, cycle.key, i.startDay, 6);

  // ---- dimensions ----------------------------------------------------------------------------------
  const dims: Dimension[] = [];
  const push = (key: DimKey, score: number, detail: string) => {
    const s = Math.round(Math.max(0, Math.min(100, score)));
    dims.push({ key, label: LABELS[key], weight: WEIGHTS[key], score: s, grade: gradeOf(s), detail });
  };

  if (hasPlan) {
    const dev = (actual - planned) / planned;
    push('spending', interpolate(OVER, Math.max(0, dev)),
      dev <= 0 ? `${fmt(actual, { whole: true })} spent against ${fmt(planned, { whole: true })} planned${dev < -0.3 ? '. Well under; your budget may be too generous.' : '.'}`
               : `${Math.round(dev * 100)}% over plan: ${fmt(actual, { whole: true })} against ${fmt(planned, { whole: true })}.`);
    const hits = budgeted.filter((c) => c.status !== 'over').length;
    push('categories', interpolate(HIT_RATE, hits / budgeted.length), `${hits} of ${budgeted.length} budget lines stayed on plan.`);
  }

  if (point && point.deviation !== undefined && point.baseline !== undefined) {
    let s = interpolate(OVER, Math.max(0, point.deviation));
    // Inside your normal range (within one standard deviation) is ordinary variation, not a failure.
    if (point.z !== undefined && point.z < 1) s = Math.max(s, 85);
    const pct = Math.round(Math.abs(point.deviation) * 100);
    push('history', s, `${pct < 3 ? 'In line with' : `${pct}% ${point.deviation > 0 ? 'above' : 'below'}`} your usual ${fmt(point.baseline, { whole: true })}${point.rank && point.of && point.of >= 4 ? `; ${point.rank === 1 ? 'your highest' : point.rank === point.of ? 'your lowest' : `${point.rank}${['th', 'st', 'nd', 'rd'][point.rank % 10 > 3 || [11, 12, 13].includes(point.rank) ? 0 : point.rank % 10]}-highest`} of ${point.of}` : ''}.`);
  }

  const goal = Math.round(cycle.savingsGoal * share);
  if (goal > 0) {
    const ratio = cycle.saved / goal;
    push('savings', interpolate(ACHIEVED, Math.min(1, ratio)), `${fmt(cycle.saved, { whole: true })} put aside of a ${fmt(goal, { whole: true })} goal${ratio >= 1 ? '. Goal met.' : '.'}`);
  }

  // Debt and bills share the payment-schedule checks for this month's due dates.
  const due = i.schedules.flatMap((s) => s.history.filter((o) => o.due >= cycle.start && o.due <= cycle.end && o.state !== 'pending').map((o) => ({ s, o })));
  const debtDue = due.filter((d) => d.s.source === 'debt');
  const debtPlanned = Math.round(cycle.debtPlanned * share);
  if (debtPlanned > 0) {
    const missedDebt = debtDue.filter((d) => d.o.state === 'missed' || d.o.state === 'partial').length;
    const ratio = cycle.debtPaid / debtPlanned;
    push('debt', interpolate(ACHIEVED, Math.min(1, ratio)) - 15 * missedDebt,
      `${fmt(cycle.debtPaid, { whole: true })} paid of ${fmt(debtPlanned, { whole: true })} planned${missedDebt ? `; ${missedDebt} payment${missedDebt === 1 ? '' : 's'} missed or short` : ''}.`);
  }
  if (due.length) {
    const late = due.filter((d) => d.o.state === 'late').length;
    const missed = due.filter((d) => d.o.state === 'missed' || d.o.state === 'partial').length;
    // Share of bills paid on time (a late one counts half), capped at 85 if any was missed: proportional, so one
    // miss among nineteen on-time payments is a B, while one miss among three is a poor result.
    const onTime = due.filter((d) => d.o.state === 'paid').length;
    push('bills', Math.min(missed ? 85 : 100, (100 * (onTime + 0.5 * late)) / due.length), missed ? `${missed} of ${due.length} bills missed or short.` : late ? `${late} of ${due.length} bills paid late.` : `All ${due.length} bills paid on time.`);
  }

  const wsum = dims.reduce((s, d) => s + d.weight, 0);
  const overall = hasPlan && wsum ? (() => {
    const score = Math.round(dims.reduce((s, d) => s + d.score * d.weight, 0) / wsum);
    return { score, grade: gradeOf(score) };
  })() : null;

  // ---- waterfall: plan → each category's swing → actual ----------------------------------------------
  const swings = categories.map((c) => ({ id: c.categoryId, v: c.variance })).filter((c) => c.v !== 0);
  const top = swings.slice(0, 6);
  const other = swings.slice(6).reduce((s, c) => s + c.v, 0);
  const waterfall: WaterfallStep[] = hasPlan
    ? [{ label: 'Plan', value: planned, kind: 'total' }, ...top.map((c) => ({ label: cats.get(c.id)?.name ?? c.id, value: c.v, kind: 'delta' as const })), ...(other ? [{ label: 'Other', value: other, kind: 'delta' as const }] : []), { label: 'Actual', value: actual, kind: 'total' }]
    : [];

  // ---- how much did you cut? ---------------------------------------------------------------------------------
  let vsUsual: Pence | null = null;
  if (i.typical && i.typical.size) {
    const usual = [...i.typical].filter(([id]) => cats.get(id)?.kind === 'expense').reduce((s, [, v]) => s + v, 0) * share;
    vsUsual = Math.round(usual - actual);
  }

  // ---- badges ---------------------------------------------------------------------------------------------
  const badges: Badge[] = [];
  if (vsUsual !== null && vsUsual >= 2000 && vsUsual / Math.max(1, actual + vsUsual) >= 0.05) {
    badges.push({ key: 'cutter', label: 'Cost cutter', icon: 'PiggyBank', detail: `${fmt(vsUsual, { whole: true })} below your usual spending, about ${fmt(vsUsual * 12, { whole: true })} a year at this pace.` });
  }
  if (hasPlan && actual <= planned) badges.push({ key: 'under', label: 'Under plan', icon: 'Target', detail: 'Finished at or below your planned spending.' });
  if (budgeted.length >= 4 && budgeted.filter((c) => c.status !== 'over').length / budgeted.length >= 0.85) badges.push({ key: 'steady', label: 'Steady hand', icon: 'Gauge', detail: 'At least 85% of budget lines stayed on plan.' });
  if (point?.deviation !== undefined && point.deviation <= -0.05 && (point.of ?? 0) >= 3) badges.push({ key: 'beat', label: 'Beat your usual', icon: 'TrendDown', detail: `${Math.round(-point.deviation * 100)}% below your historical average.` });
  if (point?.rank === point?.of && (point?.of ?? 0) >= 6) badges.push({ key: 'best', label: 'Personal best', icon: 'Trophy', detail: `Your lowest spending in ${point!.of} months.` });
  if (goal > 0 && cycle.saved >= goal) badges.push({ key: 'saver', label: 'Saver', icon: 'PiggyBank', detail: 'Savings goal met.' });
  if (debtPlanned > 0 && cycle.debtPaid >= debtPlanned) badges.push({ key: 'slayer', label: 'Debt slayer', icon: 'Scales', detail: 'Paid at least the planned amount towards debt.' });
  if (due.length >= 3 && due.every((d) => d.o.state === 'paid')) badges.push({ key: 'ontime', label: 'Perfect attendance', icon: 'CheckCircle', detail: `All ${due.length} bills paid on time.` });
  const prev = i.previous ? { score: i.previous.score, grade: i.previous.grade, delta: overall ? overall.score - i.previous.score : 0 } : undefined;
  if (overall && i.previous && rankOf(overall.grade) > rankOf(i.previous.grade)) badges.push({ key: 'comeback', label: 'Comeback', icon: 'TrendUp', detail: `Up from a ${i.previous.grade} last month.` });

  // ---- teacher's comment ------------------------------------------------------------------------------------------
  const comment: string[] = [];
  if (overall) {
    const l = letter(overall.grade);
    const opening = l === 'A' ? 'Excellent month.' : l === 'B' ? 'A solid month.' : l === 'C' ? 'A mixed month.' : l === 'D' ? 'A tough month.' : 'This month got away from you.';
    const dev = (actual - planned) / planned;
    comment.push(`${opening} You finished ${Math.abs(Math.round(dev * 100)) < 1 ? 'right on' : `${Math.abs(Math.round(dev * 100))}% ${dev > 0 ? 'over' : 'under'}`} plan (${fmt(actual, { whole: true })} against ${fmt(planned, { whole: true })}).`);
    comment.push(histLines[0]!);
    const worst = categories.find((c) => c.status === 'over' || (c.status === 'unbudgeted' && c.actual >= 2000));
    if (worst) {
      const d = worst.drivers[0];
      comment.push(`${cats.get(worst.categoryId)?.name ?? 'One category'} ${worst.status === 'unbudgeted' ? `took ${fmt(worst.actual, { whole: true })} with no budget` : `ran ${fmt(worst.variance, { whole: true })} over`}${d ? `, mostly ${d.merchant} (${fmt(d.amount, { whole: true })})` : ''}.`);
    }
    if (vsUsual !== null && vsUsual >= 2000) comment.push(`You spent ${fmt(vsUsual, { whole: true })} less than usual. Keep that up and it adds to ${fmt(vsUsual * 12, { whole: true })} over a year.`);
    else if (vsUsual !== null && vsUsual <= -2000) comment.push(`That’s ${fmt(-vsUsual, { whole: true })} more than you usually spend, so next month is a chance to claw it back.`);
    if (provisional) comment.push(`This is provisional: your statements cover ${Math.round(cover.share * 100)}% of the month, so budgets were scaled to match. Add the rest for a final grade.`);
  }

  // ---- suggestions for next month's budget -------------------------------------------------------------------------------
  const suggestions: Suggestion[] = [];
  for (const c of categories) {
    if (suggestions.length >= 5 || c.planned <= 0) continue;
    const frac = c.variance / c.planned;
    const name = cats.get(c.categoryId)?.name ?? 'This category';
    if (frac > 0.15) suggestions.push({ categoryId: c.categoryId, from: Math.round(c.planned / share), to: roundTo5(c.actual / share), reason: `${name} ran ${Math.round(frac * 100)}% over. Either rein it in, or budget what it really costs.` });
    else if (frac < -0.3 && c.planned >= 3000) suggestions.push({ categoryId: c.categoryId, from: Math.round(c.planned / share), to: roundTo5((c.actual * 1.1) / share), reason: `${name} came in ${Math.round(-frac * 100)}% under. You can free up ${fmt(c.planned - c.actual, { whole: true })} for something else.` });
  }

  return {
    month: cycle.key, start: cycle.start, end: cycle.end, provisional,
    coverage: cover, hasPlan, overall, dims, categories, planned, actual, vsUsual, waterfall,
    history: { point, trend, lines: histLines, categories: catTrends, points: i.history },
    badges, comment, suggestions, previous: prev,
  };
}
