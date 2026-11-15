import { cyrb53 } from '../../lib/hash';
import { categorize } from '../categorize/engine';
import type { CatContext } from '../categorize/engine';
import { describe } from '../categorize/merchant';
import { chargedOn, readNarration } from '../categorize/narration';
import { fmt } from '../../lib/money';
import { region } from '../../lib/region';
import type { Txn } from '../types';
import type { ParsedStatement } from './types';

/** Stable identity for an account across imports ("hsbc uk:112233:12345678"). */
export function accountKey(p: ParsedStatement): string {
  const { sortCode, number, label, section } = p.account;
  const base = `${p.bank.toLowerCase()}:${(sortCode ?? '').replace(/\D/g, '')}:${number ?? label ?? 'default'}`;
  return section ? `${base}:${section.toLowerCase()}` : base;
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
  const ng = region().id === 'ng';
  const built = parsed.txns.map((r) => {
    // Nigerian narrations carry no payment-type column; the wording says what kind of payment it was.
    // The fingerprint below still uses the raw row, so better reading never changes a transaction's id.
    const nar = ng && !r.type ? readNarration(r.lines, r.amount) : null;
    const type = nar?.type ?? r.type;
    const d = describe(type, nar?.lines ?? r.lines, r.amount);
    const base = `${accountId}|${r.date}|${r.amount}|${r.type}|${r.lines.join('|').toLowerCase()}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const cat = categorize({ type, amount: r.amount, d }, ctx);
    const t: Txn = {
      id: `t${cyrb53(`${base}#${n}`).toString(36)}`,
      accountId,
      fileId,
      date: r.date,
      amount: r.amount,
      type,
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
    if (d.time ?? r.time) t.time = d.time ?? r.time;
    if (d.place) t.place = d.place;
    return t;
  });
  linkCharges(parsed, built);
  return built;
}

/**
 * Nigerian banks charge a transfer fee and VAT on it as separate rows. Say which payment each charge was for:
 * the row with the same bank reference, or else a same-day payment whose description the charge repeats.
 */
function linkCharges(parsed: ParsedStatement, txns: Txn[]): void {
  const isCharge = (t: Txn) => t.type === 'FEE' || t.type === 'TAX';
  parsed.txns.forEach((r, i) => {
    const t = txns[i]!;
    if (!isCharge(t) || t.type === 'TAX') return;
    let j = r.ref ? parsed.txns.findIndex((x, k) => k !== i && x.ref === r.ref && !isCharge(txns[k]!)) : -1;
    if (j < 0) {
      const said = chargedOn(r.lines.join(' '));
      j = parsed.txns.findIndex((x, k) => k !== i && x.date === r.date && !isCharge(txns[k]!) && said.length > 8 && chargedOn(x.lines.join(' ')).replace(/\s/g, '').startsWith(said.replace(/\s/g, '').slice(0, 24)));
    }
    if (j < 0) return;
    const p = txns[j]!;
    t.detail = `On ${p.merchant} (${fmt(p.amount)}, ${p.date})`;
  });
}
