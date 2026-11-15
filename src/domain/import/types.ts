import type { ISODate } from '../../lib/dates';
import type { Pence } from '../../lib/money';

/** One transaction as read from a statement, before cleaning or categorising. */
export interface RawTxn {
  date: ISODate;
  amount: Pence; // negative = money out
  balance?: Pence; // end-of-day balance, when the statement prints one on this row
  type: string; // bank's payment-type code (VIS, TFR, BP, ...) or '' for CSV
  lines: string[]; // description lines in statement order
  time?: string; // "HH:MM", when the statement prints a time
  ref?: string; // the bank's own reference for the row, when printed (fees share it with their payment)
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export type SourceFormat = 'pdf-hsbc' | 'pdf-revolut' | 'pdf-generic' | 'csv' | 'ofx' | 'qif';

/** Everything a parser learned from one statement file. */
export interface ParsedStatement {
  bank: string;
  format: SourceFormat;
  account: { holder?: string; sortCode?: string; number?: string; label?: string; /** One of several accounts printed in the same statement ("Savings Account"). */ section?: string };
  periodStart?: ISODate;
  periodEnd?: ISODate;
  opening?: Pence;
  closing?: Pence;
  totalIn?: Pence;
  totalOut?: Pence;
  txns: RawTxn[];
  /** Self-checks (totals, running balance). A failed check never blocks import; it is shown. */
  checks: Check[];
  warnings: string[];
}

/** A positioned run of text from a PDF page. y grows upwards (PDF space). */
export interface PdfItem {
  str: string;
  x: number;
  y: number;
  w: number;
}
export type PdfPage = PdfItem[];

export class ImportError extends Error {}
