import { describe, expect, it } from 'vitest';
import { analyseCsv, detectDateOrder, parseCsvRows, parseLooseDate } from '../../../src/domain/import/csv';
import { parseOfx } from '../../../src/domain/import/ofx';
import { parseQif } from '../../../src/domain/import/qif';
import { buildTxns } from '../../../src/domain/import/build';
import { pairTransfers } from '../../../src/domain/import/pair';

describe('CSV', () => {
  const csv = [
    'Account export,,,',
    'Date,Description,Paid out,Paid in,Balance',
    '19/09/2026,TESCO STORES 123,25.50,,1074.50',
    '20/09/2026,Acme Wages,,"1,200.00",2274.50',
    '21/09/2026,,,,',
  ].join('\n');

  it('finds the header row, columns and UK date order', () => {
    const a = analyseCsv(csv);
    expect(a.mapping.headerRow).toBe(1);
    expect(a.confident).toBe(true);
    expect(a.mapping.dateOrder).toBe('dmy');
  });

  it('parses debit/credit columns into signed pence and skips blank rows', () => {
    const a = analyseCsv(csv);
    const p = parseCsvRows(a.rows, a.mapping, 'test');
    expect(p.txns.map((t) => [t.date, t.amount])).toEqual([['2026-09-19', -2550], ['2026-09-20', 120_000]]);
    expect(p.warnings.join(' ')).toContain('skipped');
  });

  it('handles a single signed amount column', () => {
    const a = analyseCsv('Date,Details,Amount\n2026-01-05,Coffee,-3.20\n2026-01-06,Refund,3.20');
    const p = parseCsvRows(a.rows, a.mapping);
    expect(p.txns.map((t) => t.amount)).toEqual([-320, 320]);
  });

  it('detects US-style dates when a day exceeds 12 in the second slot', () => {
    expect(detectDateOrder(['03/25/2026', '04/02/2026'])).toBe('mdy');
    expect(parseLooseDate('03/25/2026', 'mdy')).toBe('2026-03-25');
    expect(parseLooseDate('19 Aug 2026', 'dmy')).toBe('2026-08-19');
  });
});

describe('OFX and QIF', () => {
  it('reads OFX SGML transactions', () => {
    const ofx = `<OFX><BANKACCTFROM><BANKID>123456<ACCTID>98765432</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260801<DTEND>20260831
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260805120000<TRNAMT>-12.34<FITID>1<NAME>PRET A MANGER<MEMO>LONDON</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260806<TRNAMT>100.00<FITID>2<NAME>Alex Rivers</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>500.25<DTASOF>20260831</LEDGERBAL></OFX>`;
    const p = parseOfx(ofx);
    expect(p.txns).toHaveLength(2);
    expect(p.txns[0]).toMatchObject({ date: '2026-08-05', amount: -1234, lines: ['PRET A MANGER', 'LONDON'] });
    expect(p.closing).toBe(50_025);
    expect(p.account.number).toBe('98765432');
  });

  it('reads QIF records', () => {
    const p = parseQif('!Type:Bank\nD19/08/2026\nT-9.99\nPNetflix\n^\nD20/08/2026\nT1,000.00\nPAcme\nMWages\n^');
    expect(p.txns.map((t) => [t.date, t.amount])).toEqual([['2026-08-19', -999], ['2026-08-20', 100_000]]);
  });
});

describe('fingerprints and transfer pairing', () => {
  const parsed = (lines: string[][]) => ({
    bank: 'Test', format: 'csv' as const, account: {}, checks: [], warnings: [],
    txns: lines.map((l) => ({ date: '2026-09-01', amount: -200, type: ')))', lines: l })),
  });

  it('keeps identical same-day purchases distinct but stable across re-imports', () => {
    const a = buildTxns(parsed([['COFFEE SHOP'], ['COFFEE SHOP']]), 'acc', 'f1', { rules: [], holders: [] });
    const b = buildTxns(parsed([['COFFEE SHOP'], ['COFFEE SHOP']]), 'acc', 'f2', { rules: [], holders: [] });
    expect(new Set(a.map((t) => t.id)).size).toBe(2);
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id));
  });

  it('pairs opposite amounts across two accounts, and only across accounts', () => {
    const base = { fileId: 'f', type: 'TFR', merchant: 'x', mkey: 'x', detail: '', raw: 'x', categoryId: 'unsorted-out', catSource: 'none' as const, confidence: 0, reason: '' };
    const txns = [
      { ...base, id: 'o', accountId: 'A', date: '2026-09-01', amount: -50_000 },
      { ...base, id: 'i', accountId: 'B', date: '2026-09-02', amount: 50_000, categoryId: 'unsorted-in' },
      { ...base, id: 'same', accountId: 'A', date: '2026-09-02', amount: 50_000, categoryId: 'unsorted-in' },
    ];
    const patches = pairTransfers(txns);
    expect(patches.map((p) => p.id).sort()).toEqual(['i', 'o']);
    expect(patches[0]!.patch.categoryId).toBe('transfer');
  });
});
