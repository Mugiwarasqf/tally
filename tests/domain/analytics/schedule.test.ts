import { describe, expect, it } from 'vitest';
import { toCatMap } from '../../../src/domain/analytics/aggregate';
import type { Recurring } from '../../../src/domain/analytics/recurring';
import { buildSchedules, checkDebt, checkRecurring } from '../../../src/domain/analytics/schedule';
import { DEFAULT_CATEGORIES } from '../../../src/domain/categorize/categories';
import type { Debt, Txn } from '../../../src/domain/types';

const rec = (dates: string[], cadence: Recurring['cadence'] = 'monthly', amount = 85_000): Recurring => ({
  key: 'out:rent', merchant: 'Rent', categoryId: 'housing', direction: 'out', cadence, amount,
  lastDate: dates.at(-1)!, nextDate: dates.at(-1)!, occurrences: dates.length, dates, gap: cadence === 'weekly' ? 7 : 30, annual: amount * 12,
});

const monthly = (months: number[], day = 1, year = 2026) => months.map((m) => `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`);

describe('checkRecurring', () => {
  const paid = monthly([1, 2, 3, 4, 5, 6]);

  it('flags consecutive missed payments when the statements cover the dates', () => {
    const s = checkRecurring(rec(paid), '2026-08-20'); // July and August 1st have no payment
    expect(s.status).toBe('missed');
    expect(s.missedInRow).toBe(2);
    expect(s.firstMissed).toBe('2026-07-01');
    expect(s.lastPaid).toBe('2026-06-01');
  });

  it('does NOT call a payment missed when the statements stop too soon after the due date', () => {
    // July 1st was due but the data only reaches July 4th: absence of evidence, not evidence of absence.
    const s = checkRecurring(rec(paid), '2026-07-04');
    expect(s.missedInRow).toBe(0);
    expect(s.status).toBe('pending');
  });

  it('reports ok when every due date was paid on time', () => {
    const s = checkRecurring(rec(paid), '2026-06-20');
    expect(s.status).toBe('ok');
    expect(s.missedInRow).toBe(0);
    expect(s.history.every((o) => o.state === 'paid')).toBe(true);
  });

  it('spots payments that keep arriving late', () => {
    const dates = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-12', '2026-05-10', '2026-06-01'];
    const s = checkRecurring(rec(dates), '2026-06-20');
    expect(s.lateCount).toBe(2);
    expect(s.history.filter((o) => o.state === 'late').map((o) => o.paidOn)).toEqual(['2026-04-12', '2026-05-10']);
  });

  it('a late payment is not also counted as a miss', () => {
    const dates = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-12'];
    const s = checkRecurring(rec(dates), '2026-04-30');
    expect(s.missedInRow).toBe(0);
    expect(s.status).toBe('late');
  });

  it('a payment after a miss ends the streak', () => {
    const dates = ['2026-01-01', '2026-02-01', '2026-04-01', '2026-05-01']; // March missed, then back on track
    const s = checkRecurring(rec(dates), '2026-05-20');
    expect(s.missedInRow).toBe(0);
    expect(s.history.find((o) => o.due === '2026-03-01')?.state).toBe('missed');
  });

  it('handles weekly rhythms', () => {
    const dates = ['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23', '2026-04-06']; // 30 Mar skipped
    const s = checkRecurring(rec(dates, 'weekly', 1_500), '2026-04-20');
    expect(s.history.some((o) => o.due === '2026-03-30' && o.state === 'missed')).toBe(true);
  });
});

describe('checkDebt', () => {
  const debt: Debt = { id: 'd1', name: 'TSB loan', kind: 'loan', balance: 300_000, asOf: '2026-01-01', apr: 9.9, minPayment: 14_000, dueDay: 6, match: 'tsb', createdAt: 0 };
  const cats = toCatMap(DEFAULT_CATEGORIES);
  const pay = (date: string, pence: number): Txn => ({
    id: date, accountId: 'a', fileId: 'f', date, amount: -pence, type: 'DD', merchant: 'TSB LOAN REPAY', mkey: 'tsb', detail: '', raw: 'TSB LOAN REPAY',
    categoryId: 'debt', catSource: 'rule', confidence: 1, reason: '',
  });

  it('classifies paid, partial and missed, and counts the unbroken run', () => {
    const txns = [pay('2026-01-06', 14_000), pay('2026-02-06', 14_000), pay('2026-03-06', 14_000), pay('2026-04-06', 5_000)]; // April short; May, June absent
    const s = checkDebt(debt, 14_000, txns, cats, '2026-06-20', '2026-01-01')!;
    expect(s.history.map((o) => o.state)).toEqual(['paid', 'paid', 'paid', 'partial', 'missed', 'missed']);
    expect(s.missedInRow).toBe(3);
    expect(s.firstMissed).toBe('2026-04-06');
    expect(s.status).toBe('missed');
  });

  it('ignores due dates before the balance date and before the data starts', () => {
    const s = checkDebt({ ...debt, asOf: '2026-03-10' }, 14_000, [pay('2026-04-06', 14_000)], cats, '2026-04-20', '2026-01-01')!;
    expect(s.history.map((o) => o.due)).toEqual(['2026-04-06']);
  });

  it('cannot check a debt with no due day or no way to recognise payments', () => {
    expect(checkDebt({ ...debt, dueDay: undefined }, 14_000, [], cats, '2026-06-20', '2026-01-01')).toBeNull();
    expect(checkDebt({ ...debt, match: undefined }, 14_000, [], cats, '2026-06-20', '2026-01-01')).toBeNull();
  });
});

describe('buildSchedules', () => {
  it('returns nothing until some statements exist', () => {
    expect(buildSchedules({ recurring: [], debts: [], expected: new Map(), txns: [], cats: toCatMap(DEFAULT_CATEGORIES), horizon: undefined, dataStart: undefined })).toEqual([]);
  });
});
