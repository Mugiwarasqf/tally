import { cyrb53 } from '../../lib/hash';
import { categorize } from '../categorize/engine';
import type { CatContext } from '../categorize/engine';
import { describe } from '../categorize/merchant';
import type { Txn } from '../types';
import type { ParsedStatement } from './types';

/** Stable identity for an account across imports ("hsbc uk:112233:12345678"). */
export function accountKey(p: ParsedStatement): string {
  const { sortCode, number, label } = p.account;
  return `${p.bank.toLowerCase()}:${(sortCode ?? '').replace(/\D/g, '')}:${number ?? label ?? 'default'}`;
}

/**
 * Turn parsed rows into categorised transactions.
 *
 * Each transaction's id is a fingerprint of account + date + amount + description.
 * Rows that are genuinely identical on the same day (two £2.00 coffees) get an
 * ordinal, so they stay distinct, yet re-importing an overlapping statement
 * regenerates exactly the same ids and the duplicates are skipped.
 */
export function buildTxns(parsed: ParsedStatement, accountId: string, fileId: string, ctx: CatContext): Txn[] {
  const seen = new Map<string, number>();
  return parsed.txns.map((r) => {
    const d = describe(r.type, r.lines, r.amount);
    const base = `${accountId}|${r.date}|${r.amount}|${r.type}|${r.lines.join('|').toLowerCase()}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const cat = categorize({ type: r.type, amount: r.amount, d }, ctx);
    const t: Txn = {
      id: `t${cyrb53(`${base}#${n}`).toString(36)}`,
      accountId,
      fileId,
      date: r.date,
      amount: r.amount,
      type: r.type,
      merchant: d.merchant,
      mkey: d.mkey,
      detail: d.detail,
      raw: d.raw,
      categoryId: cat.categoryId,
      catSource: cat.source,
      confidence: cat.confidence,
      reason: cat.reason,
    };
    if (r.balance !== undefined) t.balance = r.balance;
    if (d.fx) t.fx = d.fx;
    if (d.time) t.time = d.time;
    if (d.place) t.place = d.place;
    return t;
  });
}
