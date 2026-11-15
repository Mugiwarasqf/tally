import { describe, expect, it } from 'vitest';
import { analysePdfSections } from '../../../src/domain/import/generic';
import { setRegion } from '../../../src/lib/region';
import { accountWithPot, categoryColumn, noBalanceColumn, offsetPages, taggedStatement } from '../../fixtures/ukPages';

describe('more UK statement layouts', () => {
  it('ignores invisible accessibility text, reads the Type column, and skips a key that looks like a table', () => {
    const [a, ...rest] = analysePdfSections(taggedStatement());
    expect(rest).toEqual([]);
    const p = a!.result.parsed;
    expect(a!.result.verified).toBe(true);
    expect(a!.roles).toEqual(['in', 'out', 'balance']);
    expect(p.txns.map((t) => [t.date, t.amount, t.type])).toEqual([
      ['2026-03-01', 5_000, 'CR'], ['2026-03-02', -1_250, 'VIS'], ['2026-03-03', -2_000, 'BP'], ['2026-03-03', 1_000, 'CR'],
    ]);
    // Nothing from the page-turn note or the code key on page 2 leaks into a description.
    expect(p.txns.map((t) => t.lines)).toEqual([['SAMPLE PERSON'], ['SAMPLE STORES'], ['SAMPLE PERSON'], ['SAMPLE EMPLOYER']]);
  });

  it('splits an account and its pot by their titles, and reads values printed above their labels', () => {
    const [main, pot, ...rest] = analysePdfSections(accountWithPot());
    expect(rest).toEqual([]);
    expect(main!.account.label).toBe('Personal Account');
    expect(main!.result.verified).toBe(true);
    expect(main!.outside).toMatchObject({ totalOut: -3_100, totalIn: 5_000 });
    expect(main!.result.parsed.checks.find((c) => c.name.startsWith('Printed totals'))?.ok).toBe(true);
    // Newest-first rows put back in order; the wrapped description stays with its own amount.
    expect(main!.result.parsed.txns.map((t) => [t.date, t.amount, t.type, t.lines.join(' / ')])).toEqual([
      ['2026-03-02', -2_000, 'POT', 'Savings pot / Transfer to Pot'], ['2026-03-03', -1_000, '', 'SAMPLE MOBILE LIMITED / London GBR'],
      ['2026-03-04', 5_000, '', 'SAMPLE FRIEND (Faster Payments) / Reference: Thanks'], ['2026-03-05', -100, 'POT', 'Savings pot / Transfer to Pot'],
    ]);
    expect(pot!.account.label).toBe('Rainy Day');
    expect(pot!.result.parsed.txns).toHaveLength(2);
    expect(pot!.result.verified).toBe(true);
    expect(pot!.outside).toMatchObject({ totalOut: 0, totalIn: 2_100 });
  });
});

describe('pages that move, and statements with no balance column', () => {
  it('lines up a page printed at an offset, keeps one account for a repeated summary, and leaves "On / 07 Sep" in the description', () => {
    const [a, ...rest] = analysePdfSections(offsetPages());
    expect(rest).toEqual([]);
    expect(a!.roles).toEqual(['out', 'in', 'balance']);
    expect(a!.result.verified).toBe(true);
    expect(a!.result.parsed.txns.map((t) => [t.date.slice(5), t.amount, t.lines.join(' / ')])).toEqual([
      ['09-02', -500, 'Card Payment to Sample Cafe On / 01 Sep'], ['09-03', -600, 'Card Payment to Sample Books'],
      ['09-05', 3_000, 'Received from Sample Ltd'], ['09-06', -1_000, 'Card Payment to Sample Shop On / 05 Sep'],
    ]);
  });

  it('proves a statement with no balance column from its beginning and ending balances', () => {
    setRegion('us');
    try {
      const [a] = analysePdfSections(noBalanceColumn());
      expect(a!.result.parsed.txns.map((t) => t.amount)).toEqual([50_000, -4_210, -6_000, 1_210]);
      expect(a!.result.verified).toBe(true);
      expect(a!.result.parsed.checks.map((c) => [c.name, c.ok])).toEqual([['Opening and closing balances agree', true]]);
    } finally {
      setRegion('uk');
    }
  });
});

describe('payment types from a Category column and from the wording', () => {
  it('joins a name that wrapped, keeps separate lines apart, and reads the kind of each payment', () => {
    const [a, ...rest] = analysePdfSections(categoryColumn());
    expect(rest).toEqual([]);
    expect(a!.result.verified).toBe(true);
    expect(a!.result.parsed.txns.map((t) => [t.type, t.lines])).toEqual([
      ['CR', ['SAMPLE SERVICES LTD']],
      ['VIS', ['SAMPLE COFFEE', 'London']],
      ['BP', ['SAMPLE FRIEND']],
      ['POT', ['Savings pot', 'To GBP Savings']],
      ['POT', ['Savings pot', 'From GBP Savings']],
    ]);
  });
});
