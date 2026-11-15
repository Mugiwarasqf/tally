// The core data model. Pure types — no storage or UI code lives here.
import type { ISODate } from '../lib/dates';
import type { Pence } from '../lib/money';
import type { RegionId } from '../lib/region';

export type CategoryKind = 'expense' | 'income' | 'transfer' | 'saving' | 'debt';

export interface Category {
  id: string;
  name: string;
  icon: string; // Phosphor icon key — see src/ui/icons.tsx
  kind: CategoryKind;
  /** Chart colour slot 0-7 (fixed per category so colours never shuffle), or null for neutral grey. */
  slot: number | null;
  /** Budget behaviour: fixed bills are assumed paid in full; flexible spend is paced daily. */
  fixed: boolean;
  /** For spending categories: essentials (needs) or discretionary (wants). Drives the income flow and the 50/30/20 check. */
  bucket?: 'needs' | 'wants';
  order: number;
  system?: boolean; // built-in; can be renamed/recoloured but not deleted
}

/** How a transaction got its category — shown to the user so nothing is a black box. */
export type CatSource = 'manual' | 'rule' | 'learned' | 'own' | 'dictionary' | 'heuristic' | 'pair' | 'none';

export interface Txn {
  id: string; // fingerprint of account + date + amount + description (+ ordinal for look-alikes)
  accountId: string;
  fileId: string;
  date: ISODate;
  amount: Pence; // negative = money out
  balance?: Pence; // end-of-day balance printed on the statement, if any
  type: string; // bank payment-type code
  merchant: string; // cleaned display name
  mkey: string; // normalised merchant key — what rules and learning match on
  detail: string; // reference / location text
  raw: string; // original description lines joined by " | "
  fx?: string; // e.g. "EUR 69.00 @ 1.1610"
  time?: string; // "17:18", only when the statement prints one
  place?: string; // town or machine location as printed
  categoryId: string;
  catSource: CatSource;
  confidence: number; // 0..1; below 0.7 goes to the review queue
  reason: string;
  note?: string;
  reviewed?: boolean;
}

export interface Account {
  id: string;
  name: string;
  bank: string;
  holder?: string;
  key: string; // stable identity, e.g. "hsbc uk:112233:12345678"
  createdAt: number;
}

export interface ImportedFile {
  id: string;
  hash: string; // SHA-256 of the file bytes
  name: string;
  format: string;
  accountId: string;
  periodStart?: ISODate;
  periodEnd?: ISODate;
  opening?: Pence;
  closing?: Pence;
  txnCount: number;
  addedCount: number;
  reconciled: boolean | null; // null when the format has no totals to check against
  importedAt: number;
}

export interface Rule {
  id: string;
  kind: 'user' | 'learned';
  match: 'contains' | 'regex' | 'merchant';
  pattern: string;
  categoryId: string;
  createdAt: number;
  /** Restrict to money going out or coming in; omitted = both. */
  dir?: 'in' | 'out';
  /** Set when the rule was created by a debt, so it is removed with that debt. */
  debtId?: string;
  /** Set when the rule came from the profile step ("this is my pay", "this is my landlord"). */
  profile?: 'pay' | 'rent';
}

export interface PinnedRecurring {
  /** "out:<merchant key>", the same key detection uses. */
  key: string;
  cadence: 'weekly' | 'fortnightly' | 'monthly';
  /** Expected amount per payment, positive pence. */
  amount: Pence;
}

/** Facts the user states directly. Detection fills the gaps; a declared value always wins. */
export interface Profile {
  /** Typical take-home per payslip. */
  payAmount?: Pence;
  payCadence?: 'weekly' | 'fortnightly' | 'monthly';
  /** Merchant keys the user confirmed as their pay. */
  payKeys?: string[];
  /** Rent per month. */
  rentAmount?: Pence;
  rentIncludesBills?: boolean;
  /** Merchant key of whoever the rent is paid to. */
  rentKey?: string;
}

export interface BudgetLine {
  month: string; // cycle key, 'YYYY-MM'
  categoryId: string;
  amount: Pence;
}

/** Per-cycle plan inputs for the planner. */
export interface MonthPlan {
  month: string;
  income?: Pence; // expected income override
  savings?: Pence; // amount to set aside
}

export type DebtKind = 'card' | 'loan' | 'overdraft' | 'bnpl' | 'owed' | 'other';

export interface Debt {
  id: string;
  name: string;
  kind: DebtKind;
  balance: Pence; // outstanding amount as of `asOf`
  asOf: ISODate;
  apr: number; // annual percentage rate, 0 for interest-free
  minPayment: Pence; // minimum monthly payment
  dueDay?: number; // day of month payment is due (1-28)
  /**
   * Optional text that appears in this debt's repayment transactions (a lender name, or a person's name as the
   * bank prints it). Matching payments are counted as debt repayments and reduce the balance.
   */
  match?: string;
  /** Optional pay-by date. The plan makes sure the monthly amount is enough to clear it in time. */
  deadline?: ISODate;
  createdAt: number;
}

export type DebtStrategy = 'avalanche' | 'snowball';
export type DebtPace = 'minimum' | 'balanced' | 'fast' | 'custom' | 'target';

export interface DebtPlanSettings {
  strategy: DebtStrategy;
  pace: DebtPace;
  customMonthly?: Pence; // used when pace = 'custom'
  targetMonths?: number; // used when pace = 'target'
}

/** Where you live, for rent comparisons. */

export interface Settings {
  /** Where the user banks: currency sign, date order, bank and merchant names. Unset means the UK (the original default). */
  region?: RegionId;
  monthStartDay: number;
  theme: 'system' | 'light' | 'dark';
  /** What the user told us directly (profile step). Declared facts beat detection. */
  profile?: Profile;
  debtPlan: DebtPlanSettings;
  notifications: NotificationPrefs;
  dismissedRecurring: string[];
  /** Payments the user marked as recurring themselves (detection needs three on a rhythm; these need none). */
  pinnedRecurring?: PinnedRecurring[];
  /** One-off suggestions the user has dismissed (e.g. "payday"). */
  dismissedHints?: string[];
  onboarded?: boolean;
  lastBackupAt?: number;
}

/** How loudly to watch one recurring payment or debt. Anything left undefined falls back to the global default. */
export interface AlertRule {
  /** Remind me a few days before it's due. */
  upcoming?: boolean;
  /** Tell me if it's missed: never, on the first miss, or only once it has been missed this many times in a row. */
  missed?: 'off' | 1 | 2 | 3;
}

export interface NotificationPrefs {
  enabled: boolean; // OS notifications (needs browser permission)
  budget: boolean;
  bills: boolean; // reminders before bills and debt payments are due
  debt: boolean;
  statements: boolean;
  weekly: boolean;
  /** Alert when an expected payment hasn't appeared (and when one is repeatedly paid late). */
  missed: boolean;
  /** Default for bills and subscriptions: alert after this many missed payments in a row. 2 = "on multiple occasions". */
  missedAfter: 1 | 2 | 3;
  /** Remind me to reconcile the month and get my report card when a budget month ends. */
  monthEnd: boolean;
  /** Default for debt repayments, where a single miss can cost a late fee. */
  debtMissedAfter: 1 | 2 | 3;
  /** Per-item overrides, keyed by recurring key (e.g. "out:netflix") or "debt:<id>". */
  items: Record<string, AlertRule>;
}

/** An alert the app has raised. `at` is when it is due to be shown. */
export interface AlertItem {
  id: string; // stable key, so the same event is never shown twice
  at: number; // epoch ms
  title: string;
  body: string;
  route: string; // hash route to open
  kind: 'budget' | 'bill' | 'debt' | 'statement' | 'weekly' | 'unusual' | 'missed';
  read?: boolean;
  shown?: boolean; // already delivered as an OS notification
}

/** A month that has been reconciled and graded. Stored so the grade stays put and history can be charted. */
export interface ReportSnapshot {
  month: string; // cycle key
  closedAt: number;
  score: number; // 0-100
  grade: string;
  planned: Pence;
  actual: Pence;
  provisional: boolean;
  dims: Array<{ key: string; label: string; score: number; grade: string }>;
}
