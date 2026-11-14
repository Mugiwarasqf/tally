import { describe, expect, it } from 'vitest';
import { categorize, looksLikePerson, matchesHolder, REVIEW_THRESHOLD } from '../../../src/domain/categorize/engine';
import { describe as describeTxn } from '../../../src/domain/categorize/merchant';
import type { Rule } from '../../../src/domain/types';

const HOLDERS = ['Jordan Quinn Example'];
const run = (type: string, amount: number, lines: string[], rules: Rule[] = []) => {
  const d = describeTxn(type, lines, amount);
  return { d, r: categorize({ type, amount, d }, { rules, holders: HOLDERS }) };
};

describe('merchant cleaning', () => {
  it('strips store numbers and applies the display name', () => {
    expect(run(')))', -420, ['TESCO STORES 1234', 'BRISTOL']).d.merchant).toBe('Tesco');
    expect(run(')))', -420, ['ASDA STORES 9876', 'LEICESTER']).d.mkey).toBe('asda');
  });

  it('skips INT’L reference lines and pulls FX details out', () => {
    const { d } = run('VIS', -5943, ["INT'L 0077505429", 'SOME SHOP', 'CITY', 'EUR 69.00 @ 1.1610', 'Visa Rate']);
    expect(d.merchant).toBe('Some Shop');
    expect(d.fx).toBe('EUR 69.00 @ 1.1610');
    expect(d.detail).toBe('CITY');
  });

  it('removes payment-processor prefixes', () => {
    expect(run(')))', -800, ['SumUp *CORNER CAFE', 'Leeds']).d.payee).toBe('CORNER CAFE');
  });
});

describe('categorize', () => {
  it('knows UK supermarkets and subscriptions', () => {
    expect(run(')))', -1200, ['LIDL GB LEEDS', 'LEEDS']).r.categoryId).toBe('groceries');
    expect(run('VIS', -1099, ["INT'L 0000000001", 'NETFLIX.COM']).r.categoryId).toBe('subscriptions');
    expect(run('VIS', -899, ['UBER *TRIP', 'LONDON']).r.categoryId).toBe('transport');
  });

  it('puts UBER EATS under eating out, not transport', () => {
    expect(run('VIS', -1599, ['UBER *EATS', 'LONDON']).r.categoryId).toBe('eating-out');
  });

  it('treats ATM rows as cash even when the machine is inside a shop', () => {
    const { r } = run('ATM', -2000, ['CASH TESCO JUL30', 'TESCO MANCH @17:18']);
    expect(r.categoryId).toBe('cash');
  });

  it('treats transfers to another account number as transfers', () => {
    const { r, d } = run('TFR', -10_000, ['112233 12345678', 'INTERNET TRANSFER']);
    expect(r.categoryId).toBe('transfer');
    expect(d.otherAccount).toBe('112233 12345678');
  });

  it('spots payments to and from the account holder', () => {
    expect(run('BP', -5000, ['J Example', 'Savings']).r.categoryId).toBe('transfer');
    expect(run('CR', 5000, ['Jordan Quinn', 'money']).r.categoryId).toBe('transfer');
    expect(run('BP', -5000, ['Jordan Smith', 'money']).r.categoryId).not.toBe('transfer');
  });

  it('classifies wages, refunds and card credits', () => {
    expect(run('CR', 230_000, ['Acme Payroll Ltd', 'Wages']).r.categoryId).toBe('salary');
    expect(run('CR', 3100, ['REVERSAL OF 10-09']).r.categoryId).toBe('refunds');
    expect(run('VIS', 3000, ['SOME SHOP', 'LONDON']).r.categoryId).toBe('refunds');
  });

  it('sends debt and remittance providers to the right places', () => {
    expect(run('VIS', -3376, ['ZILCH INSTALMENT', 'GB']).r.categoryId).toBe('debt');
    expect(run('VIS', -5000, ['LemFi', 'Austin']).r.categoryId).toBe('remittance');
  });

  it('applies the direction filter on dictionary entries', () => {
    expect(run('CR', 17_151, ['PAYPAL', 'PPWD123']).r.categoryId).toBe('other-income');
    expect(run('CR', 5000, ['Alex Rivers', 'thanks']).r.categoryId).toBe('from-people');
  });

  it('queues genuine unknowns for review', () => {
    const { r } = run(')))', -650, ['QWXZ TRADING', 'DERBY']);
    expect(r.categoryId).toBe('unsorted-out');
    expect(r.confidence).toBeLessThan(REVIEW_THRESHOLD);
  });

  it('lets user rules beat the dictionary, and learned rules beat built-ins', () => {
    const rule: Rule = { id: '1', kind: 'user', match: 'contains', pattern: 'tesco', categoryId: 'shopping', createdAt: 1 };
    expect(run(')))', -420, ['TESCO STORES 5566', 'X'], [rule]).r.categoryId).toBe('shopping');
    const learned: Rule = { id: '2', kind: 'learned', match: 'merchant', pattern: 'aldi', categoryId: 'eating-out', createdAt: 1 };
    const out = run(')))', -420, ['ALDI', 'X'], [learned]).r;
    expect(out.categoryId).toBe('eating-out');
    expect(out.source).toBe('learned');
  });
});

describe('name helpers', () => {
  it('matchesHolder handles initials, truncation and first-name-only', () => {
    const h = ['Morgan Taylor Westbrook'];
    expect(matchesHolder('M Westbrook', h)).toBe(true);
    expect(matchesHolder('M T Westbrook', h)).toBe(true);
    expect(matchesHolder('Morgan Westbroo', h)).toBe(true);
    expect(matchesHolder('Morgan', h)).toBe(true);
    expect(matchesHolder('Omar Ward', h)).toBe(false);
    expect(matchesHolder('Taylor Westbrook Stores', ['Alex Rivers'])).toBe(false);
  });

  it('does not treat someone who merely shares the first name as the holder', () => {
    expect(matchesHolder('Christopher Smith', ['Christopher Jones'])).toBe(false);
    expect(matchesHolder('Morgan Price', ['Morgan Taylor Westbrook'])).toBe(false);
  });

  it('looksLikePerson rejects businesses', () => {
    expect(looksLikePerson('Sam Carter')).toBe(true);
    expect(looksLikePerson('Acme Pay Ltd')).toBe(false);
    expect(looksLikePerson('Example Card')).toBe(false);
    expect(looksLikePerson('Shop 24')).toBe(false);
  });
});
