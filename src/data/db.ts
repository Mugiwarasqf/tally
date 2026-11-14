import Dexie from 'dexie';
import type { Table } from 'dexie';
import { DEFAULT_CATEGORIES } from '../domain/categorize/categories';
import type { Account, AlertItem, BudgetLine, Category, Debt, ImportedFile, MonthPlan, ReportSnapshot, Rule, Txn } from '../domain/types';

/**
 * Everything lives in the browser's IndexedDB; nothing is ever sent anywhere.
 * Demo mode uses a separate database so sample data can never mix with real data.
 */
const readDemoFlag = (): boolean => {
  try {
    // `?demo` in the address opens (and remembers) demo mode, handy for sharing a look at the app.
    if (new URLSearchParams(location.search).has('demo')) localStorage.setItem('tally.demo', '1');
    return localStorage.getItem('tally.demo') === '1';
  } catch {
    return false;
  }
};
export const isDemo = readDemoFlag();

export interface KV {
  key: string;
  value: unknown;
}

export class TallyDB extends Dexie {
  accounts!: Table<Account, string>;
  files!: Table<ImportedFile, string>;
  txns!: Table<Txn, string>;
  categories!: Table<Category, string>;
  rules!: Table<Rule, string>;
  budgets!: Table<BudgetLine, [string, string]>;
  plans!: Table<MonthPlan, string>;
  debts!: Table<Debt, string>;
  reports!: Table<ReportSnapshot, string>;
  alerts!: Table<AlertItem, string>; // the service worker reads this store directly — keep the name stable
  kv!: Table<KV, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      accounts: 'id, key',
      files: 'id, hash, accountId',
      txns: 'id, accountId, date, categoryId, fileId, mkey',
      categories: 'id',
      rules: 'id, kind',
      budgets: '[month+categoryId], month',
      plans: 'month',
      debts: 'id',
      alerts: 'id, at',
      kv: 'key',
    });
    // v2: closed months and their report cards. Existing data is untouched; this only adds a table.
    this.version(2).stores({ reports: 'month' });
  }
}

export const DB_NAME = isDemo ? 'tally-demo' : 'tally';
export const db = new TallyDB(DB_NAME);

/** First run, and after upgrades: make sure every built-in category exists. */
export async function ensureSeed(): Promise<void> {
  const have = new Set((await db.categories.toCollection().primaryKeys()) as string[]);
  const missing = DEFAULT_CATEGORIES.filter((c) => !have.has(c.id));
  // bulkPut, not bulkAdd: two concurrent calls (StrictMode in dev, two tabs in use) must not fail on the second insert.
  if (missing.length) await db.categories.bulkPut(missing);
}

export function setDemo(on: boolean): void {
  try {
    if (on) localStorage.setItem('tally.demo', '1');
    else localStorage.removeItem('tally.demo');
  } catch {
    /* storage blocked — nothing to do */
  }
  location.reload();
}
