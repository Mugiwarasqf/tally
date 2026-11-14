import { describe, expect, it } from 'vitest';
import { isHsbcStatement, parseHsbc } from '../../../src/domain/import/hsbc';
import { syntheticHsbc } from '../../fixtures/hsbcPages';

describe('HSBC parser (synthetic statement)', () => {
  const s = parseHsbc(syntheticHsbc());

  it('recognises the layout', () => {
    expect(isHsbcStatement(syntheticHsbc())).toBe(true);
    expect(isHsbcStatement([[{ str: 'Some other bank', x: 10, y: 10, w: 50 }]])).toBe(false);
  });

  it('reads account details and period', () => {
    expect(s.account).toMatchObject({ holder: 'Alex Example', sortCode: '12-34-56', number: '12345678' });
    expect(s.periodStart).toBe('2026-08-20');
    expect(s.periodEnd).toBe('2026-08-21');
    expect(s.opening).toBe(10_000);
    expect(s.closing).toBe(85_450);
  });

  it('extracts every transaction with the right sign, date and lines', () => {
    expect(s.txns).toHaveLength(4);
    expect(s.txns[0]).toMatchObject({ date: '2026-08-20', type: 'CR', amount: 100_000, lines: ['Acme Payroll Ltd', 'Wages'] });
    expect(s.txns[1]).toMatchObject({ date: '2026-08-20', type: 'VIS', amount: -2_550, balance: 107_450, lines: ['TESCO STORES 1234', 'LONDON'] });
  });

  it('carries the date across the page break', () => {
    expect(s.txns[2]).toMatchObject({ date: '2026-08-20', type: 'TFR', amount: -20_000, balance: 87_450 });
    expect(s.txns[3]).toMatchObject({ date: '2026-08-21', type: 'ATM', amount: -2_000 });
  });

  it('passes every self-check when the statement is consistent', () => {
    expect(s.checks.length).toBeGreaterThanOrEqual(3);
    expect(s.checks.every((c) => c.ok)).toBe(true);
  });

  it('fails the totals check when the printed total disagrees', () => {
    const bad = parseHsbc(syntheticHsbc({ breakTotals: true }));
    const totals = bad.checks.find((c) => c.name.startsWith('Totals'))!;
    expect(totals.ok).toBe(false);
    expect(totals.detail).toContain('£999.99');
  });
});
