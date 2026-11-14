import { uid } from '../lib/hash';
import { toCatMap } from '../domain/analytics/aggregate';
import { incomePatternPatches } from '../domain/analytics/income';
import { rentPatternPatches } from '../domain/analytics/rent';
import { buildTxns, accountKey } from '../domain/import/build';
import { pairTransfers } from '../domain/import/pair';
import type { ParsedStatement } from '../domain/import/types';
import type { Account, ImportedFile } from '../domain/types';
import { db } from './db';
import { loadSettings } from './settings';

export interface AccountChoice {
  /** Use this existing account… */
  id?: string;
  /** …or create one with this name. */
  name?: string;
}

export interface ImportResult {
  fileId: string;
  accountId: string;
  added: number;
  skipped: number;
}

/** Find the account a statement belongs to, or create it. */
export async function resolveAccount(parsed: ParsedStatement, choice: AccountChoice): Promise<Account> {
  if (choice.id) {
    const a = await db.accounts.get(choice.id);
    if (a) return a;
  }
  const key = accountKey(parsed);
  const existing = await db.accounts.where('key').equals(key).first();
  if (existing) {
    if (!existing.holder && parsed.account.holder) await db.accounts.update(existing.id, { holder: parsed.account.holder });
    return existing;
  }
  const last4 = parsed.account.number?.slice(-4);
  const acct: Account = {
    id: uid(),
    name: choice.name?.trim() || (last4 ? `${parsed.bank} ····${last4}` : parsed.account.label || `${parsed.bank} account`),
    bank: parsed.bank,
    holder: parsed.account.holder,
    key,
    createdAt: Date.now(),
  };
  await db.accounts.add(acct);
  return acct;
}

export async function holderNames(extra?: string): Promise<string[]> {
  const names = (await db.accounts.toArray()).map((a) => a.holder).filter((h): h is string => !!h);
  if (extra) names.push(extra);
  return [...new Set(names)];
}

/** Save a parsed statement: dedupe by fingerprint, categorise, then match transfers across accounts. */
export async function commitImport(args: { parsed: ParsedStatement; fileName: string; hash: string; choice: AccountChoice }): Promise<ImportResult> {
  const { parsed, fileName, hash, choice } = args;
  const account = await resolveAccount(parsed, choice);
  const rules = await db.rules.toArray();
  const holders = await holderNames(parsed.account.holder);
  const fileId = uid();
  const txns = buildTxns(parsed, account.id, fileId, { rules, holders });

  const existing = new Set((await db.txns.bulkGet(txns.map((t) => t.id))).filter(Boolean).map((t) => t!.id));
  const fresh = txns.filter((t) => !existing.has(t.id));

  const file: ImportedFile = {
    id: fileId,
    hash,
    name: fileName,
    format: parsed.format,
    accountId: account.id,
    periodStart: parsed.periodStart,
    periodEnd: parsed.periodEnd,
    opening: parsed.opening,
    closing: parsed.closing,
    txnCount: txns.length,
    addedCount: fresh.length,
    reconciled: parsed.checks.length ? parsed.checks.every((c) => c.ok) : null,
    importedAt: Date.now(),
  };

  await db.transaction('rw', db.files, db.txns, async () => {
    await db.files.add(file);
    await db.txns.bulkAdd(fresh);
  });
  await refreshDerived();
  return { fileId, accountId: account.id, added: fresh.length, skipped: txns.length - fresh.length };
}

/**
 * Judgements that need the whole picture rather than one statement:
 *  - transfers: money leaving one of your accounts and arriving in another;
 *  - pay: steady income (weekly, fortnightly or monthly) that nothing else could explain;
 *  - rent: the same sum to the same payee by transfer every month, which nothing else could explain.
 * Run after every import and whenever rules are re-applied.
 */
export async function refreshDerived(): Promise<number> {
  const all = await db.txns.toArray();
  if (!all.length) return 0;
  const cats = toCatMap(await db.categories.toArray());
  const asOf = all.reduce((m, t) => (t.date > m ? t.date : m), all[0]!.date);
  const { profile } = await loadSettings();
  const patches = [...((await db.accounts.count()) > 1 ? pairTransfers(all) : []), ...incomePatternPatches(all, cats, asOf), ...rentPatternPatches(all, cats, asOf, profile)];
  for (const p of patches) await db.txns.update(p.id, p.patch);
  return patches.length;
}

/** Remove one imported statement and the transactions it brought in. */
export async function removeImport(fileId: string): Promise<void> {
  await db.transaction('rw', db.files, db.txns, async () => {
    await db.txns.where('fileId').equals(fileId).delete();
    await db.files.delete(fileId);
  });
}
