import Papa from 'papaparse';
import { makeDate, monthIndex } from '../../lib/dates';
import type { ISODate } from '../../lib/dates';
import { parseMoney } from '../../lib/money';
import { region } from '../../lib/region';
import { ImportError } from './types';
import type { ParsedStatement, RawTxn } from './types';

export type DateOrder = 'dmy' | 'mdy' | 'ymd';

/** Which column holds what. Indexes are 0-based; -1 means "not present". */
export interface CsvMapping {
  headerRow: number;
  date: number;
  description: number[]; // joined in order
  amount: number; // signed single column, or -1 when debit/credit are separate
  debit: number;
  credit: number;
  balance: number;
  dateOrder: DateOrder;
}

export interface CsvAnalysis {
  rows: string[][];
  mapping: CsvMapping;
  confident: boolean;
}

const HEADER_HINTS = {
  date: /^(transaction )?date|posted|^when$/i,
  description: /description|details|narrative|memo|payee|merchant|reference|^name$|particulars/i,
  amount: /^(transaction )?amount|^value$|^amount \(/i,
  debit: /debit|paid out|money out|withdraw|outgoing|^out$/i,
  credit: /credit|paid in|money in|deposit|incoming|^in$/i,
  balance: /balance/i,
};

export function parseLooseDate(s: string, order: DateOrder): ISODate | null {
  const t = s.trim().replace(/'/g, '/');
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t);
  if (m) return makeDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[\s/.-]([A-Za-z]{3,9})[\s/.-](\d{2,4})/.exec(t);
  if (m && monthIndex(m[2]!) >= 0) return makeDate(fullYear(m[3]!), monthIndex(m[2]!) + 1, Number(m[1]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(t);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const [d, mo] = order === 'mdy' ? [b, a] : [a, b];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return makeDate(fullYear(m[3]!), mo, d);
  }
  return null;
}
const fullYear = (y: string): number => (y.length === 2 ? 2000 + Number(y) : Number(y));

/** Work out day/month order from the data itself; the region's usual order wins when it's ambiguous. */
export function detectDateOrder(samples: string[]): DateOrder {
  let dmy = 0;
  let mdy = 0;
  for (const s of samples) {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/.exec(s.trim().replace(/'/g, '/'));
    if (m) {
      if (Number(m[1]) > 12) dmy++;
      if (Number(m[2]) > 12) mdy++;
    } else if (/^\d{4}[-/.]/.test(s.trim())) return 'ymd';
  }
  return mdy > dmy ? 'mdy' : dmy > mdy ? 'dmy' : region().dateOrder;
}

export function analyseCsv(text: string): CsvAnalysis {
  const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: 'greedy' });
  const rows = parsed.data.map((r) => r.map((c) => (c ?? '').trim()));
  if (rows.length < 2) throw new ImportError('That CSV has no rows to import.');

  // Header = first row (of the first 15) that names at least two known columns.
  let headerRow = 0;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const hits = rows[i]!.filter((c) => Object.values(HEADER_HINTS).some((re) => re.test(c))).length;
    if (hits >= 2) {
      headerRow = i;
      break;
    }
  }
  const headers = rows[headerRow]!;
  const find = (re: RegExp, skip: number[] = []) => headers.findIndex((h, i) => re.test(h) && !skip.includes(i));
  const date = find(HEADER_HINTS.date);
  const debit = find(HEADER_HINTS.debit);
  const credit = find(HEADER_HINTS.credit, [debit]);
  const amount = debit >= 0 && credit >= 0 ? -1 : find(HEADER_HINTS.amount);
  const balance = find(HEADER_HINTS.balance);
  const descCols = headers.map((h, i) => (HEADER_HINTS.description.test(h) ? i : -1)).filter((i) => i >= 0);
  const samples = rows.slice(headerRow + 1, headerRow + 40).map((r) => r[Math.max(0, date)] ?? '');
  const mapping: CsvMapping = {
    headerRow, date, description: descCols, amount, debit, credit, balance, dateOrder: detectDateOrder(samples),
  };
  const confident = date >= 0 && descCols.length > 0 && (amount >= 0 || (debit >= 0 && credit >= 0));
  return { rows, mapping, confident };
}

export function parseCsvRows(rows: string[][], m: CsvMapping, label = 'CSV import'): ParsedStatement {
  if (m.date < 0 || (m.amount < 0 && m.debit < 0 && m.credit < 0)) throw new ImportError('Choose a date column and an amount (or debit/credit) column.');
  const txns: RawTxn[] = [];
  let skipped = 0;
  for (const r of rows.slice(m.headerRow + 1)) {
    const date = parseLooseDate(r[m.date] ?? '', m.dateOrder);
    let amount: number | null = null;
    if (m.amount >= 0) amount = parseMoney(r[m.amount] ?? '');
    else {
      const d = m.debit >= 0 ? parseMoney(r[m.debit] ?? '') : null;
      const c = m.credit >= 0 ? parseMoney(r[m.credit] ?? '') : null;
      if (d || c) amount = (c ? Math.abs(c) : 0) - (d ? Math.abs(d) : 0);
    }
    if (!date || amount === null || amount === 0) {
      if (r.some((c) => c)) skipped++;
      continue;
    }
    const lines = m.description.map((i) => r[i] ?? '').filter(Boolean);
    const t: RawTxn = { date, amount, type: '', lines: lines.length ? lines : ['(no description)'] };
    if (m.balance >= 0) {
      const b = parseMoney(r[m.balance] ?? '');
      if (b !== null) t.balance = b;
    }
    txns.push(t);
  }
  if (!txns.length) throw new ImportError('No transactions could be read with that column mapping.');
  const dates = txns.map((t) => t.date).sort();
  return {
    bank: 'CSV', format: 'csv', account: { label },
    periodStart: dates[0], periodEnd: dates[dates.length - 1],
    txns, checks: [], warnings: skipped ? [`${skipped} row(s) were skipped (no date or amount).`] : [],
  };
}
