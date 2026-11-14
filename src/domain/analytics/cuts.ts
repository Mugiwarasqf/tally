import type { ISODate } from '../../lib/dates';
import { addDays } from '../../lib/dates';
import { fmt } from '../../lib/money';
import type { Pence } from '../../lib/money';
import { bucketOf } from '../categorize/categories';
import type { Category, Txn } from '../types';
import { perMonth } from './recurring';
import type { Recurring } from './recurring';

/**
 * A budget built to save money.
 *
 * Reverse budgeting ("pay yourself first"): start from the savings goal, take away debt payments, and what's
 * left is what you can afford to spend. If your usual spending is above that, the gap is the amount to cut.
 * The skill is choosing WHERE to cut:
 *   - needs are protected and wants are trimmed (each category has a realistic limit on how far it can flex);
 *   - a cut you've already achieved is preferred: if you spent £118 on eating out in one recent month, £118 is
 *     proven, which beats an arbitrary percentage;
 *   - the easiest cuts come first, and we stop once the gap is closed.
 */
export type Effort = 'easy' | 'medium' | 'hard';

export interface CutIdea {
  id: string;
  kind: 'category' | 'subscription' | 'fees' | 'habit';
  categoryId?: string;
  title: string;
  detail: string;
  tip: string;
  /** What you spend now, per month. */
  current: Pence;
  target: Pence;
  /** Per month. */
  saving: Pence;
  effort: Effort;
  /** You've already spent at or below the target in a recent month. */
  proven: boolean;
  /** Counted in the totals. Habit insights overlap category cuts, so they're shown but never added up. */
  counted: boolean;
}

export interface SavingsPlan {
  income: Pence;
  goal: Pence;
  debt: Pence;
  /** What you can spend and still hit the goal: income − goal − debt payments. */
  spendable: Pence;
  /** What you usually spend (all spending categories). */
  typicalSpend: Pence;
  /** How much needs cutting to reach the goal. */
  need: Pence;
  ideas: CutIdea[];
  /** Ideas switched on: the easiest set that closes the gap. */
  selected: Set<string>;
  /** Monthly saving from the selected ideas. */
  identified: Pence;
  /** Everything the ideas could save per month if all were done. */
  potential: Pence;
  /** Still to find after the selected ideas. */
  gapLeft: Pence;
  reachable: boolean;
  /** Budget amount per spending category once the selected cuts are applied (others stay at your usual). */
  targets: Map<string, Pence>;
}

/** The most each category can sensibly flex. Commitments such as rent and sending money home don't flex at all. */
const LIMIT: Record<string, number> = {
  'eating-out': 0.25, shopping: 0.3, entertainment: 0.25, travel: 0.2, 'personal-care': 0.15, gifts: 0.1, cash: 0.2,
  family: 0.1, groceries: 0.1, transport: 0.1, bills: 0.08, health: 0.05, remittance: 0, housing: 0, education: 0, gov: 0,
};

const TIPS: Record<string, string> = {
  'eating-out': 'Cook one more meal at home a week, or plan a treat day instead of several small ones.',
  shopping: 'Wait 48 hours before non-essential purchases; unsubscribe from sale emails.',
  entertainment: 'Rotate one streaming or gaming service at a time, and look for free local events.',
  travel: 'Book early and compare dates; a flexible day can halve the fare.',
  'personal-care': 'Stretch the time between appointments, or learn the quick basics yourself.',
  gifts: 'Set a gift budget per occasion and stick to it.',
  cash: 'Cash disappears untracked. Withdraw a set amount weekly and see when it runs out.',
  family: 'Agree a monthly amount for group meals and gifts.',
  groceries: 'Plan the week’s meals and shop from a list; own-brand swaps often cut a basket by a tenth.',
  transport: 'Bundle trips, use passes or caps where they exist, and walk the short ones.',
  bills: 'Compare energy, phone and broadband when a contract ends. Providers rarely volunteer their best price.',
  health: 'Ask about generic versions and check whether a prescription prepayment plan would pay off.',
  fees: 'These are avoidable. Use a card with no foreign-transaction fee, and keep a small buffer to avoid overdraft charges.',
};

const EFFORT_ORDER: Record<Effort, number> = { easy: 0, medium: 1, hard: 2 };
const ceil5 = (p: Pence): Pence => Math.ceil(p / 500) * 500;

export function buildSavingsPlan(args: {
  /** Average monthly spend per category over recent complete months. */
  typical: Map<string, Pence>;
  /** Spend per category in each recent complete month. */
  recent: Array<Map<string, Pence>>;
  categories: Category[];
  income: Pence;
  goal: Pence;
  debtPlanned: Pence;
  recurring: Recurring[];
  txns: Txn[];
  asOf: ISODate;
  /** Override which ideas are on (otherwise the easiest set that closes the gap). */
  selected?: Set<string>;
}): SavingsPlan {
  const { typical, recent, categories, income, goal, debtPlanned } = args;
  const spending = categories.filter((c) => c.kind === 'expense' && c.id !== 'unsorted-out');
  const ideas: CutIdea[] = [];

  const hasSubscriptions = args.recurring.some((r) => r.direction === 'out' && r.categoryId === 'subscriptions');

  // ---- category trims ---------------------------------------------------------------------------
  for (const c of spending) {
    const usual = typical.get(c.id) ?? 0;
    // Fees are checked first with a lower bar: even a few pounds is a free saving, unlike a category trim.
    if (c.id === 'fees') {
      if (usual >= 200) ideas.push({ id: 'fees', kind: 'fees', categoryId: c.id, title: 'Stop paying fees', detail: `${fmt(usual)} a month on fees and charges that are avoidable.`, tip: TIPS.fees!, current: usual, target: 0, saving: usual, effort: 'easy', proven: false, counted: true });
      continue;
    }
    if (usual < 1000) continue;
    if (c.id === 'subscriptions' && hasSubscriptions) continue; // handled by the audit below
    const limit = LIMIT[c.id] ?? (bucketOf(c) === 'wants' ? 0.15 : 0.05);
    if (limit <= 0) continue;
    const months = recent.map((m) => m.get(c.id) ?? 0);
    const best = months.length >= 2 ? Math.min(...months) : undefined;
    const aggressive = usual * (1 - limit);
    // Never ask for more than the category can sensibly flex, and prefer a level you've already managed.
    const target = ceil5(Math.min(usual, Math.max(aggressive, best !== undefined && best < usual ? best : 0)));
    const saving = usual - target;
    if (saving < 500) continue;
    const frac = saving / usual;
    const proven = best !== undefined && best <= target;
    const effort: Effort = proven ? (frac <= 0.15 ? 'easy' : 'medium') : frac <= 0.08 ? 'easy' : frac <= 0.18 ? 'medium' : 'hard';
    ideas.push({
      id: `cat:${c.id}`, kind: 'category', categoryId: c.id, title: `Trim ${c.name.toLowerCase()}`,
      detail: `${fmt(usual, { whole: true })} usual → ${fmt(target, { whole: true })}.${proven ? (best! < 500 ? ' You’ve had a recent month with almost none, so this is achievable.' : ` You spent ${fmt(best!, { whole: true })} in a recent month, so this is achievable.`) : ''}`,
      tip: TIPS[c.id] ?? 'Look at the three biggest payments in this category and ask which you’d miss least.',
      current: usual, target, saving, effort, proven, counted: true,
    });
  }

  // ---- subscriptions audit ------------------------------------------------------------------------
  const subs = args.recurring
    .filter((r) => r.direction === 'out' && r.categoryId === 'subscriptions')
    .sort((a, b) => perMonth(b) - perMonth(a))
    .slice(0, 3);
  for (const r of subs) {
    const m = perMonth(r);
    if (m < 300) continue;
    ideas.push({
      id: `sub:${r.key}`, kind: 'subscription', categoryId: 'subscriptions', title: `Cancel or pause ${r.merchant}`,
      detail: `${fmt(r.change?.to ?? r.amount)} ${r.cadence}, ${fmt((r.change?.to ?? r.amount) * (r.annual / Math.max(1, r.amount)), { whole: true })} a year.${r.change && r.change.to > r.change.from ? ` The price rose from ${fmt(r.change.from)} to ${fmt(r.change.to)}.` : ''}`,
      tip: 'Keep one service at a time and rotate. Cancelling takes a minute and most let you resubscribe later.',
      current: m, target: 0, saving: m, effort: m <= 1000 ? 'easy' : 'medium', proven: false, counted: true,
    });
  }

  // ---- small purchases add up (shown, not counted: it overlaps the category trims) ------------------------
  const since = addDays(args.asOf, -90);
  const small = args.txns.filter((t) => {
    const c = categories.find((x) => x.id === t.categoryId);
    return t.date >= since && t.date <= args.asOf && t.amount < 0 && -t.amount < 500 && c?.kind === 'expense' && !c.fixed && c.id !== 'cash' && c.id !== 'fees';
  });
  const smallMonthly = Math.round(small.reduce((s, t) => s - t.amount, 0) / 3);
  const smallCount = Math.round(small.length / 3);
  if (smallMonthly >= 1500 && smallCount >= 8) {
    ideas.push({
      id: 'habit:small', kind: 'habit', title: 'Small purchases add up',
      detail: `About ${smallCount} purchases a month under £5 come to ${fmt(smallMonthly, { whole: true })}.`,
      tip: 'Give small purchases a weekly allowance. They are the easiest spending to lose track of.',
      current: smallMonthly, target: Math.round(smallMonthly * 0.6), saving: Math.round(smallMonthly * 0.4), effort: 'medium', proven: false, counted: false,
    });
  }

  ideas.sort((a, b) => Number(b.counted) - Number(a.counted) || EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort] || b.saving - a.saving);

  // ---- how much needs to be cut ---------------------------------------------------------------------------
  const typicalSpend = spending.reduce((s, c) => s + (typical.get(c.id) ?? 0), 0);
  const spendable = income - goal - debtPlanned;
  const need = income > 0 ? Math.max(0, typicalSpend - spendable) : goal;

  // ---- choose the cuts -----------------------------------------------------------------------------------------
  const counted = ideas.filter((i) => i.counted);
  let selected: Set<string>;
  if (args.selected) selected = args.selected;
  else {
    selected = new Set();
    let got = 0;
    for (const i of counted) {
      if (got >= need) break;
      selected.add(i.id);
      got += i.saving;
    }
  }
  const identified = counted.filter((i) => selected.has(i.id)).reduce((s, i) => s + i.saving, 0);
  const potential = counted.reduce((s, i) => s + i.saving, 0);
  const gapLeft = Math.max(0, need - identified);

  // ---- budget targets -----------------------------------------------------------------------------------------------
  const targets = new Map<string, Pence>();
  for (const c of spending) {
    const usual = typical.get(c.id) ?? 0;
    let t = usual;
    for (const i of counted) if (selected.has(i.id) && i.categoryId === c.id) t -= i.saving;
    if (t >= 500) targets.set(c.id, c.id === 'subscriptions' ? Math.round(t) : ceil5(t));
  }
  return { income, goal, debt: debtPlanned, spendable, typicalSpend, need, ideas, selected, identified, potential, gapLeft, reachable: gapLeft === 0, targets };
}

/** Savings goal presets as a share of income, rounded to a tidy £10. */
export const goalPresets = (income: Pence): Array<{ label: string; pct: number; amount: Pence }> =>
  [{ label: 'Light', pct: 5 }, { label: 'Steady', pct: 10 }, { label: 'Ambitious', pct: 20 }].map((p) => ({ ...p, amount: Math.round((income * p.pct) / 100 / 1000) * 1000 }));
