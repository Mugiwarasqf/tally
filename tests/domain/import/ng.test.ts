import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readNarration } from '../../../src/domain/categorize/narration';
import { buildTxns, accountKey } from '../../../src/domain/import/build';
import { analysePdf, analysePdfSections } from '../../../src/domain/import/generic';
import { pairReversals } from '../../../src/domain/import/pair';
import type { Txn } from '../../../src/domain/types';
import { fmt, fmtCompact, parseMoney, roundTo5 } from '../../../src/lib/money';
import { everyday, setRegion } from '../../../src/lib/region';
import { bankStatement, gluedValueDate, tallCellStatement, walletStatement } from '../../fixtures/ngPages';
import { headedStatement } from '../../fixtures/genericPages';
import { syntheticHsbc } from '../../fixtures/hsbcPages';

beforeEach(() => { setRegion('ng'); });
afterEach(() => { setRegion('uk'); });

describe('region', () => {
  it('formats, parses and scales amounts for the active currency', () => {
    expect(fmt(123_456_78)).toBe('₦123,456.78');
    expect(fmt(-500_000, { whole: true })).toBe('−₦5,000');
    expect(fmtCompact(250_000_000)).toBe('₦2.5m');
    expect(parseMoney('₦1,250.50')).toBe(125_050);
    expect(parseMoney('NGN 20.00')).toBe(2_000);
    expect(everyday(5)).toBe(500_000);
    expect(roundTo5(1_234_000)).toBe(1_000_000);
    setRegion('us');
    expect(fmt(1_999)).toBe('$19.99');
    setRegion('uk');
    expect(fmt(1_999)).toBe('£19.99');
    expect(everyday(5)).toBe(500);
  });
});

describe('Nigerian statement layouts', () => {
  it('reads a wallet statement holding two accounts, each proved three ways', () => {
    const [wallet, savings, ...rest] = analysePdfSections(walletStatement());
    expect(rest).toEqual([]);
    expect(wallet!.bank).toBe('OPay'); // only the product name "OWealth" identifies it
    expect(wallet!.account).toMatchObject({ holder: 'ADA EXAMPLE OKAFOR', number: '9012345678', label: 'Wallet Account' });
    expect(wallet!.currency).toBe('NGN');
    expect(wallet!.blocks).toBe(true);
    const w = wallet!.result;
    expect(w.verified).toBe(true);
    expect(w.parsed.checks.map((c) => [c.name, c.ok])).toEqual([['Running balance agrees', true], ['Closing balance agrees', true], ['Printed totals agree', true]]);
    // The same-minute pair is put back in the order the balance shows.
    expect(w.parsed.txns.map((t) => t.amount)).toEqual([500_000, -500_000, 100_000, -100_000]);
    expect(w.parsed.warnings.join(' ')).toMatch(/printed out of order/);
    expect(w.parsed.txns[0]).toMatchObject({ date: '2026-03-01', time: '09:00', ref: '260301000001', lines: ['Transfer from CHIDI TEST', '| OPay | 801****111'] });
    expect(w.parsed.txns[3]!.lines).toEqual(['Transfer to SAMPLE STORES LTD', '| Moniepoint | 5012345678']);

    expect(savings!.account.label).toBe('Savings Account');
    expect(savings!.result.verified).toBe(true);
    expect(savings!.result.parsed.opening).toBe(10_000);
    expect(savings!.result.parsed.txns.map((t) => t.amount)).toEqual([50, 500_000, -100_000]);
    expect(savings!.result.parsed.txns[2]!.lines).toEqual(['OWealth Withdrawal', '(Transaction Payment)']);
    // The two accounts never share an identity, even with one account number printed.
    expect(accountKey(w.parsed)).not.toBe(accountKey(savings!.result.parsed));
  });

  it('reads two-line dates, trusts the rows over a wrong printed opening balance, and keeps references', () => {
    const a = analysePdf(bankStatement());
    expect(a.bank).toBe('ALAT by Wema');
    expect(a.account).toMatchObject({ holder: 'Ada Example', number: '0123456789' });
    expect(a.result.verified).toBe(true);
    const p = a.result.parsed;
    expect(p.txns.map((t) => [t.date, t.amount])).toEqual([['2026-03-03', -200_000], ['2026-03-05', 1_000_000], ['2026-03-06', -500_000], ['2026-03-06', -1_000], ['2026-03-06', -75]]);
    expect(p.opening).toBe(1_000_000);
    expect(p.warnings.join(' ')).toMatch(/prints an opening balance of ₦8,000\.00/);
    expect(p.txns[0]).toMatchObject({ ref: 'S1000001', lines: ['POS Buy on 03-03-2026@Psk*AB1-Spotify'] });
  });

  it('reads tall cells whose remarks sit right of the balance, around amounts centred in the cell', () => {
    const [a, ...rest] = analysePdfSections(tallCellStatement());
    expect(rest).toEqual([]);
    expect(a!.result.verified).toBe(true);
    expect(a!.result.parsed.txns.map((t) => [t.amount, t.lines.length, t.lines[0]])).toEqual([
      [50_000, 4, 'TRANSFER BETWEEN CUSTOMERS VIA GAPS'], [-2_400, 2, 'VALUE ADDED TAX SMS ALERT CHARGE FOR'],
      [-180, 1, 'VALUE ADDED TAX VAT CHARGES'], [-50, 2, 'WITHHOLDING TAX 0123456789:WTax.Pd:01-03-2026to'],
      [500, 2, 'INTEREST CAPITALISED 0123456789:Int.Pd:01-03-2026'],
    ]);
    expect(a!.result.parsed.txns.map((t) => readNarration(t.lines, t.amount)?.lines[0])).toEqual([
      'Dividend', 'SMS alert charges', 'VAT on bank charge', 'Withholding tax on interest', 'Interest',
    ]);
  });

  it('splits an amount printed together with the value date beside it', () => {
    const a = analysePdf(gluedValueDate());
    expect(a.result.verified).toBe(true);
    expect(a.result.parsed.txns.map((t) => [t.date, t.amount])).toEqual([['2026-03-27', -5_000], ['2026-03-31', 600], ['2026-03-31', -60]]);
    expect(a.result.parsed.txns.map((t) => readNarration(t.lines, t.amount)?.type)).toEqual(['FEE', 'INT', 'TAX']);
  });

  it('turns a statement in the wrong currency away with a reason', () => {
    setRegion('uk');
    const a = analysePdf(bankStatement());
    expect(a.result.verified).toBe(false);
    expect(a.result.reason).toMatch(/in naira/);
    setRegion('ng');
    expect(analysePdf(syntheticHsbc()).result.reason).toMatch(/in pounds/);
  });
});

describe('Nigerian narrations', () => {
  const read = (s: string, amount = -100) => readNarration([s], amount);

  it('names bank charges, tax and interest', () => {
    expect(read('COMM ALAT NIP TRANSFER TO A B FROM C D')).toMatchObject({ type: 'FEE', lines: ['Transfer charge', expect.any(String)] });
    expect(read('VAT ALAT NIP TRANSFER TO A B FROM C D')?.lines[0]).toBe('VAT on bank charge');
    expect(read('Vat CARD MAINTENANCE FEE MASTERCARD,Q1 2026')?.lines[0]).toBe('VAT on bank charge');
    expect(read('CARD MAINTENANCE FEE MASTERCARD,Q1 2026')?.lines[0]).toBe('Card fee');
    expect(read('SMS Alert Charges for JAN 25 to FEB 24, 2026')?.lines[0]).toBe('SMS alert charges');
    expect(read('STAMP DUTY ON: S123 01-MAR-26')?.lines[0]).toBe('Stamp duty');
    expect(read('Electronic Money Transfer Levy')?.lines[0]).toBe('Transfer levy (EMTL)');
    expect(read('0123456789:WTax.Pd:01-03-2026to 31-03-2026')?.type).toBe('TAX');
    expect(read('0123456789:Int.Pd:01-03-2026 to 31-03-2026', 51)?.type).toBe('INT');
    expect(read('OWealth Interest Earned', 9)?.type).toBe('INT');
    expect(read('VAT refund', 100)?.type).not.toBe('FEE'); // a credit is never a charge
  });

  it('reads transfers, card payments, airtime, pots, POS agents and reversals', () => {
    expect(read('ALAT NIP TRANSFER TO SAMPLE PERSON TWO FROMADA EXAMPLE')).toEqual({ type: 'BP', lines: ['Sample Person Two', 'NIP transfer'] });
    expect(read('Transfer from TEST, PERSON THREE | Kuda MFB | 201****102', 500)).toEqual({ type: 'CR', lines: ['Test Person Three', 'Kuda MFB'] });
    expect(read('NIP:TEST PERSON ONE-Rent share', 500)).toEqual({ type: 'CR', lines: ['Test Person One', 'Rent share'] });
    expect(read('POS Buy on 03-03-2026@Psk*AB1-Spotify')?.lines[0]).toBe('Spotify');
    expect(read('WEB Buy on 01-03-2026@SPOTIFY_XYZ123')?.lines[0]).toBe('SPOTIFY');
    expect(read('Airtime | 9012345678 | MTN')?.lines[0]).toBe('Airtime · MTN');
    expect(read('Betting | 9012345678 | SPORTYBET')?.lines[0]).toBe('Betting · Sportybet');
    expect(read('Auto-save to OWealth Balance')?.type).toBe('POT');
    expect(read('Transfer to POS Transfer - SAMPLE AGENT | Moniepoint | 5012345678')).toMatchObject({ type: 'POS', lines: ['POS transfer · Sample Agent', expect.any(String)] });
    expect(read('ALAT NIP TRANSFER REVERSAL TO NIP TRANSFER TO A B', 500)?.lines[0]).toBe('Transfer reversal');
  });

  it('categorises a statement and links each charge to its payment', () => {
    const parsed = analysePdf(bankStatement()).result.parsed;
    const txns = buildTxns(parsed, 'a1', 'f1', { rules: [], holders: ['Ada Example'] });
    expect(txns.map((t) => [t.merchant, t.categoryId])).toEqual([
      ['Spotify', 'subscriptions'], ['Test Person One', 'from-people'], ['Sample Person Two', 'family'], ['Transfer charge', 'fees'], ['VAT on bank charge', 'fees'],
    ]);
    expect(txns[3]!.detail).toBe('On Sample Person Two (−₦5,000.00, 2026-03-06)');
    expect(txns[4]!.detail).toBe('On Sample Person Two (−₦5,000.00, 2026-03-06)');
    // People always go to the review queue once; the answer becomes a rule.
    expect(txns[2]!.confidence).toBeLessThan(0.7);
  });

  it('leaves UK statements alone', () => {
    setRegion('uk');
    const txns = buildTxns(analysePdf(headedStatement()).result.parsed, 'a1', 'f1', { rules: [], holders: [] });
    expect(txns.every((t) => t.type === '')).toBe(true);
  });
});

describe('reversals', () => {
  const tx = (id: string, date: string, amount: number, raw: string, categoryId: string, catSource: Txn['catSource'] = 'heuristic'): Txn => ({
    id, accountId: 'a', fileId: 'f', date, amount, type: '', merchant: raw, mkey: raw, detail: '', raw, categoryId, catSource, confidence: 0.65, reason: '',
  });

  it('gives money that came back the category of the payment it reverses', () => {
    const txns = [tx('o', '2026-03-01', -500_000, 'NIP TRANSFER TO A B', 'family'), tx('r', '2026-03-02', 500_000, 'NIP TRANSFER REVERSAL TO A B', 'refunds')];
    const p = pairReversals(txns);
    expect(p.find((x) => x.id === 'r')!.patch).toMatchObject({ categoryId: 'family', catSource: 'pair' });
    expect(p.find((x) => x.id === 'o')!.patch.confidence).toBe(0.9);
  });

  it('never touches a reversal the user categorised, or one with nothing to match', () => {
    expect(pairReversals([tx('o', '2026-03-01', -500_000, 'X', 'family'), tx('r', '2026-03-02', 500_000, 'REVERSAL', 'gifts', 'manual')])).toEqual([]);
    expect(pairReversals([tx('o', '2026-03-01', -400_000, 'X', 'family'), tx('r', '2026-03-02', 500_000, 'REVERSAL', 'refunds')])).toEqual([]);
  });
});
