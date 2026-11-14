import { describe, expect, it } from 'vitest';
import { toCatMap } from '../../../src/domain/analytics/aggregate';
import type { CycleView } from '../../../src/domain/analytics/budget';
import { cycleView } from '../../../src/domain/analytics/budget';
import type { AccountCoverage } from '../../../src/domain/analytics/coverage';
import { statementStartDay } from '../../../src/domain/analytics/coverage';
import { buildReportCard, gradeOf, interpolate, missingWithin } from '../../../src/domain/analytics/report';
import { spendHistory } from '../../../src/domain/analytics/trend';
import { DEFAULT_CATEGORIES } from '../../../src/domain/categorize/categories';
import type { Account, Txn } from '../../../src/domain/types';

const cats = toCatMap(DEFAULT_CATEGORIES);
let n = 0;
const spend = (date: string, pounds: number, categoryId: string, merchant = 'Shop'): Txn => ({
  id: `t${n++}`, accountId: 'a', fileId: 'f', date, amount: -pounds * 100, type: ')))', merchant, mkey: merchant.toLowerCase(), detail: '', raw: merchant,
  categoryId, catSource: 'dictionary', confidence: 0.9, reason: '',
});
const account: Account = { id: 'a', name: 'Everyday', bank: 'Test', key: 'k', createdAt: 0 };
const full = (start: string, end: string): AccountCoverage[] => [{ account, spans: [{ start, end }], gaps: [] }];

/** January-March: groceries £400 and eating out £100 each month; April is the month being graded. */
function scenario(april: { groceries: number; eating: number; saved?: number; debt?: number }, coverEnd = '2026-05-03') {
  const txns: Txn[] = [];
  for (const m of ['01', '02', '03']) txns.push(spend(`2026-${m}-10`, 400, 'groceries'), spend(`2026-${m}-15`, 100, 'eating-out'));
  txns.push(spend('2026-04-10', april.groceries, 'groceries', 'Tesco'), spend('2026-04-15', april.eating, 'eating-out', 'Nandos'));
  if (april.saved) txns.push(spend('2026-04-20', april.saved, 'savings', 'Kraken'));
  if (april.debt) txns.push(spend('2026-04-06', april.debt, 'debt', 'TSB Loan'));
  txns.push(spend('2026-01-01', 0, 'cash'), spend(coverEnd, 0, 'cash'));
  const budgets = [
    { month: '2026-04', categoryId: 'groceries', amount: 40_000 },
    { month: '2026-04', categoryId: 'eating-out', amount: 10_000 },
  ];
  const cycle = cycleView({
    txns, cats: DEFAULT_CATEGORIES, catMap: cats, budgets, plans: [{ month: '2026-04', savings: 20_000 }], key: '2026-04', startDay: 1,
    today: '2026-05-02', debtPlanned: april.debt ? april.debt * 100 : 0,
  });
  const history = spendHistory(txns, cats, 1);
  return { txns, cycle, history, coverage: full('2026-01-01', coverEnd) };
}
const card = (a: Parameters<typeof scenario>[0], extra: { coverEnd?: string; schedules?: never[] } = {}) => {
  const s = scenario(a, extra.coverEnd);
  return buildReportCard({ cycle: s.cycle, txns: s.txns, cats, schedules: [], coverage: s.coverage, history: s.history, startDay: 1 });
};

describe('scoring', () => {
  it('interpolates smoothly between control points instead of jumping at band edges', () => {
    const pts: Array<[number, number]> = [[0, 100], [0.05, 90], [0.1, 80]];
    expect(interpolate(pts, 0)).toBe(100);
    expect(interpolate(pts, 0.05)).toBe(90);
    expect(interpolate(pts, 0.075)).toBeCloseTo(85);
    expect(Math.abs(interpolate(pts, 0.049) - interpolate(pts, 0.051))).toBeLessThan(0.5);
    expect(interpolate(pts, 0.5)).toBe(80); // clamped beyond the last point
  });

  it('turns scores into letters with plus and minus', () => {
    expect([98, 94, 91, 88, 84, 81, 78, 74, 71, 68, 64, 61, 40].map(gradeOf)).toEqual(['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F']);
  });
});

describe('the report card', () => {
  it('gives an A to a month that lands on plan, with the history dimension agreeing', () => {
    const c = card({ groceries: 395, eating: 98, saved: 200 });
    expect(c.overall!.grade.startsWith('A')).toBe(true);
    expect(c.dims.find((d) => d.key === 'spending')!.grade.startsWith('A')).toBe(true);
    expect(c.dims.find((d) => d.key === 'history')!.score).toBeGreaterThanOrEqual(85);
    expect(c.provisional).toBe(false);
    expect(c.badges.map((b) => b.key)).toContain('under');
  });

  it('penalises an overspend, names the category and what drove it', () => {
    const c = card({ groceries: 400, eating: 190, saved: 200 });
    const eating = c.categories.find((x) => x.categoryId === 'eating-out')!;
    expect(eating.status).toBe('over');
    expect(eating.variance).toBe(9_000);
    expect(eating.drivers[0]).toMatchObject({ merchant: 'Nandos', amount: 19_000 });
    expect(c.overall!.score).toBeLessThan(card({ groceries: 400, eating: 100, saved: 200 }).overall!.score);
    expect(c.comment.join(' ')).toContain('Nandos');
  });

  it('measures the month against the history that came before it', () => {
    const c = card({ groceries: 700, eating: 150 }); // £850 against a £500 usual
    expect(c.history.point!.baseline).toBe(50_000);
    expect(c.history.point!.deviation).toBeCloseTo(0.7, 1);
    expect(c.history.lines[0]).toContain('above your usual');
    expect(c.dims.find((d) => d.key === 'history')!.score).toBeLessThan(60);
    expect(c.history.categories.find((x) => x.categoryId === 'groceries')!.direction).toBe('up');
  });

  it('is provisional when statements stop mid-month, and prorates the plan', () => {
    const s = scenario({ groceries: 200, eating: 50 }, '2026-04-15');
    const c = buildReportCard({ cycle: s.cycle, txns: s.txns, cats, schedules: [], coverage: s.coverage, history: s.history, startDay: 1 });
    expect(c.provisional).toBe(true);
    expect(c.coverage.share).toBeCloseTo(0.5, 1);
    expect(c.planned).toBe(Math.round(50_000 * c.coverage.share)); // the budget is scaled to the days covered
    expect(c.coverage.accounts[0]!.missing[0]!.start).toBe('2026-04-16');
    expect(c.comment.join(' ')).toContain('provisional');
  });

  it('leaves out dimensions that do not apply and still grades', () => {
    const c = card({ groceries: 400, eating: 100 }); // no savings, no debt
    expect(c.dims.map((d) => d.key)).toEqual(['spending', 'categories', 'history', 'savings']);
  });

  it('builds a waterfall that adds up from plan to actual', () => {
    const c = card({ groceries: 450, eating: 60 });
    const steps = c.waterfall;
    expect(steps[0]).toMatchObject({ label: 'Plan', kind: 'total' });
    expect(steps.at(-1)).toMatchObject({ label: 'Actual', kind: 'total' });
    const swings = steps.filter((s) => s.kind === 'delta').reduce((s, x) => s + x.value, 0);
    expect(steps[0]!.value + swings).toBe(steps.at(-1)!.value);
  });

  it('suggests resetting a budget that ran well over, and freeing one that ran well under', () => {
    const c = card({ groceries: 400, eating: 190 });
    const eating = c.suggestions.find((s) => s.categoryId === 'eating-out')!;
    expect(eating.to).toBeGreaterThanOrEqual(19_000);
    const under = card({ groceries: 200, eating: 100 }).suggestions.find((s) => s.categoryId === 'groceries')!;
    expect(under.to).toBeLessThan(under.from);
  });

  it('says so when there is no plan to grade against', () => {
    const s = scenario({ groceries: 400, eating: 100 });
    const cycle: CycleView = cycleView({ txns: s.txns, cats: DEFAULT_CATEGORIES, catMap: cats, budgets: [], plans: [], key: '2026-04', startDay: 1, today: '2026-05-02' });
    const c = buildReportCard({ cycle, txns: s.txns, cats, schedules: [], coverage: s.coverage, history: s.history, startDay: 1 });
    expect(c.hasPlan).toBe(false);
    expect(c.overall).toBeNull();
  });
});

describe('missingWithin', () => {
  it('lists the days a set of spans leaves uncovered', () => {
    expect(missingWithin([{ start: '2026-04-05', end: '2026-04-10' }, { start: '2026-04-20', end: '2026-04-25' }], '2026-04-01', '2026-04-30')).toEqual([
      { start: '2026-04-01', end: '2026-04-04' },
      { start: '2026-04-11', end: '2026-04-19' },
      { start: '2026-04-26', end: '2026-04-30' },
    ]);
    expect(missingWithin([{ start: '2026-03-01', end: '2026-05-30' }], '2026-04-01', '2026-04-30')).toEqual([]);
  });
});

describe('statement start day', () => {
  const f = (periodStart: string, periodEnd: string) => ({ id: periodStart, hash: '', name: '', format: 'pdf-hsbc', accountId: 'a', periodStart, periodEnd, txnCount: 1, addedCount: 1, reconciled: true, importedAt: 0 }) as never;
  it('finds the day monthly statements start on', () => {
    expect(statementStartDay([f('2026-07-20', '2026-08-19'), f('2026-08-20', '2026-09-19'), f('2026-09-20', '2026-10-19')])).toBe(20);
  });
  it('ignores long custom exports and says nothing when statements disagree', () => {
    expect(statementStartDay([f('2025-11-01', '2026-05-31')])).toBeNull();
    expect(statementStartDay([f('2026-07-20', '2026-08-19'), f('2026-08-03', '2026-09-02')])).toBeNull();
  });
});

describe('ordinal', () => {
  it('writes day numbers the way people say them', async () => {
    const { ordinal } = await import('../../../src/lib/dates');
    expect([1, 2, 3, 4, 11, 12, 13, 19, 20, 21, 22, 23, 28].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '19th', '20th', '21st', '22nd', '23rd', '28th']);
  });
});
