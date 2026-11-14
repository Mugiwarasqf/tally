import { describe, expect, it } from 'vitest';
import { categorize } from '../../../src/domain/categorize/engine';
import { describe as describeTxn } from '../../../src/domain/categorize/merchant';
import { isRevolutStatement, parseRevolut } from '../../../src/domain/import/revolut';
import type { PdfItem, PdfPage } from '../../../src/domain/import/types';

// An invented Revolut statement, laid out at the column positions the real PDFs use. No real data.
const it_ = (str: string, x: number, y: number): PdfItem => ({ str, x, y, w: str.length * 4.5 });
const header = (y: number): PdfItem[] => [
  it_('Money in', 343, y + 6), it_('Tax', 428, y + 6), it_('Other', 470, y + 6),
  it_('Date', 40, y), it_('Description', 125, y), it_('Category', 258, y), it_('Balance', 385, y), it_('Fees', 537, y),
  it_('/out', 343, y - 6), it_('withheld', 428, y - 6), it_('taxes', 470, y - 6),
];
const row = (y: number, date: string, desc: string, cat: string, money: string, bal: string, fee = '£0.00'): PdfItem[] => [
  it_(date, 40, y), it_(desc, 125, y), it_(cat, 258, y), it_(money, 343, y), it_(bal, 385, y), it_('£0.00', 428, y), it_('£0.00', 470, y), it_(fee, 533, y),
];

const summary: PdfPage = [
  it_('Custom Statement', 384, 756), it_('1 Jan 2026 - 31 Jan 2026', 458, 743), it_('Generated on the 31 Jan 2026', 443, 731),
  it_('ALEX TEST PERSON', 40, 688),
  it_('Current Accounts Summaries', 40, 587), it_('Personal Account (GBP)', 40, 548),
  it_('Account Number (GB IBAN)', 40, 494), it_('GB00REVO00997011112222', 188, 494),
  it_('Account Number GB', 40, 475), it_('11112222', 257, 475),
  it_('Financial institution name', 40, 361), it_('Revolut Ltd', 253, 361),
  it_('Opening balance', 301, 273), it_('£10.00', 530, 273),
  it_('Closing balance', 301, 254), it_('£45.50', 530, 254),
  it_('Personal Account (USD)', 40, 200), it_('Opening balance', 301, 180), it_('$0.00', 530, 180),
];
const table: PdfPage = [
  it_('Current Accounts Transaction Statements', 40, 688), it_('Personal Account (GBP)', 40, 650), it_('Transaction statement', 40, 614),
  ...header(590),
  ...row(564, '2 Jan 2026', 'Corner Shop', 'Merchant', '-£4.50', '£5.50'),
  ...row(546, '3 Jan 2026', 'Payment from EXAMPLE WIDGETS', 'Top up', '£250.00', '£255.50'), it_('LIMITED', 125, 534),
  ...row(515, '3 Jan 2026', 'To GBP Savings', 'Others', '-£200.00', '£55.50'),
  ...row(497, '4 Jan 2026', 'Transfer to Sam Example', 'Others', '-£20.00', '£35.50'),
  ...row(478, '5 Jan 2026', 'From GBP Savings', 'Others', '£10.00', '£45.50'),
  it_('Total', 40, 459), it_('£35.50', 343, 459),
  it_('Personal Account (USD)', 40, 400), ...header(370), it_('Total', 40, 340), it_('$0.00', 343, 340),
  it_('Savings Accounts Transaction Statements', 40, 300), it_('07/01/2026', 40, 280), it_('Gross Interest', 108, 280), it_('£0.01', 224, 280),
];

describe('Revolut statements', () => {
  const s = parseRevolut([summary, table]);

  it('recognises the layout', () => {
    expect(isRevolutStatement([summary, table])).toBe(true);
  });

  it('reads the period, holder, account and balances', () => {
    expect(s).toMatchObject({ bank: 'Revolut', format: 'pdf-revolut', periodStart: '2026-01-01', periodEnd: '2026-01-31', opening: 1000, closing: 4550 });
    expect(s.account).toMatchObject({ holder: 'ALEX TEST PERSON', number: '11112222', sortCode: '009970' });
  });

  it('reads every row of the GBP table, joins wrapped descriptions, and ignores the savings interest table', () => {
    expect(s.txns.map((t) => [t.date, t.amount, t.type, t.lines[0]])).toEqual([
      ['2026-01-02', -450, 'VIS', 'Corner Shop'],
      ['2026-01-03', 25_000, 'CR', 'EXAMPLE WIDGETS LIMITED'],
      ['2026-01-03', -20_000, 'POT', 'Savings pot'],
      ['2026-01-04', -2_000, 'BP', 'Sam Example'],
      ['2026-01-05', 1_000, 'POT', 'Savings pot'],
    ]);
  });

  it('proves itself: total, running balance and closing balance all agree', () => {
    expect(s.checks.map((c) => [c.name, c.ok])).toEqual([
      ['Total matches the statement', true],
      ['Running balance agrees', true],
      ['Closing balance agrees', true],
    ]);
  });

  it('flags a balance that does not add up', () => {
    const broken = table.map((i) => (i.str === '£35.50' && i.x === 385 ? { ...i, str: '£36.50' } : i));
    const r = parseRevolut([summary, broken]);
    expect(r.checks.find((c) => c.name === 'Running balance agrees')!.ok).toBe(false);
  });

  it('treats savings-pot moves as your own money and names with initials as the holder', () => {
    const pot = s.txns[2]!;
    expect(categorize({ type: pot.type, amount: pot.amount, d: describeTxn(pot.type, pot.lines, pot.amount) }, { rules: [], holders: [] })).toMatchObject({ categoryId: 'transfer', source: 'own' });
    const own = describeTxn('BP', ['A T Person'], -500);
    expect(categorize({ type: 'BP', amount: -500, d: own }, { rules: [], holders: ['ALEX TEST PERSON'] })).toMatchObject({ categoryId: 'transfer', source: 'own' });
  });

  it('does not mistake a surname for a coffee chain', () => {
    const d = describeTxn('BP', ['Jo Da-Costa'], -2766);
    expect(categorize({ type: 'BP', amount: -2766, d }, { rules: [], holders: [] }).categoryId).toBe('family');
  });
});
