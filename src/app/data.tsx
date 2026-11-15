import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ensureSeed, db } from '../data/db';
import { DEFAULT_SETTINGS, loadSettings, mergeSettings, applyTheme } from '../data/settings';
import { deliverDue, setBadge, syncAlerts } from '../data/notify';
import { addMonths, cycleKey, cycleRange, today as todayISO } from '../lib/dates';
import type { CycleKey, ISODate } from '../lib/dates';
import { toCatMap, dateRange } from '../domain/analytics/aggregate';
import type { CatMap } from '../domain/analytics/aggregate';
import { cycleView, history } from '../domain/analytics/budget';
import type { CycleView } from '../domain/analytics/budget';
import { coverage, lastCovered } from '../domain/analytics/coverage';
import type { AccountCoverage } from '../domain/analytics/coverage';
import { buildSavingsPlan } from '../domain/analytics/cuts';
import type { SavingsPlan } from '../domain/analytics/cuts';
import { buildIncomeProfile, expectedIncomeFor } from '../domain/analytics/income';
import type { IncomeProfile } from '../domain/analytics/income';
import { findFlags } from '../domain/analytics/insights';
import { spendHistory } from '../domain/analytics/trend';
import type { MonthPoint } from '../domain/analytics/trend';
import type { Flag } from '../domain/analytics/insights';
import { detectRecurring, withPinned } from '../domain/analytics/recurring';
import type { Recurring } from '../domain/analytics/recurring';
import { buildSchedules } from '../domain/analytics/schedule';
import type { Schedule } from '../domain/analytics/schedule';
import { computeAlerts } from '../domain/alerts/engine';
import { buildPlan, plannedFor } from '../domain/debt/plan';
import type { PlanView } from '../domain/debt/plan';
import { addDays } from '../lib/dates';
import { setRegion } from '../lib/region';
import type { Account, AlertItem, BudgetLine, Category, Debt, ImportedFile, MonthPlan, ReportSnapshot, Rule, Settings, Txn } from '../domain/types';

export interface AppData {
  ready: boolean;
  today: ISODate;
  txns: Txn[];
  accounts: Account[];
  files: ImportedFile[];
  categories: Category[];
  catMap: CatMap;
  rules: Rule[];
  budgets: BudgetLine[];
  plans: MonthPlan[];
  debts: Debt[];
  alerts: AlertItem[];
  settings: Settings;
  coverage: AccountCoverage[];
  lastData?: ISODate;
  recurring: Recurring[];
  /** Every budget month the data touches, each judged against the months before it. */
  history: MonthPoint[];
  /** Months that have been reconciled and graded. */
  reports: ReportSnapshot[];
  /** Detected pay streams (weekly, fortnightly, monthly), the usual payday and the next pay. */
  income: IncomeProfile;
  /** Due-date checks: which recurring payments and debts are on time, late or missed. */
  schedules: Schedule[];
  flags: Flag[];
  /** Debt plan for the current cycle onward; null when there are no debts. */
  plan: PlanView | null;
  /** Cycle the debt plan starts in (the current calendar cycle). */
  planKey: CycleKey;
  /** Which cycle the pages are showing, and how to move it. */
  viewKey: CycleKey;
  setViewKey: (k: CycleKey) => void;
  minKey: CycleKey;
  maxKey: CycleKey;
  /** Numbers for the viewed cycle (budget pacing, totals, projection). */
  cycle: CycleView;
  cycleFor: (key: CycleKey) => CycleView;
  /** The same, but treating `extra` as if it were budgets for that cycle (used to grade an un-budgeted month). */
  cycleWith: (key: CycleKey, extra: BudgetLine[]) => CycleView;
  /** A savings plan for a cycle: what to cut to reach `goal` (defaults to the savings set for that month). */
  savingsFor: (key: CycleKey, opts?: { goal?: number; selected?: Set<string> }) => SavingsPlan;
}

const Ctx = createContext<AppData | null>(null);

/** Income to plan on for a cycle, from the detected pay dates that fall inside it. */
function incomeFor(income: IncomeProfile, key: CycleKey, startDay: number): { incomeExpected?: number; paydays?: number } {
  if (!income.streams.length && !income.irregularMonthly) return {};
  const { start, end } = cycleRange(key, startDay);
  const e = expectedIncomeFor(income, start, end);
  return { incomeExpected: e.total, paydays: e.paydays };
}

export function useApp(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside <DataProvider>');
  return v;
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    void ensureSeed().then(async () => {
      const s = await loadSettings();
      setRegion(s.region);
      applyTheme(s.theme);
      setSeeded(true);
    });
  }, []);

  const txnsQ = useLiveQuery(() => db.txns.orderBy('date').reverse().toArray(), []);
  const accountsQ = useLiveQuery(() => db.accounts.toArray(), []);
  const filesQ = useLiveQuery(() => db.files.toArray(), []);
  const catsQ = useLiveQuery(() => db.categories.orderBy('id').toArray(), []);
  const rulesQ = useLiveQuery(() => db.rules.toArray(), []);
  const budgetsQ = useLiveQuery(() => db.budgets.toArray(), []);
  const plansQ = useLiveQuery(() => db.plans.toArray(), []);
  const debtsQ = useLiveQuery(() => db.debts.toArray(), []);
  const alertsQ = useLiveQuery(() => db.alerts.orderBy('at').reverse().toArray(), []);
  const reportsQ = useLiveQuery(() => db.reports.orderBy('month').toArray(), []);
  const settingsQ = useLiveQuery(async () => mergeSettings((await db.kv.get('settings'))?.value as Partial<Settings> | undefined), []);

  const ready = seeded && [txnsQ, accountsQ, filesQ, catsQ, rulesQ, budgetsQ, plansQ, debtsQ, alertsQ, reportsQ, settingsQ].every((q) => q !== undefined);
  const txns = txnsQ ?? [];
  const accounts = accountsQ ?? [];
  const files = filesQ ?? [];
  const categories = useMemo(() => [...(catsQ ?? [])].sort((a, b) => a.order - b.order), [catsQ]);
  const rules = rulesQ ?? [];
  const budgets = budgetsQ ?? [];
  const plans = plansQ ?? [];
  const debts = debtsQ ?? [];
  const alerts = alertsQ ?? [];
  const reports = reportsQ ?? [];
  const settings = settingsQ ?? DEFAULT_SETTINGS;
  // Money formatting and amount thresholds read the region; set it before anything below renders a figure.
  setRegion(settings.region);
  const startDay = settings.monthStartDay;

  const today = todayISO();
  const catMap = useMemo(() => toCatMap(categories), [categories]);
  const range = useMemo(() => dateRange(txns), [txns]);
  const cov = useMemo(() => coverage(accounts, files), [accounts, files]);
  const lastData = useMemo(() => lastCovered(cov) ?? range?.max, [cov, range]);
  const recurring = useMemo(
    () => withPinned(detectRecurring(txns, catMap, lastData ?? today), settings.pinnedRecurring ?? [], txns).filter((r) => r.pinned || !settings.dismissedRecurring.includes(r.key)),
    [txns, catMap, lastData, today, settings.dismissedRecurring, settings.pinnedRecurring],
  );
  const monthHistory = useMemo(() => spendHistory(txns, catMap, startDay), [txns, catMap, startDay]);
  const income = useMemo(() => buildIncomeProfile(txns, catMap, recurring, today, settings.profile), [txns, catMap, recurring, today, settings.profile]);
  const flags = useMemo(() => findFlags(txns, catMap, addDays(today, -45)), [txns, catMap, today]);

  // Cycle navigation. Default view: this cycle, unless it has no data yet, in which case the latest cycle that does.
  const thisKey = cycleKey(today, startDay);
  const maxKey = addMonths(thisKey, 1);
  const minKey = range ? cycleKey(range.min, startDay) : thisKey;
  const defaultKey = range && !txns.some((t) => cycleKey(t.date, startDay) === thisKey) ? cycleKey(range.max, startDay) : thisKey;
  const [picked, setViewKey] = useState<CycleKey | null>(null);
  const viewKey = picked ?? defaultKey;

  // Debt plan: two passes — first the budget without debt, to learn what is affordable, then the plan itself.
  const planKey = thisKey;
  const base = useMemo(
    () => cycleView({ txns, cats: categories, catMap, budgets, plans, key: planKey, startDay, today, ...incomeFor(income, planKey, startDay) }),
    [txns, categories, catMap, budgets, plans, planKey, startDay, today, income],
  );
  const plan = useMemo<PlanView | null>(() => {
    if (!debts.length) return null;
    const typicalSpend = [...history(txns, catMap, planKey, startDay).spend.entries()]
      .filter(([id]) => catMap.get(id)?.kind === 'expense')
      .reduce((s, [, v]) => s + v, 0);
    return buildPlan({
      debts, txns, cats: catMap, settings: settings.debtPlan, startKey: planKey,
      income: base.expectedIncome,
      plannedSpend: base.budgetTotal > 0 ? base.budgetTotal : typicalSpend,
      savings: base.savingsGoal,
    });
  }, [debts, txns, catMap, settings.debtPlan, planKey, startDay, base]);

  const schedules = useMemo(
    () => buildSchedules({
      recurring, debts, txns, cats: catMap, horizon: lastData, dataStart: range?.min,
      expected: new Map((plan?.debts ?? []).map((d) => [d.id, d.min])),
    }),
    [recurring, debts, txns, catMap, lastData, range, plan],
  );

  const cycleWith = useMemo(
    () => (key: CycleKey, extra: BudgetLine[]) => cycleView({ txns, cats: categories, catMap, budgets: [...budgets, ...extra], plans, key, startDay, today, debtPlanned: plan ? plannedFor(plan, key) : 0, ...incomeFor(income, key, startDay) }),
    [txns, categories, catMap, budgets, plans, startDay, today, plan, income],
  );
  const cycleFor = useMemo(() => (key: CycleKey) => cycleWith(key, []), [cycleWith]);

  const savingsFor = useMemo(
    () => (key: CycleKey, opts: { goal?: number; selected?: Set<string> } = {}) => {
      const h = history(txns, catMap, key, startDay, 3);
      return buildSavingsPlan({
        typical: h.spend, recent: h.perCycle, categories,
        income: cycleFor(key).expectedIncome,
        goal: opts.goal ?? plans.find((p) => p.month === key)?.savings ?? 0,
        debtPlanned: plan ? plannedFor(plan, key) : 0,
        recurring, txns, asOf: lastData ?? today, selected: opts.selected,
      });
    },
    [txns, catMap, startDay, categories, cycleFor, plans, plan, recurring, lastData, today],
  );
  const cycle = useMemo(() => cycleFor(viewKey), [cycleFor, viewKey]);

  // Alerts: recompute whenever the picture changes, store new ones, and deliver any that are due.
  const currentCycle = useMemo(() => cycleFor(thisKey), [cycleFor, thisKey]);
  useEffect(() => {
    if (!ready || !txns.length) return;
    const items = computeAlerts({ today, now: Date.now(), txns, cats: catMap, cycle: currentCycle, reportsClosed: reports.map((r) => r.month), recurring, schedules, debts, plan, coverage: cov, flags, prefs: settings.notifications });
    void syncAlerts(items).then(() => deliverDue(settings.notifications)).catch(() => { /* alerts are best-effort; never break the app */ });
  }, [ready, txns, catMap, currentCycle, reports, recurring, schedules, debts, plan, cov, flags, settings.notifications, today]);

  const unread = alerts.filter((a) => !a.read && a.at <= Date.now()).length;
  useEffect(() => { void setBadge(unread); }, [unread]);

  const value: AppData = {
    ready, today, txns, accounts, files, categories, catMap, rules, budgets, plans, debts, alerts, settings,
    coverage: cov, lastData, recurring, history: monthHistory, reports, income, schedules, flags, plan, planKey, viewKey, setViewKey, minKey, maxKey, cycle, cycleFor, cycleWith, savingsFor,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
