import { describe, expect, it } from 'vitest';
import type { Recurring } from '../../../src/domain/analytics/recurring';
import { buildSavingsPlan, goalPresets } from '../../../src/domain/analytics/cuts';
import { DEFAULT_CATEGORIES } from '../../../src/domain/categorize/categories';
import type { Txn } from '../../../src/domain/types';

const p = (pounds: number) => pounds * 100;
const typical = new Map([
  ['housing', p(850)], ['bills', p(120)], ['groceries', p(400)], ['transport', p(100)],
  ['eating-out', p(188)], ['shopping', p(180)], ['entertainment', p(40)], ['subscriptions', p(30)], ['fees', p(4)],
]);
const recent = [
  new Map([['eating-out', p(220)], ['shopping', p(200)], ['groceries', p(410)]]),
  new Map([['eating-out', p(118)], ['shopping', p(190)], ['groceries', p(395)]]), // eating out: a proven £118 month
  new Map([['eating-out', p(226)], ['shopping', p(150)], ['groceries', p(395)]]),
];
const base = { typical, recent, categories: DEFAULT_CATEGORIES, income: p(2400), goal: p(0), debtPlanned: 0, recurring: [] as Recurring[], txns: [] as Txn[], asOf: '2026-10-31' };
const sub = (merchant: string, monthly: number, change?: Recurring['change']): Recurring => ({
  key: `out:${merchant}`, merchant, categoryId: 'subscriptions', direction: 'out', cadence: 'monthly', amount: p(monthly), lastDate: '2026-10-03', nextDate: '2026-11-03',
  occurrences: 6, dates: [], gap: 30, annual: p(monthly) * 12, change,
});

describe('savings plan: how much needs cutting', () => {
  it('needs nothing when you already spend less than your goal allows', () => {
    const plan = buildSavingsPlan({ ...base, goal: p(200) }); // spends £1,912/mo; income £2,400 − goal £200 leaves £2,200
    expect(plan.need).toBe(0);
    expect(plan.reachable).toBe(true);
    expect(plan.selected.size).toBe(0);
  });

  it('works backwards from the goal: income − goal − debt is the most you can spend', () => {
    const plan = buildSavingsPlan({ ...base, goal: p(500), debtPlanned: p(200) });
    expect(plan.spendable).toBe(p(1700));
    expect(plan.need).toBe(plan.typicalSpend - p(1700));
    expect(plan.need).toBeGreaterThan(0);
  });
});

describe('savings plan: where to cut', () => {
  const plan = buildSavingsPlan({ ...base, goal: p(500) });
  const idea = (id: string) => plan.ideas.find((i) => i.id === id);

  it('protects commitments: housing is never trimmed', () => {
    expect(plan.ideas.some((i) => i.categoryId === 'housing')).toBe(false);
  });

  it('prefers a level you have already achieved over an arbitrary percentage', () => {
    const eating = idea('cat:eating-out')!;
    expect(eating.proven).toBe(true);
    expect(eating.target).toBeLessThanOrEqual(p(145)); // limit 25% of £188 = £141: capped by what's sensible, near the proven £118
    expect(eating.saving).toBeGreaterThan(p(40));
    expect(eating.detail).toContain('achievable');
  });

  it('trims a discretionary category by no more than its limit', () => {
    const shopping = idea('cat:shopping')!;
    expect(shopping.target).toBeGreaterThanOrEqual(p(180) * 0.7);
    expect(shopping.effort).not.toBe('easy'); // a 30% cut with no proven month behind it is not easy
  });

  it('treats avoidable fees as a full, easy saving', () => {
    expect(idea('fees')).toMatchObject({ target: 0, effort: 'easy', saving: p(4) });
  });

  it('switches on the easiest cuts first and stops once the gap is closed', () => {
    const picked = plan.ideas.filter((i) => plan.selected.has(i.id));
    expect(picked.length).toBeGreaterThan(0);
    expect(plan.identified).toBeGreaterThanOrEqual(Math.min(plan.need, plan.potential));
    expect(picked.every((_i, n) => n === 0 || picked[n - 1]!.counted)).toBe(true);
    const easyUnpicked = plan.ideas.find((i) => i.counted && i.effort === 'easy' && !plan.selected.has(i.id));
    if (easyUnpicked) expect(plan.gapLeft).toBe(0); // we only skipped easy cuts because the gap was already closed
  });

  it('reports honestly when the goal cannot be reached by cutting', () => {
    const hard = buildSavingsPlan({ ...base, goal: p(1200) });
    expect(hard.reachable).toBe(false);
    expect(hard.gapLeft).toBeGreaterThan(0);
    expect(hard.gapLeft).toBe(hard.need - hard.identified);
  });

  it('names the biggest goal that every cut together could still reach, and that goal is reachable', () => {
    const hard = buildSavingsPlan({ ...base, goal: p(1200) });
    const headroom = p(2400) - (hard.typicalSpend - hard.potential);
    expect(hard.bestGoal).toBeGreaterThan(0);
    expect(hard.bestGoal).toBeLessThanOrEqual(headroom);
    expect(hard.bestGoal % p(10)).toBe(0); // a tidy amount
    const best = buildSavingsPlan({ ...base, goal: hard.bestGoal });
    expect(best.potential).toBeGreaterThanOrEqual(best.need);
  });

  it('reports the shortfall when usual spending, even after every cut, is more than comes in', () => {
    const over = buildSavingsPlan({ ...base, income: p(1500), goal: p(300) }); // spends £1,912/mo on £1,500
    expect(over.bestGoal).toBeLessThan(0);
    expect(-over.bestGoal).toBe(over.typicalSpend - over.potential - p(1500));
  });

  it('turns the chosen cuts into budget targets, leaving everything else at your usual', () => {
    const t = buildSavingsPlan({ ...base, goal: p(800) }).targets; // a bigger goal, so eating out is selected
    expect(t.get('housing')).toBe(p(850));
    expect(t.get('eating-out')!).toBeLessThan(p(188));
    expect(t.has('fees')).toBe(false); // cut to zero
  });
});

describe('savings plan: subscriptions and habits', () => {
  it('audits the costliest subscriptions instead of trimming the category blindly', () => {
    const plan = buildSavingsPlan({ ...base, goal: p(500), recurring: [sub('Netflix', 11), sub('Spotify', 13, { from: p(11.99), to: p(12.99) }), sub('Gym Pro', 40)] });
    const subs = plan.ideas.filter((i) => i.kind === 'subscription');
    expect(subs.map((s) => s.title)).toEqual(['Cancel or pause Gym Pro', 'Cancel or pause Spotify', 'Cancel or pause Netflix']);
    expect(plan.ideas.some((i) => i.id === 'cat:subscriptions')).toBe(false);
    expect(subs[1]!.detail).toContain('price rose');
  });

  it('flags small purchases as an insight but never adds them to the total', () => {
    const coffee = (n: number): Txn => ({ id: `c${n}`, accountId: 'a', fileId: 'f', date: `2026-09-${String(1 + (n % 28)).padStart(2, '0')}`, amount: -p(3), type: ')))', merchant: 'Cafe', mkey: 'cafe', detail: '', raw: '', categoryId: 'eating-out', catSource: 'dictionary', confidence: 0.9, reason: '' });
    const plan = buildSavingsPlan({ ...base, goal: p(500), txns: Array.from({ length: 36 }, (_, n) => coffee(n)) });
    const habit = plan.ideas.find((i) => i.kind === 'habit')!;
    expect(habit.counted).toBe(false);
    expect(plan.potential).toBe(plan.ideas.filter((i) => i.counted).reduce((s, i) => s + i.saving, 0));
  });
});

describe('goal presets', () => {
  it('offers light, steady and ambitious goals as shares of income', () => {
    expect(goalPresets(p(2400)).map((g) => [g.label, g.amount])).toEqual([['Light', p(120)], ['Steady', p(240)], ['Ambitious', p(480)]]);
  });
});
