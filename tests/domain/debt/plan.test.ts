import { describe, expect, it } from 'vitest';
import { affordability, paymentForMonths, simulate } from '../../../src/domain/debt/plan';
import type { DebtState } from '../../../src/domain/debt/plan';

const debt = (id: string, balance: number, apr: number, min: number): DebtState => ({ id, name: id, balance, apr, min });

describe('simulate', () => {
  it('matches the amortisation formula for a single debt', () => {
    // £1,000 at 20% APR paying £100 a month clears in 11.03 months → 12 payments.
    const r = simulate([debt('a', 100_000, 20, 5_000)], 10_000, 'avalanche', '2026-12');
    expect(r.payoffMonths).toBe(12);
    expect(r.months.at(-1)!.balance).toBe(0);
    expect(r.totalPaid).toBe(100_000 + r.totalInterest);
  });

  it('charges no interest on a 0% debt', () => {
    const r = simulate([debt('bnpl', 60_000, 0, 5_000)], 5_000, 'avalanche', '2026-12');
    expect(r.payoffMonths).toBe(12);
    expect(r.totalInterest).toBe(0);
  });

  it('puts the extra on the highest APR first (avalanche) and the smallest balance first (snowball)', () => {
    const debts = [debt('card', 200_000, 24, 5_000), debt('loan', 100_000, 6, 5_000), debt('small', 20_000, 0, 2_000)];
    const av = simulate(debts, 40_000, 'avalanche', '2026-12');
    const sn = simulate(debts, 40_000, 'snowball', '2026-12');
    expect(av.months[0]!.payments.card!).toBeGreaterThan(av.months[0]!.payments.small!);
    expect(sn.clearedAt.small).toBeLessThan(sn.clearedAt.card!);
    expect(av.totalInterest).toBeLessThanOrEqual(sn.totalInterest); // avalanche is never worse on interest
  });

  it('rolls a cleared debt’s minimum into the rest', () => {
    const r = simulate([debt('a', 10_000, 0, 5_000), debt('b', 100_000, 0, 5_000)], 10_000, 'snowball', '2026-12');
    expect(r.clearedAt.a).toBe(2);
    expect(r.months[2]!.payments.b).toBe(10_000); // a's £50 rolled onto b
  });

  it('reports "never" when payments cannot beat interest', () => {
    const r = simulate([debt('hole', 1_000_000, 30, 5_000)], 5_000, 'avalanche', '2026-12');
    expect(r.payoffMonths).toBeNull();
  });

  it('never pays more than is owed', () => {
    // £300 at 10% APR: first month's interest is £2.50, so the whole debt is £302.50.
    const r = simulate([debt('a', 30_000, 10, 20_000)], 500_000, 'avalanche', '2026-12');
    expect(r.payoffMonths).toBe(1);
    expect(r.totalPaid).toBe(30_250);
    expect(r.months.every((m) => Object.values(m.balances).every((b) => b >= 0))).toBe(true);
  });
});

describe('paymentForMonths', () => {
  it('finds the smallest payment that meets the deadline', () => {
    const debts = [debt('card', 300_000, 22.9, 8_000), debt('loan', 150_000, 8.9, 6_000)];
    const p = paymentForMonths(debts, 18, 'avalanche', '2026-12')!;
    expect(simulate(debts, p, 'avalanche', '2026-12').payoffMonths).toBeLessThanOrEqual(18);
    expect(simulate(debts, p - 200, 'avalanche', '2026-12').payoffMonths ?? 999).toBeGreaterThan(18);
  });
});

describe('affordability', () => {
  it('keeps a 10% buffer and offers rungs between the minimum and the surplus', () => {
    const a = affordability(200_000, 120_000, 10_000, 15_000, 500_000);
    expect(a.available).toBe(70_000);
    expect(a.buffer).toBe(20_000);
    expect(a.minimum).toBe(15_000);
    expect(a.balanced).toBe(32_500);
    expect(a.fast).toBe(43_000);
    expect(a.ceiling).toBeLessThanOrEqual(50_000);
    expect(a.shortfall).toBe(0);
  });

  it('flags a shortfall when the minimums do not fit', () => {
    const a = affordability(100_000, 90_000, 0, 20_000, 300_000);
    expect(a.shortfall).toBe(10_000);
    expect(a.balanced).toBe(20_000);
  });

  it('never suggests paying more than the total owed', () => {
    const a = affordability(500_000, 100_000, 0, 5_000, 30_000);
    expect(a.fast).toBeLessThanOrEqual(30_000);
  });
});
