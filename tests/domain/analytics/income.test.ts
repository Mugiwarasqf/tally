import { describe, expect, it } from 'vitest';
import { toCatMap } from '../../../src/domain/analytics/aggregate';
import { buildIncomeProfile, expectedIncomeFor, incomePatternPatches } from '../../../src/domain/analytics/income';
import { detectRecurring } from '../../../src/domain/analytics/recurring';
import { DEFAULT_CATEGORIES } from '../../../src/domain/categorize/categories';
import { addDays } from '../../../src/lib/dates';
import type { Txn } from '../../../src/domain/types';

const cats = toCatMap(DEFAULT_CATEGORIES);

let n = 0;
const pay = (date: string, amount: number, merchant = 'Northwind Studio', over: Partial<Txn> = {}): Txn => ({
  id: `t${n++}`, accountId: 'a', fileId: 'f', date, amount, type: 'CR', merchant, mkey: merchant.toLowerCase().replace(/[^a-z]+/g, ' ').trim(),
  detail: '', raw: merchant, categoryId: 'unsorted-in', catSource: 'none', confidence: 0, reason: '', ...over,
});

/** `count` payments every `step` days starting at `start`. */
const series = (start: string, step: number, count: number, amount: number, merchant?: string, vary = 0) =>
  Array.from({ length: count }, (_, i) => pay(addDays(start, i * step), Math.round(amount * (1 + (i % 2 ? vary : -vary))), merchant));

const last = (xs: Txn[]) => xs.at(-1)!.date;

describe('income streams: every rhythm', () => {
  it('monthly salary: finds the stream, the payday and the monthly figure', () => {
    const txns = ['2026-06-28', '2026-07-28', '2026-08-28', '2026-09-28'].map((d) => pay(d, 245_000));
    const p = buildIncomeProfile(txns, cats, detectRecurring(txns, cats, last(txns)), '2026-10-05');
    expect(p.streams).toHaveLength(1);
    expect(p.streams[0]!.cadence).toBe('monthly');
    expect(p.payday).toBe(28);
    expect(p.regularMonthly).toBe(245_000);
    expect(p.expectedMonthly).toBe(245_000);
    expect(p.nextPay).toMatchObject({ date: '2026-10-28', amount: 245_000 });
  });

  it('fortnightly pay: monthly equivalent is 26 ÷ 12, not 2', () => {
    const txns = series('2026-01-02', 14, 12, 100_000);
    const p = buildIncomeProfile(txns, cats, detectRecurring(txns, cats, last(txns)), '2026-06-10');
    expect(p.streams[0]!.cadence).toBe('fortnightly');
    expect(p.regularMonthly).toBe(Math.round(100_000 * (26 / 12)));
  });

  it('weekly pay is detected too', () => {
    const txns = series('2026-03-06', 7, 10, 40_000);
    const p = buildIncomeProfile(txns, cats, detectRecurring(txns, cats, last(txns)), '2026-05-20');
    expect(p.streams[0]!.cadence).toBe('weekly');
    expect(p.regularMonthly).toBe(Math.round(40_000 * (52 / 12)));
  });

  it('shift work: weekly pay that varies by ±40% is still recognised as pay', () => {
    const txns = series('2026-03-06', 7, 10, 40_000, 'Care Agency Ltd', 0.4);
    const rec = detectRecurring(txns, cats, last(txns)).filter((r) => r.direction === 'in');
    expect(rec).toHaveLength(1);
    expect(rec[0]!.cadence).toBe('weekly');
  });

  it('twice-a-month pay (15th and 30th) is caught as a fortnightly-style rhythm', () => {
    const dates = ['2026-01-15', '2026-01-30', '2026-02-15', '2026-02-28', '2026-03-15', '2026-03-30', '2026-04-15'];
    const txns = dates.map((d) => pay(d, 120_000));
    const rec = detectRecurring(txns, cats, last(txns)).filter((r) => r.direction === 'in');
    expect(rec).toHaveLength(1);
  });
});

describe('expected income for a cycle', () => {
  const txns = series('2026-01-02', 14, 12, 100_000); // paid every other Friday, last on 2026-06-05
  const p = buildIncomeProfile(txns, cats, detectRecurring(txns, cats, last(txns)), '2026-06-10');

  it('counts three paydays in a three-pay month (received pay)', () => {
    // Jan 2, 16 and 30 all fall in January.
    expect(expectedIncomeFor(p, '2026-01-01', '2026-01-31')).toEqual({ total: 300_000, paydays: 3 });
    expect(expectedIncomeFor(p, '2026-02-01', '2026-02-28').paydays).toBe(2);
  });

  it('projects future pay dates from the rhythm, including the next three-pay month', () => {
    // Last received 5 Jun → Jun 19, Jul 3, Jul 17, Jul 31: July has three.
    expect(expectedIncomeFor(p, '2026-07-01', '2026-07-31')).toEqual({ total: 300_000, paydays: 3 });
    expect(expectedIncomeFor(p, '2026-06-01', '2026-06-30').paydays).toBe(2); // 5th (received) and 19th (projected)
  });
});

describe('irregular income', () => {
  it('only half of non-recurring income counts toward what you can plan on', () => {
    const salary = ['2026-06-28', '2026-07-28', '2026-08-28', '2026-09-28'].map((d) => pay(d, 200_000));
    const gifts = [pay('2026-07-04', 30_000, 'Alex Rivers', { categoryId: 'from-people' }), pay('2026-09-12', 30_000, 'Sam Okafor', { categoryId: 'from-people' })];
    const all = [...salary, ...gifts];
    const p = buildIncomeProfile(all, cats, detectRecurring(all, cats, '2026-09-28'), '2026-10-05');
    expect(p.regularMonthly).toBe(200_000);
    expect(p.irregularMonthly).toBeGreaterThan(0);
    expect(p.expectedMonthly).toBeLessThan(p.regularMonthly + p.irregularMonthly);
    expect(p.expectedMonthly).toBeGreaterThanOrEqual(p.regularMonthly);
  });
});

describe('pattern-based income classification', () => {
  it('reclassifies unexplained steady income as salary, with a human reason', () => {
    const txns = series('2026-01-02', 14, 8, 100_000, 'Northwind Studio');
    const patches = incomePatternPatches(txns, cats, last(txns));
    expect(patches).toHaveLength(8);
    expect(patches[0]!.patch).toMatchObject({ categoryId: 'salary', catSource: 'heuristic' });
    expect(patches[0]!.patch.reason).toContain('every two weeks');
  });

  it('leaves alone anything the user set, any rule decided, or a known dictionary merchant', () => {
    const manual = series('2026-01-02', 14, 4, 100_000, 'Alpha Co').map((t) => ({ ...t, catSource: 'manual' as const }));
    const paypal = series('2026-01-02', 14, 4, 100_000, 'PayPal').map((t) => ({ ...t, categoryId: 'other-income', catSource: 'dictionary' as const }));
    expect(incomePatternPatches([...manual, ...paypal], cats, '2026-03-01')).toEqual([]);
  });

  it('does not treat a one-off or a pair of payments as pay', () => {
    const txns = [pay('2026-01-02', 100_000, 'One Off Ltd'), pay('2026-02-02', 100_000, 'Two Off Ltd'), pay('2026-03-02', 100_000, 'Two Off Ltd')];
    expect(incomePatternPatches(txns, cats, '2026-03-05')).toEqual([]);
  });
});

describe('changing jobs', () => {
  // Weekly pay from one employer until March, then a different employer from April.
  const old = series('2026-01-02', 7, 12, 26_000, 'Old Employer Ltd');
  const next = series('2026-04-03', 7, 12, 45_000, 'New Employer Ltd');
  const txns = [...old, ...next];
  const asOf = last(txns);
  const applied = (): Txn[] => {
    const patches = new Map(incomePatternPatches(txns, cats, asOf).map((p) => [p.id, p.patch]));
    return txns.map((t) => ({ ...t, ...patches.get(t.id) }));
  };

  it('labels pay from the previous job as salary, and says so', () => {
    const t = applied().find((x) => x.merchant === 'Old Employer Ltd')!;
    expect(t.categoryId).toBe('salary');
    expect(t.reason).toMatch(/previous job/);
  });

  it('plans only on the current job, and lists the previous one', () => {
    const all = applied();
    const p = buildIncomeProfile(all, cats, detectRecurring(all, cats, asOf), asOf);
    expect(p.streams.map((s) => s.label)).toEqual(['New Employer Ltd']);
    expect(p.past).toMatchObject([{ label: 'Old Employer Ltd', cadence: 'weekly', last: last(old), payments: 12 }]);
    expect(p.irregularMonthly).toBe(0); // old wages are not "side income" to plan on
  });
});

describe('shift pay that sometimes doubles', () => {
  it('still counts as weekly pay when about half the weeks are a normal amount', () => {
    const amounts = [250, 250, 252, 258, 258, 258, 615, 590, 560, 450, 258, 258, 178, 594, 557, 558, 408, 258, 446, 258, 258, 258].map((p) => p * 100);
    const txns = amounts.map((a, i) => pay(addDays('2026-01-01', i * 7), a, 'Shift Agency Ltd'));
    const [r] = detectRecurring(txns, cats, last(txns));
    expect(r).toMatchObject({ merchant: 'Shift Agency Ltd', cadence: 'weekly', direction: 'in' });
  });
});
