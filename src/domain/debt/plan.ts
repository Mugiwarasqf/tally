import { addMonths } from '../../lib/dates';
import type { CycleKey } from '../../lib/dates';
import { roundTo5 } from '../../lib/money';
import type { Pence } from '../../lib/money';
import type { CatMap } from '../analytics/aggregate';
import type { Debt, DebtPlanSettings, DebtStrategy, Txn } from '../types';

/**
 * Debt payoff planning.
 *
 * The model is the standard one lenders use: interest accrues monthly at APR ÷ 12 on the
 * outstanding balance, then payments are applied. Every debt gets its minimum; whatever is
 * left of the monthly total goes to one debt first (avalanche = highest APR, snowball =
 * smallest balance). When a debt clears, its minimum rolls into the next. Amounts are pence.
 */

export interface DebtState {
  id: string;
  name: string;
  balance: Pence;
  apr: number;
  min: Pence;
}

export interface SimMonth {
  index: number; // 0 = first planned month
  key: CycleKey;
  payments: Record<string, Pence>;
  interest: Pence;
  total: Pence;
  balances: Record<string, Pence>;
  balance: Pence; // total outstanding after payments
}

export interface Simulation {
  months: SimMonth[];
  /** Months until every debt is cleared, or null if it never gets there at this payment. */
  payoffMonths: number | null;
  totalInterest: Pence;
  totalPaid: Pence;
  /** Month index each debt reaches zero. */
  clearedAt: Record<string, number>;
}

const MAX_MONTHS = 600;

export function simulate(
  debts: DebtState[],
  monthly: Pence,
  strategy: DebtStrategy,
  startKey: CycleKey,
  opts: { rollover?: boolean } = {},
): Simulation {
  const rollover = opts.rollover ?? true;
  const bal = new Map(debts.map((d) => [d.id, d.balance]));
  const clearedAt: Record<string, number> = {};
  for (const d of debts) if (d.balance <= 0) clearedAt[d.id] = 0;
  const months: SimMonth[] = [];
  let totalInterest = 0;
  let totalPaid = 0;
  let stagnant = 0;
  let lastTotal = Infinity;

  for (let i = 0; i < MAX_MONTHS; i++) {
    const active = debts.filter((d) => (bal.get(d.id) ?? 0) > 0);
    if (!active.length) break;

    let interest = 0;
    for (const d of active) {
      const add = Math.round((bal.get(d.id)! * d.apr) / 1200);
      bal.set(d.id, bal.get(d.id)! + add);
      interest += add;
    }

    const payments: Record<string, Pence> = {};
    const owed = (d: DebtState) => bal.get(d.id)!;
    const minTotal = active.reduce((s, d) => s + Math.min(d.min, owed(d)), 0);
    let pot = rollover ? Math.max(monthly, minTotal) : minTotal;
    for (const d of active) {
      const p = Math.min(d.min, owed(d), pot);
      payments[d.id] = p;
      bal.set(d.id, owed(d) - p);
      pot -= p;
    }
    if (rollover && pot > 0) {
      const order = [...active].sort((a, b) => (strategy === 'avalanche' ? b.apr - a.apr || owed(a) - owed(b) : owed(a) - owed(b)));
      for (const d of order) {
        if (pot <= 0) break;
        const p = Math.min(owed(d), pot);
        if (p <= 0) continue;
        payments[d.id] = (payments[d.id] ?? 0) + p;
        bal.set(d.id, owed(d) - p);
        pot -= p;
      }
    }

    const paid = Object.values(payments).reduce((s, v) => s + v, 0);
    const balances = Object.fromEntries(debts.map((d) => [d.id, bal.get(d.id) ?? 0]));
    const total = Object.values(balances).reduce((s, v) => s + v, 0);
    for (const d of active) if (bal.get(d.id)! <= 0 && clearedAt[d.id] === undefined) clearedAt[d.id] = i + 1;
    totalInterest += interest;
    totalPaid += paid;
    months.push({ index: i, key: addMonths(startKey, i), payments, interest, total: paid, balances, balance: total });

    // Bail out when payments no longer outrun interest.
    stagnant = total >= lastTotal ? stagnant + 1 : 0;
    lastTotal = total;
    if (stagnant >= 24) return { months, payoffMonths: null, totalInterest, totalPaid, clearedAt };
  }
  const done = months.length > 0 && months.at(-1)!.balance <= 0;
  return { months, payoffMonths: done ? months.length : months.length === 0 ? 0 : null, totalInterest, totalPaid, clearedAt };
}

/** Smallest monthly payment (to the nearest £1) that clears everything within `months`. */
export function paymentForMonths(debts: DebtState[], months: number, strategy: DebtStrategy, startKey: CycleKey): Pence | null {
  const minTotal = debts.reduce((s, d) => s + Math.min(d.min, d.balance), 0);
  const ok = (m: Pence) => {
    const r = simulate(debts, m, strategy, startKey);
    return r.payoffMonths !== null && r.payoffMonths <= months;
  };
  let hi = Math.max(minTotal, debts.reduce((s, d) => s + d.balance, 0) * 2);
  if (!ok(hi)) return null;
  let lo = minTotal;
  if (ok(lo)) return lo;
  while (hi - lo > 100) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return Math.ceil(hi / 100) * 100;
}

/**
 * Monthly payment that clears `balance` in exactly `months` payments at `apr`% (rounded up to a whole
 * pound). With no interest it is simple division — the usual case for money owed to a friend.
 */
export function requiredByDeadline(balance: Pence, apr: number, months: number): Pence {
  const n = Math.max(1, months);
  const r = apr / 1200;
  const pay = r > 0 ? (balance * r) / (1 - (1 + r) ** -n) : balance / n;
  return Math.ceil(pay / 100) * 100;
}

/** Payments left from `startKey`'s cycle up to and including the cycle containing `deadline` (at least 1). */
export function paymentsUntil(startKey: CycleKey, deadline: string): number {
  const [sy, sm] = startKey.split('-').map(Number);
  const [dy, dm] = deadline.split('-').map(Number);
  return Math.max(1, dy! * 12 + dm! - (sy! * 12 + sm!) + 1);
}

// ---- what is reasonable? ---------------------------------------------------

export interface Affordability {
  income: Pence;
  plannedSpend: Pence;
  savings: Pence;
  /** Money left after planned spending and savings. */
  available: Pence;
  /** Slice kept back as a buffer and never committed to debt. */
  buffer: Pence;
  minTotal: Pence;
  /** Highest payment this plan will suggest. */
  ceiling: Pence;
  /** Positive when even the minimums do not fit. */
  shortfall: Pence;
  minimum: Pence;
  balanced: Pence;
  fast: Pence;
}

/**
 * "Reasonable" means: always cover the minimums, never plan to spend the whole surplus
 * (10% of income is kept back as a buffer), and offer three clear rungs — balanced uses
 * half of the usable surplus, fast uses 80%.
 */
export function affordability(income: Pence, plannedSpend: Pence, savings: Pence, minTotal: Pence, totalBalance: Pence): Affordability {
  const available = income - plannedSpend - savings;
  const buffer = Math.round(income * 0.1);
  const usable = Math.max(0, available - buffer);
  const cap = (v: Pence) => Math.min(totalBalance, Math.max(minTotal, v));
  const ceiling = cap(roundTo5(usable));
  const rung = (f: number) => cap(roundTo5(minTotal + (usable - minTotal) * f));
  return {
    income,
    plannedSpend,
    savings,
    available,
    buffer,
    minTotal,
    ceiling,
    shortfall: Math.max(0, minTotal - Math.max(0, available)),
    minimum: Math.min(totalBalance, minTotal),
    balanced: usable > minTotal ? rung(0.5) : minTotal,
    fast: usable > minTotal ? rung(0.8) : minTotal,
  };
}

// ---- balances and the live plan ---------------------------------------------

/**
 * A debt's balance today: the balance you entered, less anything you've paid since
 * (repayment transactions whose text contains the debt's "match" phrase).
 */
export function currentBalance(d: Debt, txns: Txn[], cats: CatMap): Pence {
  if (!d.match) return Math.max(0, d.balance);
  const needle = d.match.toLowerCase();
  const paid = txns
    .filter((t) => t.date > d.asOf && t.amount < 0 && cats.get(t.categoryId)?.kind !== 'transfer' && `${t.merchant} ${t.raw}`.toLowerCase().includes(needle))
    .reduce((s, t) => s - t.amount, 0);
  return Math.max(0, d.balance - paid);
}

export interface PlanView {
  /** `min` is the effective minimum: the larger of the one you set and what the pay-by date requires. */
  debts: Array<DebtState & { debt: Debt; original: Pence; needed: Pence }>;
  totalBalance: Pence;
  monthly: Pence;
  strategy: DebtStrategy;
  plan: Simulation;
  /** Same debts paying only their minimums, with nothing rolled over — the "do nothing different" path. */
  baseline: Simulation;
  interestSaved: Pence;
  monthsSaved: number | null;
  debtFree: CycleKey | null;
  afford: Affordability;
  /** Payment needed to hit the chosen target, when pace = 'target'. */
  targetPayment: Pence | null;
}

export function buildPlan(args: {
  debts: Debt[];
  txns: Txn[];
  cats: CatMap;
  settings: DebtPlanSettings;
  startKey: CycleKey;
  income: Pence;
  plannedSpend: Pence;
  savings: Pence;
}): PlanView {
  const { settings, startKey } = args;
  const states = args.debts.map((d) => {
    const balance = currentBalance(d, args.txns, args.cats);
    // A pay-by date turns "pay what you can" into a concrete monthly amount.
    const needed = d.deadline && balance > 0 ? requiredByDeadline(balance, d.apr, paymentsUntil(startKey, d.deadline)) : 0;
    return { id: d.id, name: d.name, apr: d.apr, min: Math.max(d.minPayment, needed), balance, debt: d, original: d.balance, needed };
  });
  const live = states.filter((s) => s.balance > 0);
  const totalBalance = live.reduce((s, d) => s + d.balance, 0);
  const minTotal = live.reduce((s, d) => s + Math.min(d.min, d.balance), 0);
  const afford = affordability(args.income, args.plannedSpend, args.savings, minTotal, totalBalance);

  let targetPayment: Pence | null = null;
  let monthly = afford.balanced;
  switch (settings.pace) {
    case 'minimum': monthly = minTotal; break;
    case 'balanced': monthly = afford.balanced; break;
    case 'fast': monthly = afford.fast; break;
    case 'custom': monthly = Math.max(minTotal, settings.customMonthly ?? afford.balanced); break;
    case 'target':
      targetPayment = paymentForMonths(live, Math.max(1, settings.targetMonths ?? 24), settings.strategy, startKey);
      monthly = targetPayment ?? afford.fast;
      break;
  }
  if (!live.length) monthly = 0;
  const rollover = settings.pace !== 'minimum';
  const plan = simulate(live, monthly, settings.strategy, startKey, { rollover });
  const baseline = simulate(live, minTotal, settings.strategy, startKey, { rollover: false });
  const interestSaved = baseline.payoffMonths !== null && plan.payoffMonths !== null ? Math.max(0, baseline.totalInterest - plan.totalInterest) : 0;
  const monthsSaved = baseline.payoffMonths !== null && plan.payoffMonths !== null ? Math.max(0, baseline.payoffMonths - plan.payoffMonths) : null;
  return {
    debts: states, totalBalance, monthly, strategy: settings.strategy, plan, baseline,
    interestSaved, monthsSaved,
    debtFree: plan.payoffMonths === null ? null : addMonths(startKey, Math.max(0, plan.payoffMonths - 1)),
    afford, targetPayment,
  };
}

/** What the plan expects to pay in a given cycle (0 once everything is cleared). */
export function plannedFor(view: PlanView, key: CycleKey): Pence {
  return view.plan.months.find((m) => m.key === key)?.total ?? 0;
}
