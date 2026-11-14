import { addDays, makeDate, monthIndex } from '../../lib/dates';
import type { ISODate } from '../../lib/dates';
import { fmt, parseMoney } from '../../lib/money';
import type { Pence } from '../../lib/money';
import { groupRows, joinItems } from './rows';
import type { Row } from './rows';
import type { Check, ParsedStatement, PdfPage, RawTxn } from './types';

/**
 * HSBC UK statement parser (text-based PDFs: Basic, Advance, Premier, Bank Account).
 *
 * Layout facts this relies on (verified against real statements):
 *  - A table header row carries "£ Paid out", "£ Paid in" and "£ Balance".
 *  - Amounts are right-aligned under those headers; the column is decided by the
 *    amount's right edge, not its start, so 5.49 and 1,234.56 land correctly.
 *  - Column 2 holds the payment-type code (VIS, TFR, BP, CR, ATM, DR, ))) ...);
 *    column 3 holds one to four description lines.
 *  - The date is printed only on the first transaction of each day, and carries
 *    over page breaks.
 *  - Page 1 prints Opening/Closing balance and total Payments In/Out, which we use
 *    to prove the parse is complete (totals must match to the penny).
 */

const DATE_RE = /^(\d{1,2}) ([A-Za-z]{3}) (\d{2})$/;
const MONEY_RE = /^\d{1,3}(?:,\d{3})*\.\d{2}(?: ?D)?$|^\d+\.\d{2}(?: ?D)?$/;

const parseDate = (s: string): ISODate | null => {
  const m = DATE_RE.exec(s.trim());
  if (!m) return null;
  const mi = monthIndex(m[2]!);
  return mi < 0 ? null : makeDate(2000 + Number(m[3]), mi + 1, Number(m[1]));
};

/** True when the pages look like an HSBC UK statement we can parse. */
export function isHsbcStatement(pages: PdfPage[]): boolean {
  const first = pages.slice(0, 3).flatMap(groupRows);
  const hasHeader = first.some((r) => r.text.includes('paidout') && r.text.includes('paidin') && r.text.includes('balance'));
  const mentionsHsbc = first.some((r) => r.text.includes('hsbc'));
  return hasHeader && mentionsHsbc;
}

interface Block {
  date: ISODate;
  type: string;
  lines: string[];
  out: Pence;
  in: Pence;
  balance?: Pence;
}

export function parseHsbc(pages: PdfPage[]): ParsedStatement {
  const result: ParsedStatement = {
    bank: 'HSBC UK',
    format: 'pdf-hsbc',
    account: {},
    txns: [],
    checks: [],
    warnings: [],
  };

  // ---- page 1 metadata ------------------------------------------------------
  const firstRows = groupRows(pages[0] ?? []);
  const money = (row: Row): Pence | null => {
    const it = [...row.items].reverse().find((i) => /£/.test(i.str) || MONEY_RE.test(i.str.replace('£', '').trim()));
    return it ? parseMoney(it.str.replace('£', '')) : null;
  };
  for (const row of firstRows) {
    if (row.text.startsWith('openingbalance')) result.opening = money(row) ?? undefined;
    else if (row.text.includes('paymentsin') && row.text.includes('£')) result.totalIn = money(row) ?? undefined;
    else if (row.text.includes('paymentsout') && row.text.includes('£')) result.totalOut = money(row) ?? undefined;
    else if (row.text.startsWith('closingbalance') || row.text.includes('closingbalance')) result.closing = money(row) ?? undefined;
  }
  // Row after the "Account Name / Sortcode / Account Number" labels carries the values.
  const labelIdx = firstRows.findIndex((r) => r.text.includes('accountname') && r.text.includes('sortcode'));
  if (labelIdx >= 0) {
    const vals = firstRows[labelIdx + 1]?.items ?? [];
    result.account.holder = vals.find((i) => i.x < 120 && /[A-Za-z]/.test(i.str))?.str.trim();
    result.account.sortCode = vals.find((i) => /^\d{2}-\d{2}-\d{2}$/.test(i.str.trim()))?.str.trim();
    result.account.number = vals.find((i) => /^\d{8}$/.test(i.str.trim()))?.str.trim();
  }
  for (const row of firstRows) {
    const m = /(\d{1,2})([A-Za-z]+)(?:(\d{4}))?to(\d{1,2})([A-Za-z]+)(\d{4})/.exec(
      row.items.map((i) => i.str).join('').replace(/\s+/g, ''),
    );
    if (m && monthIndex(m[2]!) >= 0 && monthIndex(m[5]!) >= 0) {
      const endY = Number(m[6]);
      const sm = monthIndex(m[2]!) + 1;
      const em = monthIndex(m[5]!) + 1;
      const startY = m[3] ? Number(m[3]) : sm > em ? endY - 1 : endY;
      result.periodStart = makeDate(startY, sm, Number(m[1]));
      result.periodEnd = makeDate(endY, em, Number(m[4]));
      break;
    }
  }
  result.account.label = [result.account.sortCode, result.account.number].filter(Boolean).join(' ');

  // ---- transaction tables ---------------------------------------------------
  const blocks: Block[] = [];
  let curDate: ISODate | null = null;
  let block: Block | null = null;
  let broughtForward: Pence | undefined;
  let skipped = 0;

  for (const page of pages) {
    const rows = groupRows(page);
    const hdrIdx = rows.findIndex((r) => r.text.includes('paidout') && r.text.includes('paidin') && r.text.includes('balance'));
    if (hdrIdx < 0) continue; // cover/T&C pages
    const hdr = rows[hdrIdx]!;
    const inHdr = hdr.items.find((i) => /paidin/i.test(i.str.replace(/\s+/g, '')));
    const balHdr = hdr.items.find((i) => /^£?balance$/i.test(i.str.replace(/\s+/g, '')));
    const outHdr = hdr.items.find((i) => /paidout/i.test(i.str.replace(/\s+/g, '')));
    if (!inHdr || !balHdr || !outHdr) continue;
    const amountMinX = outHdr.x - 25;

    for (const row of rows.slice(hdrIdx + 1)) {
      if (row.text.startsWith('hsbcukbankplc')) break;
      const dateItem = row.items.find((i) => i.x < 100 && DATE_RE.test(i.str.trim()));
      const typeItem = row.items.find((i) => i.x >= 100 && i.x < 128);
      const rest = row.items.filter((i) => i !== dateItem && i !== typeItem && i.x >= 100);
      const amounts = rest.filter((i) => i.x >= amountMinX && MONEY_RE.test(i.str.trim()));
      const detail = joinItems(rest.filter((i) => !amounts.includes(i) && i.x >= 128));

      if (dateItem) curDate = parseDate(dateItem.str);

      if (/^balancebroughtforward$/i.test(detail.replace(/\s+/g, ''))) {
        const b = amounts.find((a) => a.x + a.w >= balHdr.x);
        if (b && broughtForward === undefined) broughtForward = parseMoney(b.str) ?? undefined;
        block = null;
        continue;
      }
      if (/^balancecarriedforward$/i.test(detail.replace(/\s+/g, ''))) {
        block = null;
        continue;
      }

      if (typeItem) {
        if (!curDate) {
          skipped++;
          block = null;
          continue;
        }
        block = { date: curDate, type: typeItem.str.trim(), lines: [], out: 0, in: 0 };
        blocks.push(block);
      }
      if (!block) continue;
      if (detail) block.lines.push(detail);
      for (const a of amounts) {
        const v = parseMoney(a.str);
        if (v === null) continue;
        const edge = a.x + a.w;
        if (edge < inHdr.x) block.out += Math.abs(v);
        else if (edge < balHdr.x) block.in += Math.abs(v);
        else block.balance = v;
      }
    }
  }

  // ---- build transactions ---------------------------------------------------
  for (const b of blocks) {
    if (b.out === 0 && b.in === 0) {
      skipped++;
      continue;
    }
    const raw: RawTxn = { date: b.date, amount: b.in - b.out, type: b.type, lines: b.lines };
    if (b.balance !== undefined) raw.balance = b.balance;
    result.txns.push(raw);
  }
  if (skipped) result.warnings.push(`${skipped} row(s) could not be read and were skipped.`);
  if (result.opening === undefined) result.opening = broughtForward;

  // ---- self-checks ----------------------------------------------------------
  const sumIn = result.txns.reduce((s, t) => s + (t.amount > 0 ? t.amount : 0), 0);
  const sumOut = result.txns.reduce((s, t) => s + (t.amount < 0 ? -t.amount : 0), 0);
  const checks: Check[] = [];
  if (result.totalIn !== undefined && result.totalOut !== undefined) {
    const okIn = sumIn === result.totalIn;
    const okOut = sumOut === result.totalOut;
    checks.push({
      name: 'Totals match the statement summary',
      ok: okIn && okOut,
      detail: okIn && okOut
        ? `${fmt(sumIn)} in and ${fmt(sumOut)} out agree with page 1.`
        : `Read ${fmt(sumIn)} in / ${fmt(sumOut)} out; the statement says ${fmt(result.totalIn)} / ${fmt(result.totalOut)}.`,
    });
  }
  if (result.opening !== undefined) {
    let run = result.opening;
    let confirmed = 0;
    let wrong = 0;
    for (const t of result.txns) {
      run += t.amount;
      if (t.balance !== undefined) {
        if (t.balance === run) confirmed++;
        else {
          wrong++;
          run = t.balance; // re-anchor so one miss doesn't flag everything after it
        }
      }
    }
    checks.push({
      name: 'Running balance agrees',
      ok: wrong === 0 && confirmed > 0,
      detail: wrong === 0 ? `${confirmed} printed balances confirmed.` : `${wrong} printed balance(s) did not match the running total.`,
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

/** Last day any transaction in the statement occurs (used when the period header is missing). */
export const lastDate = (txns: RawTxn[]): ISODate | undefined => txns.reduce<ISODate | undefined>((m, t) => (!m || t.date > m ? t.date : m), undefined);
export const dayBefore = (d: ISODate): ISODate => addDays(d, -1);
