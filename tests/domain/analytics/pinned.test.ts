import { describe, expect, it } from 'vitest';
import { toCatMap } from '../../../src/domain/analytics/aggregate';
import { detectRecurring, dueSoon, likelyRecurring, withPinned } from '../../../src/domain/analytics/recurring';
import { DEFAULT_CATEGORIES } from '../../../src/domain/categorize/categories';
import type { Txn } from '../../../src/domain/types';

// Invented fixtures, shaped like a phone bill and a card repayment.
const cats = toCatMap(DEFAULT_CATEGORIES);
let n = 0;
const out = (date: string, pence: number, merchant: string, categoryId = 'bills'): Txn => ({
  id: `t${n++}`, accountId: 'a', fileId: 'f', date, amount: -pence, type: 'VIS', merchant, mkey: merchant.toLowerCase(),
  detail: '', raw: merchant, categoryId, catSource: 'dictionary', confidence: 0.92, reason: '',
});

describe('recurring payments the user marks themselves', () => {
  const txns = [out('2026-10-19', 1050, 'PhoneCo'), out('2026-09-18', 200, 'CardCo', 'debt'), out('2026-09-30', 1000, 'CardCo', 'debt')];

  it('detection alone cannot see a bill paid once', () => {
    expect(detectRecurring(txns, cats, '2026-10-19')).toHaveLength(0);
  });

  it('a pin makes it recurring from a single payment, with the user’s rhythm and amount', () => {
    const r = withPinned([], [{ key: 'out:phoneco', cadence: 'monthly', amount: 1050 }], txns);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ merchant: 'PhoneCo', cadence: 'monthly', amount: 1050, nextDate: '2026-11-19', annual: 12_600, occurrences: 1, pinned: true, categoryId: 'bills' });
  });

  it('uses the declared amount even when past payments varied', () => {
    const [r] = withPinned([], [{ key: 'out:cardco', cadence: 'monthly', amount: 1000 }], txns);
    expect(r).toMatchObject({ amount: 1000, occurrences: 2, lastDate: '2026-09-30', nextDate: '2026-10-30', categoryId: 'debt' });
  });

  it('replaces a detected entry for the same payee instead of listing it twice', () => {
    const detected = [{ key: 'out:phoneco', merchant: 'PhoneCo', categoryId: 'bills', direction: 'out' as const, cadence: 'monthly' as const, amount: 999, lastDate: '2026-10-19', nextDate: '2026-11-19', occurrences: 3, dates: [], gap: 30, annual: 11_988 }];
    const r = withPinned(detected, [{ key: 'out:phoneco', cadence: 'monthly', amount: 1050 }], txns);
    expect(r).toHaveLength(1);
    expect(r[0]!.amount).toBe(1050);
  });

  it('skips a pin with nothing on the statements', () => {
    expect(withPinned([], [{ key: 'out:gone', cadence: 'monthly', amount: 500 }], txns)).toHaveLength(0);
  });
});

describe('coming up, counted from today', () => {
  const sub = { key: 'out:aico', merchant: 'AICo', categoryId: 'subscriptions', direction: 'out' as const, cadence: 'monthly' as const, amount: 1800, lastDate: '2026-10-19', nextDate: '2026-11-19', occurrences: 3, dates: [], gap: 30, annual: 21_600 };

  it('includes a payment due five days after today even when statements ended weeks ago', () => {
    const [u] = dueSoon([sub], '2026-11-14');
    expect(u).toMatchObject({ date: '2026-11-19', projected: false });
  });

  it('rolls a due date the statements never reached forward to the next one', () => {
    const [u] = dueSoon([{ ...sub, nextDate: '2026-10-02' }], '2026-11-14');
    expect(u).toMatchObject({ date: '2026-12-02', projected: true });
  });

  it('leaves out anything beyond the window', () => {
    expect(dueSoon([sub], '2026-10-01')).toHaveLength(0);
  });
});

describe('likely recurring suggestions', () => {
  const mk = (date: string, pence: number, merchant: string, categoryId: string, type = 'VIS'): Txn => ({ ...out(date, pence, merchant, categoryId), type });

  it('suggests a phone bill seen once, explains why, and defaults to monthly', () => {
    const [s] = likelyRecurring([mk('2026-10-19', 1050, 'PhoneCo', 'bills')], cats, [], []);
    expect(s).toMatchObject({ merchant: 'PhoneCo', amount: 1050, cadence: 'monthly' });
    expect(s!.reasons.join(' ')).toMatch(/phone, energy/);
  });

  it('suggests anything on a Direct Debit, even in an everyday category', () => {
    const [s] = likelyRecurring([mk('2026-10-03', 2500, 'GymCo', 'groceries', 'DD')], cats, [], []);
    expect(s!.reasons[0]).toBe('Paid by Direct Debit');
  });

  it('never suggests everyday card spending, however often', () => {
    const rides = ['01', '08', '15', '22', '29'].map((d) => mk(`2026-10-${d}`, 500, 'RideCo', 'transport'));
    expect(likelyRecurring(rides, cats, [], [])).toHaveLength(0);
  });

  it('skips payees already recurring or dismissed', () => {
    const t = [mk('2026-10-19', 1050, 'PhoneCo', 'bills')];
    expect(likelyRecurring(t, cats, [], ['out:phoneco'])).toHaveLength(0);
  });
});
