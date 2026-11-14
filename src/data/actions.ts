import { uid } from '../lib/hash';
import { categorize } from '../domain/categorize/engine';
import { describe } from '../domain/categorize/merchant';
import type { Category, Debt, ReportSnapshot, Rule } from '../domain/types';
import { db } from './db';
import { holderNames, refreshDerived } from './importer';

const LOCKED = new Set(['manual', 'rule']);

/**
 * Change one transaction's category. With `learn`, the choice becomes a rule for that
 * merchant and is applied to every other matching transaction the user hasn't set by hand.
 * Returns how many *other* transactions were updated.
 */
export async function setCategory(txnId: string, categoryId: string, learn: boolean): Promise<number> {
  const t = await db.txns.get(txnId);
  if (!t) return 0;
  await db.txns.update(txnId, { categoryId, catSource: 'manual', confidence: 1, reason: 'Set by you', reviewed: true });
  if (!learn || !t.mkey) return 0;

  // Moving money to savings counts as saving; the same account paying money BACK must not cancel it out, so a
  // rule learned into a saving category only applies in the direction it was taught.
  const dir = (await db.categories.get(categoryId))?.kind === 'saving' ? (t.amount < 0 ? ('out' as const) : ('in' as const)) : undefined;
  const existing = await db.rules.where('kind').equals('learned').filter((r) => r.pattern === t.mkey && r.dir === dir).first();
  if (existing) await db.rules.update(existing.id, { categoryId, createdAt: Date.now() });
  else await db.rules.add({ id: uid(), kind: 'learned', match: 'merchant', pattern: t.mkey, categoryId, dir, createdAt: Date.now() });

  const others = await db.txns
    .where('mkey').equals(t.mkey)
    .filter((o) => o.id !== t.id && !LOCKED.has(o.catSource) && o.categoryId !== categoryId && Math.sign(o.amount) === Math.sign(t.amount))
    .toArray();
  for (const o of others) {
    await db.txns.update(o.id, { categoryId, catSource: 'learned', confidence: 0.95, reason: `Learned from your choice for ${t.merchant}`, reviewed: true });
  }
  return others.length;
}

export async function setCategoryMany(ids: string[], categoryId: string): Promise<void> {
  await db.transaction('rw', db.txns, async () => {
    for (const id of ids) await db.txns.update(id, { categoryId, catSource: 'manual', confidence: 1, reason: 'Set by you', reviewed: true });
  });
}

export const confirmTxns = (ids: string[]) => db.transaction('rw', db.txns, async () => { for (const id of ids) await db.txns.update(id, { reviewed: true, confidence: 1 }); });
export const setNote = (id: string, note: string) => db.txns.update(id, { note: note.trim() || undefined });

/** Re-run categorisation on everything the user hasn't set by hand (after editing rules or categories). */
export async function recategorizeAll(): Promise<number> {
  const [rules, holders] = [await db.rules.toArray(), await holderNames()];
  let n = 0;
  await db.transaction('rw', db.txns, async () => {
    for (const t of await db.txns.toArray()) {
      if (t.catSource === 'manual') continue;
      const lines = t.raw.split(' | ');
      const d = describe(t.type, lines, t.amount);
      const r = categorize({ type: t.type, amount: t.amount, d }, { rules, holders });
      // Re-describing also refreshes the derived text fields, so improvements to the parser reach old imports.
      const described = d.detail !== t.detail || d.time !== t.time || d.place !== t.place;
      if (described) await db.txns.update(t.id, { detail: d.detail, time: d.time, place: d.place });
      if (r.categoryId !== t.categoryId || r.source !== t.catSource) {
        await db.txns.update(t.id, { categoryId: r.categoryId, catSource: r.source, confidence: r.confidence, reason: r.reason });
        n++;
      }
    }
  });
  return n + (await refreshDerived());
}

// ---- rules, categories, debts, budgets -------------------------------------
export const addRule = (r: Omit<Rule, 'id' | 'createdAt'>) => db.rules.add({ ...r, id: uid(), createdAt: Date.now() });
export const deleteRule = (id: string) => db.rules.delete(id);

export async function saveCategory(c: Category): Promise<void> {
  await db.categories.put(c);
}
export async function deleteCategory(id: string): Promise<void> {
  const c = await db.categories.get(id);
  if (!c || c.system) return;
  const fallback = c.kind === 'income' ? 'unsorted-in' : 'unsorted-out';
  await db.transaction('rw', db.categories, db.txns, db.rules, db.budgets, async () => {
    for (const t of await db.txns.where('categoryId').equals(id).toArray()) await db.txns.update(t.id, { categoryId: fallback, catSource: 'none', confidence: 0, reason: 'Category deleted' });
    await db.rules.where('categoryId').equals(id).delete();
    await db.budgets.filter((b) => b.categoryId === id).delete();
    await db.categories.delete(id);
  });
}

export async function setBudget(month: string, categoryId: string, amount: number): Promise<void> {
  if (amount <= 0) await db.budgets.delete([month, categoryId]);
  else await db.budgets.put({ month, categoryId, amount });
}

/**
 * Save a debt. If it names how its repayments appear on statements (a lender, or a person's name),
 * a rule makes those outgoing payments count as debt repayments, so the budget, the cash-flow
 * totals and the remaining balance all agree with each other.
 */
export async function saveDebt(d: Omit<Debt, 'id' | 'createdAt'> & { id?: string }): Promise<string> {
  const id = d.id ?? uid();
  const prev = d.id ? await db.debts.get(d.id) : undefined;
  await db.debts.put({ ...d, id, createdAt: prev?.createdAt ?? Date.now() });
  await db.rules.filter((r) => r.debtId === id).delete();
  if (d.match?.trim()) {
    await db.rules.add({ id: uid(), kind: 'user', match: 'contains', pattern: d.match.trim(), categoryId: 'debt', dir: 'out', createdAt: Date.now(), debtId: id });
  }
  await recategorizeAll();
  return id;
}

export async function deleteDebt(id: string): Promise<void> {
  await db.debts.delete(id);
  await db.rules.filter((r) => r.debtId === id).delete();
  await recategorizeAll();
}

/** Freeze a month's grade. Re-grading later (after rules change) doesn't rewrite history; reopen to do that. */
export const closeMonth = (s: ReportSnapshot) => db.reports.put(s);
export const reopenMonth = (month: string) => db.reports.delete(month);

export async function renameAccount(id: string, name: string): Promise<void> {
  await db.accounts.update(id, { name: name.trim() || 'Account' });
}
export async function deleteAccount(id: string): Promise<void> {
  await db.transaction('rw', db.accounts, db.txns, db.files, async () => {
    await db.txns.where('accountId').equals(id).delete();
    await db.files.where('accountId').equals(id).delete();
    await db.accounts.delete(id);
  });
}

export async function wipeEverything(): Promise<void> {
  await db.delete();
  location.reload();
}
