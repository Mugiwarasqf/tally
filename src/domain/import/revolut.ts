import { makeDate, monthIndex } from '../../lib/dates';
import type { ISODate } from '../../lib/dates';
import { fmt, parseMoney } from '../../lib/money';
import type { Pence } from '../../lib/money';
import { groupRows, joinItems } from './rows';
import type { Row } from './rows';
import type { Check, ParsedStatement, PdfItem, PdfPage, RawTxn } from './types';

/**
 * Revolut statement parser ("Statement" and "Custom Statement" PDFs from the app).
 *
 * Layout facts this relies on (verified against a real statement):
 *  - Summary pages first: one block per account ("Personal Account (GBP)", "(USD)"…) with Opening and Closing balance.
 *  - Then "Current Accounts Transaction Statements": per account, a table with columns
 *    Date | Description | Category | Money in/out | Balance | Tax withheld | Other taxes | Fees.
 *  - Every row prints its date ("6 Nov 2025") and the balance after it, so every row can be checked.
 *  - Long descriptions wrap onto the next line, which has no date and nothing in the money columns.
 *  - Each account's table ends with a "Total" row (the net of Money in/out).
 *  - Savings pots and investments follow in their own sections; their tables are not current-account money.
 *
 * Revolut's own category column ("Merchant", "Top up", "Others") is used only as the payment type, the same
 * way HSBC's VIS/BP/CR codes are, so the rest of Tally treats both banks alike.
 */

const DATE_RE = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/;
const PERIOD_RE = /^(\d{1,2} [A-Za-z]{3} \d{4}) - (\d{1,2} [A-Za-z]{3} \d{4})$/;
const ACCOUNT_RE = /Account \(([A-Z]{3})\)$/;
const IBAN_RE = /^GB\d{2}[A-Z]{4}(\d{6})(\d{8})$/;

const parseDate = (s: string): ISODate | null => {
  const m = DATE_RE.exec(s.trim());
  if (!m) return null;
  const mi = monthIndex(m[2]!);
  return mi < 0 ? null : makeDate(Number(m[3]), mi + 1, Number(m[1]));
};

/** True when the pages look like a Revolut statement we can parse. */
export function isRevolutStatement(pages: PdfPage[]): boolean {
  const rows = pages.slice(0, 12).flatMap(groupRows);
  return rows.some((r) => r.text.includes('revolut')) && rows.some((r) => r.text.startsWith('datedescriptioncategory'));
}

/** The money value printed just to the right of a label on the same row ("Opening balance  £10.03"). */
function valueAfter(row: Row, label: string): Pence | undefined {
  const i = row.items.findIndex((it) => it.str.trim().toLowerCase() === label);
  if (i < 0) return undefined;
  for (const it of row.items.slice(i + 1)) {
    const v = parseMoney(it.str);
    if (v !== null) return v;
  }
  return undefined;
}

interface Cols { desc: number; cat: number; money: number; bal: number; tax: number; fees: number }
const DEFAULT_COLS: Cols = { desc: 125, cat: 258, money: 343, bal: 385, tax: 428, fees: 533 };

interface Pending { currency: string; date: ISODate; desc: string[]; cat: string; amount: Pence; balance?: Pence; fee: Pence }

/** Turn a Revolut row into the same shape HSBC rows have: a payment-type code and clean description lines. */
function toRaw(p: Pending): RawTxn {
  const d = p.desc.join(' ').replace(/\s+/g, ' ').trim();
  const base = { date: p.date, amount: p.amount, ...(p.balance !== undefined ? { balance: p.balance } : {}) };
  if (p.cat.toLowerCase() === 'merchant') return { ...base, type: 'VIS', lines: [d] };
  // Money moving between the account and its own savings pot.
  if (/^(?:to|from) [a-z]{3} savings$/i.test(d)) return { ...base, type: 'POT', lines: ['Savings pot', d] };
  const to = /^(?:transfer to|to)\s+(.+)$/i.exec(d);
  if (to && p.amount < 0) return { ...base, type: 'BP', lines: [to[1]!] };
  const from = /^(?:transfer from|payment from|from)\s+(.+)$/i.exec(d);
  if (from && p.amount > 0) return { ...base, type: 'CR', lines: [from[1]!] };
  return { ...base, type: p.amount < 0 ? 'BP' : 'CR', lines: [d] };
}

export function parseRevolut(pages: PdfPage[]): ParsedStatement {
  const result: ParsedStatement = { bank: 'Revolut', format: 'pdf-revolut', account: {}, txns: [], checks: [], warnings: [] };
  const summary = new Map<string, { opening?: Pence; closing?: Pence; number?: string; iban?: string }>();
  const totals = new Map<string, Pence>();
  const pending: Pending[] = [];

  let phase: 'summary' | 'current' | 'other' = 'summary';
  let currency = '';
  let cols: Cols = DEFAULT_COLS;

  pages.forEach((page, pageNo) => {
    let cur: Pending | null = null;
    for (const row of groupRows(page)) {
      const joined = joinItems(row.items);
      const t = row.text;

      // ---- page furniture and section changes --------------------------------------------------
      const period = PERIOD_RE.exec(joined);
      if (period) {
        result.periodStart ??= parseDate(period[1]!) ?? undefined;
        result.periodEnd ??= parseDate(period[2]!) ?? undefined;
        continue;
      }
      if (pageNo === 0 && !result.account.holder && phase === 'summary' && /^[A-Z][A-Z' -]{3,}$/.test(joined) && row.items[0]!.x < 100 && !/STATEMENT/.test(joined)) {
        result.account.holder = joined;
        continue;
      }
      if (t.includes('currentaccountstransactionstatements')) { phase = 'current'; cur = null; continue; }
      if (t.includes('savingsaccountstransactionstatements') || t.includes('investmentservicestransactionstatements') || t.startsWith('informationabout')) { if (phase === 'current') phase = 'other'; cur = null; continue; }
      const acct = ACCOUNT_RE.exec(joined);
      if (acct) { currency = acct[1]!; cur = null; continue; }

      if (phase === 'summary') {
        const s = summary.get(currency) ?? {};
        const opening = valueAfter(row, 'opening balance');
        const closing = valueAfter(row, 'closing balance');
        if (opening !== undefined && s.opening === undefined) s.opening = opening;
        if (closing !== undefined && s.closing === undefined) s.closing = closing;
        const iban = row.items.find((it) => IBAN_RE.test(it.str.trim()));
        if (iban && !s.iban) s.iban = iban.str.trim();
        if (t.startsWith('accountnumbergb')) s.number = row.items.at(-1)?.str.trim().split(/\s+/).find((w) => /^\d{8}$/.test(w)) ?? row.items.find((it) => /^\d{8}$/.test(it.str.trim()))?.str.trim();
        if (currency) summary.set(currency, s);
        continue;
      }
      if (phase !== 'current') continue;

      // ---- the transaction table -------------------------------------------------------------
      if (t.startsWith('datedescriptioncategory')) {
        const x = (label: string) => row.items.find((it) => it.str.trim().toLowerCase() === label)?.x;
        cols = { ...cols, desc: x('description') ?? cols.desc, cat: x('category') ?? cols.cat, bal: x('balance') ?? cols.bal, fees: x('fees') ?? cols.fees };
        continue;
      }
      if (t.startsWith('moneyin')) {
        const x = (label: string) => row.items.find((it) => it.str.trim().toLowerCase() === label)?.x;
        cols = { ...cols, money: x('money in') ?? cols.money, tax: x('tax') ?? cols.tax };
        continue;
      }
      if (t.startsWith('/out') || t.startsWith('withheld')) continue;

      const inCol = (it: PdfItem, from: number, to: number) => it.x >= from - 4 && it.x < to - 4;
      const first = row.items[0]!;
      if (first.str.trim().toLowerCase() === 'total') {
        const v = row.items.find((it) => inCol(it, cols.money, cols.bal));
        const n = v ? parseMoney(v.str) : null;
        if (n !== null && !totals.has(currency)) totals.set(currency, n);
        cur = null;
        continue;
      }
      const date = parseDate(first.str);
      if (date) {
        const money = row.items.find((it) => inCol(it, cols.money, cols.bal));
        const bal = row.items.find((it) => inCol(it, cols.bal, cols.tax));
        const fee = row.items.find((it) => it.x >= cols.fees - 30);
        const amount = money ? parseMoney(money.str) : null;
        if (amount === null) { result.warnings.push(`A row dated ${date} had no readable amount and was skipped.`); cur = null; continue; }
        const balance = bal ? parseMoney(bal.str) : null;
        cur = {
          currency, date, amount,
          desc: [joinItems(row.items.filter((it) => inCol(it, cols.desc, cols.cat)))],
          cat: joinItems(row.items.filter((it) => inCol(it, cols.cat, cols.money))),
          fee: fee ? Math.abs(parseMoney(fee.str) ?? 0) : 0,
          ...(balance !== null ? { balance } : {}),
        };
        pending.push(cur);
        continue;
      }
      // A wrapped description: text in the description column only, directly under its transaction.
      if (cur && row.items.every((it) => inCol(it, cols.desc, cols.cat))) cur.desc.push(joined);
    }
  });

  // ---- keep the pounds account; say what was left out ------------------------------------------
  const gbp = pending.filter((p) => p.currency === 'GBP');
  const others = pending.filter((p) => p.currency !== 'GBP');
  if (others.length) {
    const cur = [...new Set(others.map((p) => p.currency))].join(', ');
    result.warnings.push(`${others.length} transaction(s) in your ${cur} account were not imported. Tally works in pounds for now.`);
  }
  for (const p of gbp) {
    result.txns.push(toRaw(p));
    if (p.fee > 0) result.txns.push({ date: p.date, amount: -p.fee, type: 'FEE', lines: ['Revolut fee'] });
  }

  const s = summary.get('GBP') ?? {};
  const iban = s.iban ? IBAN_RE.exec(s.iban) : null;
  result.account = { ...result.account, number: s.number ?? iban?.[2], sortCode: iban?.[1], label: 'Revolut GBP' };
  result.opening = s.opening;
  result.closing = s.closing;
  if (result.opening === undefined && gbp[0]?.balance !== undefined) result.opening = gbp[0].balance - gbp[0].amount;

  // ---- self-checks ------------------------------------------------------------------------------
  const checks: Check[] = [];
  const net = result.txns.reduce((sum, t) => sum + t.amount, 0);
  const total = totals.get('GBP');
  if (total !== undefined) {
    checks.push({
      name: 'Total matches the statement',
      ok: net === total,
      detail: net === total ? `Money in and out nets to ${fmt(net, { sign: true })}, as printed.` : `Read a net of ${fmt(net, { sign: true })}; the statement's total is ${fmt(total, { sign: true })}.`,
    });
  }
  if (result.opening !== undefined) {
    let run = result.opening;
    let confirmed = 0;
    let wrong = 0;
    for (const t of result.txns) {
      run += t.amount;
      if (t.balance === undefined) continue;
      if (t.balance === run) confirmed++;
      else { wrong++; run = t.balance; }
    }
    checks.push({
      name: 'Running balance agrees',
      ok: wrong === 0 && confirmed > 0,
      detail: wrong === 0 ? `All ${confirmed} printed balances confirmed.` : `${wrong} printed balance(s) did not match the running total.`,
    });
    if (result.closing !== undefined) {
      checks.push({
        name: 'Closing balance agrees',
        ok: run === result.closing,
        detail: run === result.closing ? `Ends at ${fmt(run)}.` : `Computed ${fmt(run)}; statement says ${fmt(result.closing)}.`,
      });
    }
  }
  result.checks = checks;
  return result;
}
