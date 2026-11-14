import { describe, expect, it } from 'vitest';
import { toCatMap } from '../../../src/domain/analytics/aggregate';
import { categoryTrends, describeHistory, spendHistory, trendOf } from '../../../src/domain/analytics/trend';
import { DEFAULT_CATEGORIES } from '../../../src/domain/categorize/categories';
import type { Txn } from '../../../src/domain/types';

const cats = toCatMap(DEFAULT_CATEGORIES);
let n = 0;
const spend = (date: string, pounds: number, categoryId = 'groceries'): Txn => ({
  id: `t${n++}`, accountId: 'a', fileId: 'f', date, amount: -pounds * 100, type: ')))', merchant: 'Shop', mkey: 'shop', detail: '', raw: 'Shop',
  categoryId, catSource: 'dictionary', confidence: 0.9, reason: '',
});

/** One payment on the 10th and one on the 20th of each month, totalling `totals[i]` pounds. */
function months(totals: number[], start = '2026-01', category = 'groceries'): Txn[] {
  return totals.flatMap((t, i) => {
    const m = String(Number(start.slice(5)) + i).padStart(2, '0');
    return [spend(`2026-${m}-10`, t / 2, category), spend(`2026-${m}-20`, t / 2, category)];
  });
}
/**
 * Mark the data as covering January 1st to a couple of days into the month after `lastMonth`, so every month
 * in between counts as complete. Zero-value entries in an unrelated category: they extend coverage without
 * adding any spending.
 */
const cover = (txns: Txn[], lastMonth: string) => [
  ...txns,
  spend('2026-01-01', 0, 'cash'),
  spend(`2026-${lastMonth}-28`, 0, 'cash'),
  spend(`2026-${String(Number(lastMonth) + 1).padStart(2, '0')}-02`, 0, 'cash'),
];

describe('spendHistory', () => {
  const txns = cover(months([1000, 1100, 900, 1000, 1500]), '05');
  const h = spendHistory(txns, cats, 1);

  it('judges each month only against the months before it', () => {
    const feb = h.find((p) => p.key === '2026-02')!;
    expect(feb.baseline).toBe(100_000); // January only
    const may = h.find((p) => p.key === '2026-05')!;
    expect(may.baseline).toBe(100_000); // mean of Jan-Apr = (1000+1100+900+1000)/4
  });

  it('never uses a later month to judge an earlier one', () => {
    const before = spendHistory(txns, cats, 1).find((p) => p.key === '2026-03')!;
    const withMore = spendHistory(cover(months([1000, 1100, 900, 1000, 1500, 5000], '2026-01'), '06'), cats, 1).find((p) => p.key === '2026-03')!;
    expect(withMore.baseline).toBe(before.baseline);
    expect(withMore.deviation).toBe(before.deviation);
  });

  it('computes deviation, rank and a normal range once there are three earlier months', () => {
    const may = h.find((p) => p.key === '2026-05')!;
    expect(may.deviation).toBeCloseTo(0.5, 1); // £1,500 vs a £1,000 usual
    expect(may.rank).toBe(1);
    expect(may.of).toBe(5);
    expect(may.sigma).toBeGreaterThan(0);
    expect(may.z).toBeGreaterThan(1);
    expect(h.find((p) => p.key === '2026-02')!.sigma).toBeUndefined(); // too little history for a band yet
  });

  it('projects an unfinished month from its pace instead of calling it cheap', () => {
    const partial = [...months([1000, 1000, 1000]), spend('2026-04-05', 300), spend('2026-04-12', 300)]; // data ends 12 April
    const apr = spendHistory(partial, cats, 1).find((p) => p.key === '2026-04')!;
    expect(apr.complete).toBe(false);
    expect(apr.projected).toBeGreaterThan(apr.spent);
    expect(apr.deviation).toBeGreaterThan(0); // 600 in 12 days projects well above a 1,000 month
  });
});

describe('projecting an unfinished month', () => {
  it('uses how YOUR months run: front-loaded rent must not make the month look three times too expensive', () => {
    // Each earlier month: £1,000 rent on the 1st, then £400 of everyday spending spread to the 28th.
    const full: Txn[] = [];
    for (const m of ['01', '02', '03']) {
      full.push(spend(`2026-${m}-01`, 1000, 'housing'));
      for (const d of ['07', '14', '21', '28']) full.push(spend(`2026-${m}-${d}`, 100, 'groceries'));
    }
    // April so far (data through the 11th): the rent and one £100 shop.
    const partial = [...full, spend('2026-04-01', 1000, 'housing'), spend('2026-04-07', 100, 'groceries'), spend('2026-01-01', 0, 'cash'), spend('2026-04-11', 0, 'cash')];
    const apr = spendHistory(partial, cats, 1).find((p) => p.key === '2026-04')!;
    const straightLine = Math.round((110_000 * 30) / 11); // what a naive pace would claim: about £3,000
    expect(apr.projected).toBeGreaterThan(130_000);
    expect(apr.projected).toBeLessThan(150_000); // close to a normal £1,400 month
    expect(apr.projected).toBeLessThan(straightLine / 1.8);
  });
});

describe('trendOf', () => {
  it('finds a rising trend and its slope', () => {
    const h = spendHistory(cover(months([1000, 1100, 1200, 1300, 1400, 1500]), '06'), cats, 1);
    const t = trendOf(h)!;
    expect(t.direction).toBe('rising');
    expect(t.perMonth).toBeGreaterThan(9000);
    expect(t.perMonth).toBeLessThan(11000);
    expect(t.confidence).toBe('good');
  });

  it('calls flat spending steady, and refuses to trend on fewer than three months', () => {
    expect(trendOf(spendHistory(cover(months([1000, 1005, 995, 1000]), '04'), cats, 1))!.direction).toBe('steady');
    expect(trendOf(spendHistory(cover(months([1000, 1100]), '02'), cats, 1))).toBeNull();
  });
});

describe('categoryTrends and the narrative', () => {
  const txns = cover([...months([400, 400, 400, 700], '2026-01' as never, 'groceries'), ...months([200, 200, 200, 195], '2026-01' as never, 'transport')], '04');
  it('ranks categories by how far they moved from their own history', () => {
    const t = categoryTrends(txns, cats, '2026-04', 1);
    expect(t[0]).toMatchObject({ categoryId: 'groceries', direction: 'up', baseline: 40_000, current: 70_000 });
    expect(t.find((c) => c.categoryId === 'transport')).toBeUndefined(); // moved by less than £10
  });

  it('writes a readable summary, including the rank', () => {
    const h = spendHistory(cover(months([1000, 1100, 900, 1000, 1500]), '05'), cats, 1);
    const lines = describeHistory(h.find((p) => p.key === '2026-05')!, trendOf(h));
    expect(lines.join(' ')).toContain('50% above your usual');
    expect(lines.join(' ')).toContain('highest of 5 months');
  });

  it('is honest when there is not enough history', () => {
    const h = spendHistory(cover(months([1000]), '01'), cats, 1);
    expect(describeHistory(h[0]!, null)[0]).toContain('isn’t enough earlier history');
  });
});
