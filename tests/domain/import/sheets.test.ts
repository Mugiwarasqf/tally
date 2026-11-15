import fs from 'node:fs';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { analyseRows, parseCsvRows } from '../../../src/domain/import/csv';
import { analysePdf } from '../../../src/domain/import/generic';
import { readPdf } from '../../../src/domain/import/pdf';
import { currencyInRows, readSheet, serialToISO, sniffSheet } from '../../../src/domain/import/sheet';
import { ImportError, PasswordNeeded } from '../../../src/domain/import/types';

const inflate = async (raw: Uint8Array) => new Uint8Array(zlib.inflateRawSync(raw));

/** A minimal .xlsx: a zip holding the parts Excel writes. Some entries stored, some deflated, like real files. */
function makeXlsx(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  Object.entries(files).forEach(([name, text], i) => {
    const data = Buffer.from(enc.encode(text));
    const deflate = i % 2 === 0;
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const nameB = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameB.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameB, body);
    centrals.push(central, nameB);
    offset += 30 + nameB.length + body.length;
  });
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

/** An invented Nigerian-style Excel export: a preamble, then the table, dates as Excel serials. */
function invoiceXlsx(): Uint8Array {
  const strings = ['Customer Statement', 'Account Name', 'ADA EXAMPLE', 'Currency', 'NGN', 'Trans Date', 'Value Date', 'Narration', 'Debit', 'Credit', 'Balance',
    'Opening Balance', 'POS PURCHASE SAMPLE STORE', 'NIP:TEST PERSON-Refund', 'SMS ALERT CHARGES & FEES'];
  const s = (i: number, ref: string) => `<c r="${ref}" t="s"><v>${i}</v></c>`;
  const n = (v: number, ref: string, style?: number) => `<c r="${ref}"${style !== undefined ? ` s="${style}"` : ''}><v>${v}</v></c>`;
  const row = (r: number, cells: string) => `<row r="${r}">${cells}</row>`;
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
    ${row(1, s(0, 'A1'))}${row(2, s(1, 'A2') + s(2, 'B2'))}${row(3, s(3, 'A3') + s(4, 'B3'))}
    ${row(5, s(5, 'A5') + s(6, 'B5') + s(7, 'C5') + s(8, 'D5') + s(9, 'E5') + s(10, 'F5'))}
    ${row(6, n(46082, 'A6', 1) + n(46082, 'B6', 1) + s(11, 'C6') + n(10000, 'F6'))}
    ${row(7, n(46083, 'A7', 1) + n(46083, 'B7', 1) + s(12, 'C7') + n(2500.5, 'D7') + n(7499.5, 'F7'))}
    ${row(8, n(46084, 'A8', 1) + n(46084, 'B8', 1) + s(13, 'C8') + n(1000, 'E8') + n(8499.5, 'F8'))}
    ${row(9, n(46085, 'A9', 1) + n(46085, 'B9', 1) + s(14, 'C9') + n(4.03, 'D9') + n(8495.470000000001, 'F9'))}
  </sheetData></worksheet>`;
  return makeXlsx({
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
    'xl/sharedStrings.xml': `<sst>${strings.map((t) => `<si><t>${t.replace('&', '&amp;')}</t></si>`).join('')}</sst>`,
    'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd\\-mmm\\-yyyy"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
  });
}

describe('spreadsheet statements', () => {
  it('reads an .xlsx export: shared strings, date serials, float noise, a preamble above the table', async () => {
    const bytes = invoiceXlsx();
    expect(sniffSheet(bytes)).toBe('xlsx');
    const rows = await readSheet(bytes, inflate);
    expect(rows[0]).toEqual(['Customer Statement']);
    expect(rows[4]).toEqual(['2026-03-01', '2026-03-01', 'Opening Balance', '', '', '10000']);
    expect(rows[7]![2]).toBe('SMS ALERT CHARGES & FEES');
    expect(rows[7]![5]).toBe('8495.47');
    expect(currencyInRows(rows)).toBe('NGN');

    const a = analyseRows(rows, 'xlsx');
    expect(a.confident).toBe(true);
    expect(a.mapping).toMatchObject({ headerRow: 3, date: 0, debit: 3, credit: 4, balance: 5 });
    const p = parseCsvRows(a.rows, a.mapping, 'Statement', 'xlsx');
    expect(p.format).toBe('xlsx');
    expect(p.txns.map((t) => [t.date, t.amount, t.balance])).toEqual([['2026-03-02', -250_050, 749_950], ['2026-03-03', 100_000, 849_950], ['2026-03-04', -403, 849_547]]);
  });

  it('reads ".xls" downloads that are really HTML tables or XML spreadsheets', async () => {
    const html = new TextEncoder().encode('<html><body><table><tr><th>Date</th><th>Narration</th><th>Debit</th><th>Credit</th><th>Balance</th></tr><tr><td>02/03/2026</td><td>POS&nbsp;PURCHASE &amp; CO</td><td>20.00</td><td></td><td>80.00</td></tr></table></body></html>');
    expect(sniffSheet(html)).toBe('html');
    expect(await readSheet(html, inflate)).toEqual([['Date', 'Narration', 'Debit', 'Credit', 'Balance'], ['02/03/2026', 'POS PURCHASE & CO', '20.00', '', '80.00']]);

    const xml = new TextEncoder().encode('<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="S"><Table><Row><Cell><Data ss:Type="String">Date</Data></Cell><Cell ss:Index="3"><Data ss:Type="String">Amount</Data></Cell></Row><Row><Cell><Data ss:Type="DateTime">2026-03-02T00:00:00.000</Data></Cell><Cell ss:Index="3"><Data ss:Type="Number">-19.990000000000002</Data></Cell></Row></Table></Worksheet></Workbook>');
    expect(sniffSheet(xml)).toBe('xml');
    expect(await readSheet(xml, inflate)).toEqual([['Date', '', 'Amount'], ['2026-03-02', '', '-19.99']]);
  });

  it('explains what to do with an old binary .xls', async () => {
    const biff = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    await expect(readSheet(biff, inflate)).rejects.toThrow(/save it as \.xlsx or CSV/);
  });

  it('turns Excel day numbers into dates', () => {
    expect(serialToISO(46082)).toBe('2026-03-01');
    expect(serialToISO(45658)).toBe('2025-01-01');
  });
});

describe('password-protected PDFs', () => {
  const locked = () => new Uint8Array(fs.readFileSync(new URL('../../fixtures/locked.pdf', import.meta.url)));
  const pdfjs = () => import(/* @vite-ignore */ 'pdfjs-dist/legacy/build/pdf.mjs');

  it('asks for the password, says when it is wrong, and reads the statement with the right one', async () => {
    const js = await pdfjs();
    const need = await readPdf(locked(), js as never).catch((e: unknown) => e);
    expect(need).toBeInstanceOf(PasswordNeeded);
    expect(need).toBeInstanceOf(ImportError);
    expect((need as PasswordNeeded).wrong).toBe(false);
    const wrong = await readPdf(locked(), js as never, 'nope').catch((e: unknown) => e);
    expect((wrong as PasswordNeeded).wrong).toBe(true);

    const pages = await readPdf(locked(), js as never, 'open-sesame');
    const a = analysePdf(pages);
    expect(a.result.verified).toBe(true);
    expect(a.result.parsed.txns.map((t) => t.amount)).toEqual([-2_000, 5_000]);
  });
});
