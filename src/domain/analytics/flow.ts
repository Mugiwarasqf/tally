import type { Pence } from '../../lib/money';
import { bucketOf } from '../categorize/categories';
import type { Txn } from '../types';
import { incomeSplit, kindOf } from './aggregate';
import type { CatMap } from './aggregate';
import type { CycleView } from './budget';
import { payDatesIn } from './income';
import type { IncomeProfile } from './income';

export type SinkKind = 'needs' | 'wants' | 'debt' | 'saved' | 'left';

export interface FlowSource { key: string; label: string; value: Pence }
export interface FlowSink { key: SinkKind; label: string; value: Pence }

/**
 * The income stem: where money comes from (left) and where it goes (right). Both sides always total the
 * same, which is what lets the diagram be drawn as ribbons.
 *
 *  - actual: pay has landed this cycle, so it shows what really happened.
 *  - plan:   no pay yet (early in a cycle before payday), so it shows the plan instead of a misleading
 *            "overspent": expected pay, split by budgets, debt and savings.
 */
export interface IncomeFlow {
  mode: 'actual' | 'plan';
  sources: FlowSource[];
  sinks: FlowSink[];
  total: Pence;
}

const SINK_LABEL: Record<SinkKind, string> = { needs: 'Needs', wants: 'Wants', debt: 'Debt', saved: 'Saved', left: 'Left over' };

export function buildIncomeFlow(args: { txns: Txn[]; cats: CatMap; cycle: CycleView; income: IncomeProfile }): IncomeFlow | null {
  const { txns, cats, cycle, income } = args;
  if (cycle.income <= 0 && cycle.expectedIncome <= 0) return null;
  // Show what happened only once it's the full story: the cycle is over, or most of the expected pay has
  // arrived. Part-way through a cycle, with payday still to come, outgoings would look like they came
  // from nowhere, so show the plan instead.
  const actual = cycle.income > 0 && (cycle.phase === 'past' || cycle.income >= cycle.expectedIncome * 0.8);

  let sources: FlowSource[];
  let parts: Record<'needs' | 'wants' | 'debt' | 'saved', Pence>;

  if (actual) {
    const split = incomeSplit(txns, cats);
    parts = { needs: split.needs, wants: split.wants, debt: split.debt, saved: split.saved };
    // Sources: the biggest few by name, the rest together.
    const by = new Map<string, FlowSource>();
    for (const t of txns) {
      if (kindOf(t, cats) !== 'income') continue;
      const e = by.get(t.mkey) ?? { key: t.mkey, label: t.merchant, value: 0 };
      e.value += t.amount;
      by.set(t.mkey, e);
    }
    const ranked = [...by.values()].filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
    sources = ranked.slice(0, 3);
    const rest = ranked.slice(3).reduce((s, x) => s + x.value, 0);
    if (rest > 0) sources.push({ key: 'other', label: 'Other income', value: rest });
  } else {
    // Plan: pay dates that fall in the cycle, each stream by its own rhythm.
    sources = income.streams
      .map((s) => ({ key: s.key, label: s.label, value: payDatesIn(s, cycle.start, cycle.end).length * s.amount }))
      .filter((s) => s.value > 0);
    const known = sources.reduce((s, x) => s + x.value, 0);
    if (cycle.expectedIncome > known) sources.push({ key: 'expected', label: sources.length ? 'Other income' : 'Expected income', value: cycle.expectedIncome - known });
    parts = { needs: 0, wants: 0, debt: cycle.debtPlanned, saved: cycle.savingsGoal };
    for (const l of cycle.lines) {
      if (l.category.kind !== 'expense') continue;
      const v = l.budget > 0 ? l.budget : l.typical;
      if (bucketOf(l.category) === 'needs') parts.needs += v; else parts.wants += v;
    }
  }

  const income$ = sources.reduce((s, x) => s + x.value, 0);
  const spent = parts.needs + parts.wants + parts.debt + parts.saved;
  const left = income$ - spent;
  // Spending beyond income needs a source too, otherwise the two sides wouldn't balance.
  if (left < 0) sources.push({ key: 'beyond', label: actual ? 'Beyond income' : 'Over plan', value: -left });

  const sinks: FlowSink[] = (['needs', 'wants', 'debt', 'saved'] as const)
    .map((k) => ({ key: k, label: SINK_LABEL[k], value: parts[k] }))
    .filter((s) => s.value > 0);
  if (left > 0) sinks.push({ key: 'left', label: actual ? SINK_LABEL.left : 'To spend', value: left });

  const total = sources.reduce((s, x) => s + x.value, 0);
  return total > 0 && sinks.length ? { mode: actual ? 'actual' : 'plan', sources, sinks, total } : null;
}
