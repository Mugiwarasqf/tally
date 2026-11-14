import { describe, expect, it } from 'vitest';
import { toCatMap } from '../../../src/domain/analytics/aggregate';
import { findRent, rentPatternPatches } from '../../../src/domain/analytics/rent';
import { DEFAULT_CATEGORIES } from '../../../src/domain/categorize/categories';
import type { Txn } from '../../../src/domain/types';

const cats = toCatMap(DEFAULT_CATEGORIES);
let n = 0;
const pay = (date: string, pounds: number, payee: string, over: Partial<Txn> = {}): Txn => ({
  id: `t${n++}`, accountId: 'a', fileId: 'f', date, amount: -pounds * 100, type: 'BP', merchant: payee, mkey: payee.toLowerCase().replace(/[^a-z]+/g, ' ').trim(),
  detail: '', raw: payee, categoryId: 'family', catSource: 'heuristic', confidence: 0.72, reason: '', ...over,
});
const monthly = (payee: string, pounds: number, day = '03', months = ['06', '07', '08', '09', '10'], over: Partial<Txn> = {}) =>
  months.map((m) => pay(`2026-${m}-${day}`, pounds, payee, over));

describe('rent detection by pattern', () => {
  it('finds the same amount to the same person on a steady early-month day', () => {
    const rent = findRent(monthly('Sam Carter', 850), cats, '2026-10-20')!;
    expect(rent).toMatchObject({ merchant: 'Sam Carter', amount: 85_000, day: 3 });
  });

  it('labels it housing, with a reason and low enough confidence to be reviewed', () => {
    const patches = rentPatternPatches(monthly('Sam Carter', 850), cats, '2026-10-20');
    expect(patches).toHaveLength(5);
    expect(patches[0]!.patch).toMatchObject({ categoryId: 'housing', catSource: 'heuristic' });
    expect(patches[0]!.patch.confidence).toBeLessThan(0.7);
    expect(patches[0]!.patch.reason).toContain('looks like rent');
  });

  it('picks the largest candidate when several payments repeat', () => {
    const txns = [...monthly('Sam Carter', 850), ...monthly('Mum', 300, '05')];
    expect(findRent(txns, cats, '2026-10-20')!.merchant).toBe('Sam Carter');
  });

  it('ignores amounts that vary, card payments, small sums and anything already decided', () => {
    const varying = monthly('Sam Carter', 850).map((t, i) => ({ ...t, amount: t.amount - i * 6000 }));
    expect(findRent(varying, cats, '2026-10-20')).toBeNull();
    expect(findRent(monthly('Gym Ltd', 850, '03', undefined, { type: ')))' }), cats, '2026-10-20')).toBeNull();
    expect(findRent(monthly('Friend', 120), cats, '2026-10-20')).toBeNull(); // under £300
    expect(findRent(monthly('Sam Carter', 850, '03', undefined, { catSource: 'manual' }), cats, '2026-10-20')).toBeNull();
    expect(findRent(monthly('Sam Carter', 850, '03', undefined, { categoryId: 'housing', catSource: 'dictionary' }), cats, '2026-10-20')).toBeNull();
  });

  it('does not treat two payments, or an erratic day, as rent', () => {
    expect(findRent(monthly('Sam Carter', 850, '03', ['09', '10']), cats, '2026-10-20')).toBeNull();
    const erratic = ['06-02', '07-17', '08-26', '09-09', '10-21'].map((d) => pay(`2026-${d}`, 850, 'Sam Carter'));
    expect(findRent(erratic, cats, '2026-10-25')).toBeNull();
  });
});
