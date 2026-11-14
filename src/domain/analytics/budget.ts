import { addDays, addMonths, clampDate, cycleDays, cycleRange, diffDays } from '../../lib/dates';
import type { CycleKey, ISODate } from '../../lib/dates';
import { roundTo5 } from '../../lib/money';
import type { Pence } from '../../lib/money';
import { DEBT, ONE_OFF } from '../categorize/categories';
import type { BudgetLine, Category, MonthPlan, Txn } from '../types';
import { dateRange, kindOf, totals } from './aggregate';
import type { CatMap } from './aggregate';

export type Status = 'under' | 'ontrack' | 'watch' | 'over';

export interface LineView {
  category: Category;
  budget: Pence;
  spent: Pence;
  remaining: Pence;
  /** spent ÷ budget, 0 when no budget is set */
  pct: number;
  status: Status;
  /** typical monthly spend in this category over recent complete cycles */
  typical: Pence;
}

export interface CycleView {
  key: CycleKey;
  start: ISODate;
  end: ISODate;
  days: number;
  /** The date the numbers are "as of": today, the cycle's end, or the last day we have statements for. */
  asOf: ISODate;
  elapsed: number;
  daysLeft: number;
  phase: 'past' | 'current' | 'future';
  /** True when the statements stop well before today, so live pacing would mislead. */
  stale: boolean;
  lines: LineView[];
  income: Pence;
  spent: Pence;
  saved: Pence;
  debtPaid: Pence;
  debtPlanned: Pence;
  budgetFlex: Pence;
  spentFlex: Pence;
  budgetFixed: Pence;
  budgetTotal: Pence;
  /** Daily allowance for flexible spending over the rest of the cycle. Null when there is no flexible budget. */
  perDay: Pence | null;
  /** What is left of today's allowance (can be negative). Null unless the data runs up to today. */
  safeToday: Pence | null;
  status: Status;
  projected: Pence;
  expectedIncome: Pence;
  savingsGoal: Pence;
  /** True when the daily allowance comes straight from income (no flexible budget has been set). */
  incomeLed: boolean;
  /** How many paydays of the main income stream fall in this cycle (3 in a three-pay month). */
  paydays: number;
  leftToAssign: Pence;
}

export interface CycleInput {
  txns: Txn[];
  cats: Category[];
  catMap: CatMap;
  budgets: BudgetLine[];
  plans: MonthPlan[];
  key: CycleKey;
  startDay: number;
  today: ISODate;
  /** Planned debt repayments for this cycle, from the debt plan. */
  debtPlanned?: Pence;
  /** Income expected in this cycle, from the detected pay schedule (counts the actual paydays that fall in it). */
  incomeExpected?: Pence;
  paydays?: number;
}

const cycleTxns = (txns: Txn[], key: CycleKey, startDay: number): Txn[] => {
  const { start, end } = cycleRange(key, startDay);
  return txns.filter((t) => t.date >= start && t.date <= end);
};

/** Average spend per category (and income) over the last `n` COMPLETE cycles before `key`. */
export function history(txns: Txn[], catMap: CatMap, key: CycleKey, startDay: number, n = 3): { spend: Map<string, Pence>; income: Pence; cycles: number; /** Spend per category in each of those cycles, newest first. */ perCycle: Array<Map<string, Pence>> } {
  const range = dateRange(txns);
  const spend = new Map<string, Pence>();
  if (!range) return { spend, income: 0, cycles: 0, perCycle: [] };
  const keys: CycleKey[] = [];
  for (let i = 1; i <= 12 && keys.length < n; i++) {
    const k = addMonths(key, -i);
    const { start, end } = cycleRange(k, startDay);
    if (start >= addDays(range.min, -5) && end <= addDays(range.max, 5)) keys.push(k);
  }
  if (!keys.length) {
    // Not even one full cycle on record: scale everything to a 30-day month.
    const days = Math.max(1, diffDays(range.min, range.max) + 1);
    const t = totals(txns, catMap);
    const f = 30.4 / days;
    for (const [id, v] of sumSpend(txns, catMap)) spend.set(id, Math.round(v * f));
    return { spend, income: Math.round(t.income * f), cycles: 0, perCycle: [] };
  }
  let income = 0;
  const perCycle: Array<Map<string, Pence>> = [];
  for (const k of keys) {
    const part = cycleTxns(txns, k, startDay);
    perCycle.push(sumSpend(part, catMap));
    income += totals(part, catMap).income;
  }
  // "Usual" per category: the median month once there are three or more (so one unusual month doesn't set the
  // level), the mean before that. One-off categories are left out entirely.
  const ids = new Set(perCycle.flatMap((m) => [...m.keys()]));
  for (const id of ids) {
    if (ONE_OFF.has(id)) continue;
    const vals = perCycle.map((m) => m.get(id) ?? 0).sort((a, b) => a - b);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const mid = vals.length >> 1;
    const med = vals.length % 2 ? vals[mid]! : (vals[mid - 1]! + vals[mid]!) / 2;
    spend.set(id, Math.round(vals.length >= 3 ? med : mean));
  }
  return { spend, income: Math.round(income / keys.length), cycles: keys.length, perCycle };
}

function sumSpend(txns: Txn[], catMap: CatMap): Map<string, Pence> {
  const m = new Map<string, Pence>();
  for (const t of txns) {
    const k = kindOf(t, catMap);
    if (k !== 'expense' && k !== 'debt') continue;
    m.set(t.categoryId, (m.get(t.categoryId) ?? 0) - t.amount);
  }
  return m;
}

/** Starting budget for a cycle: what you typically spend, rounded up to the next £5. */
export function suggestBudgets(typical: Map<string, Pence>, cats: Category[]): Map<string, Pence> {
  const out = new Map<string, Pence>();
  for (const c of cats) {
    if (c.kind !== 'expense') continue;
    const v = typical.get(c.id) ?? 0;
    if (v >= 500) out.set(c.id, roundTo5(v + 249));
  }
  return out;
}

const ratioStatus = (spent: Pence, budget: Pence, elapsed: number, days: number): Status => {
  if (budget <= 0) return 'ontrack';
  if (spent > budget) return 'over';
  const expected = budget * (elapsed / days);
  if (expected <= 0) return 'ontrack';
  const r = spent / expected;
  return r <= 0.9 ? 'under' : r <= 1.05 ? 'ontrack' : r <= 1.2 ? 'watch' : 'over';
};

export function cycleView(i: CycleInput): CycleView {
  const { start, end } = cycleRange(i.key, i.startDay);
  const days = cycleDays(i.key, i.startDay);
  const all = cycleTxns(i.txns, i.key, i.startDay);
  const range = dateRange(i.txns);
  const phase: CycleView['phase'] = i.today > end ? 'past' : i.today < start ? 'future' : 'current';

  // "As of": the earlier of today and the end of the cycle, but never past the last day we hold data for.
  // A finished cycle whose statements stop early is "stale" too: it must read as partial, never as a verdict.
  let asOf = phase === 'past' ? end : phase === 'future' ? start : i.today;
  const stale = !!range && range.max < end && (phase === 'current' ? diffDays(range.max, i.today) > 3 : phase === 'past' && diffDays(range.max, end) > 3);
  if (stale && range) asOf = clampDate(range.max, start, end);
  const elapsed = phase === 'future' ? 0 : Math.max(1, diffDays(start, asOf) + 1);
  const daysLeft = phase === 'past' ? 0 : Math.max(1, days - elapsed + (stale ? 0 : 1));

  const t = totals(all, i.catMap);
  const spendMap = sumSpend(all, i.catMap);
  const hist = history(i.txns, i.catMap, i.key, i.startDay);
  const budgets = new Map(i.budgets.filter((b) => b.month === i.key).map((b) => [b.categoryId, b.amount]));
  const plan = i.plans.find((p) => p.month === i.key);
  const debtPlanned = i.debtPlanned ?? 0;
  if (debtPlanned > 0) budgets.set(DEBT, debtPlanned);

  const lines: LineView[] = [];
  const seen = new Set<string>([...budgets.keys(), ...spendMap.keys()]);
  for (const id of seen) {
    const category = i.catMap.get(id);
    if (!category || (category.kind !== 'expense' && category.kind !== 'debt')) continue;
    const budget = budgets.get(id) ?? 0;
    const spent = spendMap.get(id) ?? 0;
    if (!budget && spent <= 0) continue;
    const pct = budget > 0 ? spent / budget : 0;
    const status: Status = category.fixed
      ? spent > budget * 1.05 && budget > 0 ? 'over' : spent >= budget * 0.95 && budget > 0 ? 'ontrack' : 'under'
      : ratioStatus(spent, budget, elapsed, days);
    lines.push({ category, budget, spent, remaining: budget - spent, pct, status, typical: hist.spend.get(id) ?? 0 });
  }
  lines.sort((a, b) => b.budget - a.budget || b.spent - a.spent);

  const fixed = lines.filter((l) => l.category.fixed && l.budget > 0);
  const flex = lines.filter((l) => !fixed.includes(l));
  const budgetFixed = fixed.reduce((s, l) => s + l.budget, 0);
  const budgetFlexSet = flex.reduce((s, l) => s + l.budget, 0);
  const spentFlex = flex.reduce((s, l) => s + l.spent, 0);
  const budgetTotal = budgetFixed + budgetFlexSet;

  // Income comes first. With no flexible budget set, what's left to spend is simply what's expected in,
  // less savings, debt repayments and fixed bills — so the app is useful from the first import.
  const expectedIncome = phase === 'past' ? (plan?.income ?? t.income) : (plan?.income ?? i.incomeExpected ?? (hist.income || t.income));
  const savingsGoal = plan?.savings ?? 0;
  const fixedBasis = budgetFixed > 0
    ? budgetFixed
    : [...hist.spend].filter(([id]) => { const c = i.catMap.get(id); return c?.kind === 'expense' && c.fixed; }).reduce((s, [, v]) => s + v, 0);
  const incomeLed = budgetFlexSet <= 0 && phase !== 'past' && expectedIncome > 0;
  const budgetFlex = incomeLed ? Math.max(0, expectedIncome - savingsGoal - debtPlanned - fixedBasis) : budgetFlexSet;

  // Daily allowance for flexible spending over the days that remain.
  const spentToday = phase === 'current' && !stale ? sumFlexOn(all, i.catMap, i.today, flex) : 0;
  const perDay = phase === 'past' || budgetFlex <= 0 ? null : Math.round((budgetFlex - (spentFlex - spentToday)) / daysLeft);
  const safeToday = perDay !== null && phase === 'current' && !stale ? perDay - spentToday : null;

  // Projection: fixed bills land on their budget; flexible spend continues at its current rate.
  const flexRate = elapsed >= 3 ? spentFlex / elapsed : budgetFlex / days;
  const remainingDays = Math.max(0, days - elapsed);
  const projected = Math.round(fixed.reduce((s, l) => s + Math.max(l.spent, l.budget), 0) + spentFlex + (phase === 'past' ? 0 : flexRate * remainingDays));

  return {
    key: i.key, start, end, days, asOf, elapsed, daysLeft, phase, stale, lines,
    income: t.income, spent: t.spent, saved: t.saved, debtPaid: t.debt, debtPlanned,
    budgetFlex, spentFlex, budgetFixed, budgetTotal, perDay, safeToday,
    status: budgetFlex > 0 ? ratioStatus(spentFlex, budgetFlex, elapsed, days) : 'ontrack',
    projected, expectedIncome, savingsGoal,
    incomeLed: incomeLed && budgetFlex > 0, paydays: i.paydays ?? 0,
    leftToAssign: expectedIncome - savingsGoal - budgetTotal,
  };
}

function sumFlexOn(all: Txn[], catMap: CatMap, date: ISODate, flex: LineView[]): Pence {
  const ids = new Set(flex.map((l) => l.category.id));
  return all.filter((t) => t.date === date && ids.has(t.categoryId) && kindOf(t, catMap) === 'expense').reduce((s, t) => s - t.amount, 0);
}
