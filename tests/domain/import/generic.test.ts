import { describe, expect, it } from 'vitest';
import { analysePdf, layoutFrom, readPdfWith } from '../../../src/domain/import/generic';
import { parseHsbc } from '../../../src/domain/import/hsbc';
import { ImportError } from '../../../src/domain/import/types';
import { headedStatement, noBalance, signedNoYear, signedWithFees, text, unlabelled, unsignedAmounts } from '../../fixtures/genericPages';
import { syntheticHsbc } from '../../fixtures/hsbcPages';

const amounts = (a: ReturnType<typeof analysePdf>) => a.result.parsed.txns.map((t) => t.amount);

describe('generic PDF reader', () => {
  it('reads a headed statement across pages and proves it with the balance', () => {
    const a = analysePdf(headedStatement());
    expect(a.result.verified).toBe(true);
    expect(a.roles).toEqual(['out', 'in', 'balance']);
    expect(a.bank).toBe('Barclays');
    expect(a.account).toEqual({ sortCode: '11-22-33', number: '87654321' });
    const p = a.result.parsed;
    expect(p.format).toBe('pdf-generic');
    expect(p.opening).toBe(50_000);
    expect(p.closing).toBe(157_650);
    expect(amounts(a)).toEqual([-350, 120_000, -2_000, -10_000, -1_299, 1_299]);
    expect(p.txns[0]).toMatchObject({ date: '2026-03-02', lines: ['CARD PAYMENT TO GREGGS', 'ON 01 MAR'], balance: 49_650 });
    expect(p.txns[5]!.date).toBe('2026-03-08');
    expect(p.checks.every((c) => c.ok)).toBe(true);
  });

  it('handles a signed amount column with no year printed on the rows, across New Year', () => {
    const a = analysePdf(signedNoYear());
    expect(a.result.verified).toBe(true);
    expect(a.roles).toEqual(['amount', 'balance']);
    expect(a.result.parsed.txns.map((t) => t.date)).toEqual(['2025-12-30', '2025-12-31', '2026-01-02', '2026-01-03']);
    expect(amounts(a)).toEqual([-420, 5_000, -1_240, -3_340]);
    expect(a.result.parsed.warnings).toEqual([]);
  });

  it('puts newest-first statements back into date order', () => {
    const a = analysePdf(signedNoYear({ descending: true }));
    expect(a.result.verified).toBe(true);
    expect(a.result.parsed.txns.map((t) => t.date)).toEqual(['2025-12-30', '2025-12-31', '2026-01-02', '2026-01-03']);
    expect(amounts(a)).toEqual([-420, 5_000, -1_240, -3_340]);
  });

  it('takes the direction from the balance when amounts carry no sign', () => {
    const a = analysePdf(unsignedAmounts());
    expect(a.result.verified).toBe(true);
    expect(amounts(a)).toEqual([-2_500, 90_000, -70_000]);
  });

  it('works out unlabelled columns from the running balance', () => {
    const a = analysePdf(unlabelled());
    expect(a.columns.map((c) => c.label)).toEqual(['', '', '']);
    expect(a.roles).toEqual(['out', 'in', 'balance']);
    expect(a.result.verified).toBe(true);
    expect(amounts(a)).toEqual([4_000, -950, -1_500, 6_000]);
    expect(a.result.parsed.txns[0]!.date).toBe('2026-05-01');
  });

  it('reads a signed "Money in/out" column, splits fees out and ignores always-zero columns', () => {
    const a = analysePdf(signedWithFees());
    expect(a.result.verified).toBe(true);
    expect(a.columns.map((c) => c.label)).toEqual(['', 'Balance', 'Tax withheld', 'Fees']);
    expect(a.roles).toEqual(['amount', 'balance', 'ignore', 'fee']);
    expect(a.result.parsed.txns.map((t) => [t.amount, t.type])).toEqual([[10_000, ''], [-320, ''], [-2_000, ''], [-100, 'FEE'], [-980, '']]);
  });

  it('never calls a statement with no balance column verified', () => {
    const a = analysePdf(noBalance());
    expect(a.roles).toEqual(['out', 'in']);
    expect(a.result.verified).toBe(false);
    expect(a.result.reason).toMatch(/no balance column/);
    expect(amounts(a)).toEqual([-3_000, 12, -1_050]);
  });

  it('reads the HSBC layout as well as the dedicated parser does', () => {
    const a = analysePdf(syntheticHsbc());
    const h = parseHsbc(syntheticHsbc());
    expect(a.result.verified).toBe(true);
    expect(a.result.parsed.txns.map((t) => [t.date, t.amount, t.balance])).toEqual(h.txns.map((t) => [t.date, t.amount, t.balance]));
    expect(a.result.parsed.txns[0]!.lines).toEqual(['CR Acme Payroll Ltd', 'Wages']);
    expect(a.bank).toBe('HSBC');
  });

  it('flags a wrong manual choice, and re-reads instantly with a corrected one', () => {
    const a = analysePdf(headedStatement());
    const wrong = readPdfWith(a, ['in', 'out', 'balance'], a.dateOrder);
    expect(wrong.verified).toBe(false);
    expect(wrong.parsed.checks.find((c) => c.name.startsWith('Running'))!.ok).toBe(false);
    expect(readPdfWith(a, a.roles, a.dateOrder).verified).toBe(true);
  });

  it('uses a remembered layout for the same bank and columns', () => {
    const first = analysePdf(noBalance());
    const saved = layoutFrom(first, ['in', 'out'], 'dmy', 1);
    const again = analysePdf(noBalance(), { saved: [saved] });
    expect(again.fromSaved).toBe(true);
    expect(again.roles).toEqual(['in', 'out']);
  });

  it('refuses a PDF that has no transaction table', () => {
    expect(() => analysePdf([[text(50, 700, 'Terms and conditions'), text(50, 680, 'Page 1 of 1')]])).toThrow(ImportError);
  });
});
