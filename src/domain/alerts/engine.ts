import { addDays, diffDays, fmtDay, fmtRelative, makeDate, weekStart, addMonths, daysInMonth } from '../../lib/dates';
import type { ISODate } from '../../lib/dates';
import { fmt } from '../../lib/money';
import type { AccountCoverage } from '../analytics/coverage';
import { lastCovered } from '../analytics/coverage';
import { byCategory, totals } from '../analytics/aggregate';
import type { CatMap } from '../analytics/aggregate';
import type { CycleView } from '../analytics/budget';
import type { Flag } from '../analytics/insights';
import type { Recurring } from '../analytics/recurring';
import type { Schedule } from '../analytics/schedule';
import type { PlanView } from '../debt/plan';
import { cycleKey, cycleLabel } from '../../lib/dates';
import type { AlertItem, Debt, NotificationPrefs, Txn } from '../types';

export interface AlertInput {
  today: ISODate;
  now: number;
  txns: Txn[];
  cats: CatMap;
  cycle: CycleView;
  /** Months that already have a graded report card. */
  reportsClosed: string[];
  recurring: Recurring[];
  /** Due-date checks for recurring payments and debts (see analytics/schedule.ts). */
  schedules: Schedule[];
  debts: Debt[];
  plan: PlanView | null;
  coverage: AccountCoverage[];
  flags: Flag[];
  prefs: NotificationPrefs;
}

/** 09:00 local on a date — the time scheduled reminders fire. */
const at9 = (d: ISODate): number => new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)), 9, 0).getTime();

/** Next calendar date on which day-of-month `day` falls, on or after `from`. */
function nextDueDate(day: number, from: ISODate): ISODate {
  const key = from.slice(0, 7);
  const thisMonth = makeDate(Number(key.slice(0, 4)), Number(key.slice(5, 7)), Math.min(day, daysInMonth(key)));
  if (thisMonth >= from) return thisMonth;
  const nk = addMonths(key, 1);
  return makeDate(Number(nk.slice(0, 4)), Number(nk.slice(5, 7)), Math.min(day, daysInMonth(nk)));
}

/**
 * Work out every alert that applies right now. Pure and deterministic: each alert's id
 * encodes the event it describes (e.g. "budget:2026-11:groceries:80"), so running this
 * repeatedly never produces a duplicate of something already shown.
 */
export function computeAlerts(i: AlertInput): AlertItem[] {
  const out: AlertItem[] = [];
  const { prefs, today, now } = i;

  // ---- budgets: 80% and 100% of any category budget -------------------------
  if (prefs.budget && i.cycle.phase === 'current') {
    for (const l of i.cycle.lines) {
      if (l.budget <= 0 || l.category.kind === 'debt') continue;
      if (l.pct >= 1 && !l.category.fixed) {
        out.push({ id: `budget:${i.cycle.key}:${l.category.id}:100`, at: now, kind: 'budget', route: '/budget', title: `${l.category.name} is over budget`, body: `You've spent ${fmt(l.spent)} against a ${fmt(l.budget)} budget.` });
      } else if (l.pct >= 0.8 && l.pct < 1 && !l.category.fixed) {
        out.push({ id: `budget:${i.cycle.key}:${l.category.id}:80`, at: now, kind: 'budget', route: '/budget', title: `${l.category.name}: 80% used`, body: `${fmt(Math.max(0, l.remaining))} left of ${fmt(l.budget)} for the rest of the cycle.` });
      }
    }
  }

  // ---- bills and subscriptions due within three days -------------------------
  if (prefs.bills) {
    for (const r of i.recurring) {
      if (r.direction !== 'out' || prefs.items[r.key]?.upcoming === false) continue;
      const days = diffDays(today, r.nextDate);
      if (days < 0 || days > 3) continue;
      out.push({
        id: `bill:${r.key}:${r.nextDate}`, at: at9(addDays(r.nextDate, -1)),
        kind: 'bill', route: '/recurring', title: `${r.merchant} is due ${fmtRelative(r.nextDate, today).toLowerCase()}`,
        body: `About ${fmt(r.amount)} (${r.cadence}). Make sure it's covered.`,
      });
    }
  }

  // ---- debt payments ---------------------------------------------------------
  if (prefs.debt) {
    for (const d of i.debts) {
      // A pay-by date (typical for money owed to a person) warns a fortnight ahead.
      const stillOwed = i.plan?.debts.find((x) => x.id === d.id)?.balance ?? d.balance;
      if (d.deadline && stillOwed > 0) {
        const left = diffDays(today, d.deadline);
        if (left >= 0 && left <= 14) {
          out.push({
            id: `debtby:${d.id}:${d.deadline}`, at: now, kind: 'debt', route: '/debts',
            title: `${d.name}: pay by ${fmtDay(d.deadline)}`,
            body: `${fmt(stillOwed)} still to pay. ${left === 0 ? 'It’s due today.' : `${left} day${left === 1 ? '' : 's'} left.`}`,
          });
        }
      }
      if (!d.dueDay || prefs.items[`debt:${d.id}`]?.upcoming === false) continue;
      const due = nextDueDate(d.dueDay, today);
      if (diffDays(today, due) > 3) continue;
      const planned = i.plan?.plan.months[0]?.payments[d.id];
      out.push({
        id: `debt:${d.id}:${due}`, at: now, kind: 'debt', route: '/debts',
        title: `${d.name} payment due ${fmtRelative(due, today).toLowerCase()}`,
        body: planned ? `Your plan sets aside ${fmt(planned)} this month (minimum ${fmt(d.minPayment)}).` : `Minimum payment ${fmt(d.minPayment)} on ${fmtDay(due)}.`,
      });
    }
  }

  // ---- missed and repeatedly-late payments ---------------------------------------
  if (prefs.missed) {
    for (const s of i.schedules) {
      const rule = prefs.items[s.key]?.missed;
      if (rule === 'off') continue;
      const threshold = typeof rule === 'number' ? rule : s.source === 'debt' ? prefs.debtMissedAfter : prefs.missedAfter;
      const route = s.source === 'debt' ? '/debts' : '/recurring';
      if (s.missedInRow >= threshold && s.firstMissed) {
        const short = s.history.filter((o) => o.state === 'partial').at(-1);
        // The count is part of the id, so a second or third miss raises a fresh alert.
        out.push({
          id: `missed:${s.key}:${s.firstMissed}:${s.missedInRow}`, at: now, kind: 'missed', route,
          title: s.direction === 'in'
            ? (s.missedInRow === 1 ? `${s.label}: expected pay hasn’t arrived` : `${s.label}: ${s.missedInRow} pay dates passed with nothing in`)
            : (s.missedInRow === 1 ? `${s.label}: payment missed` : `${s.label}: ${s.missedInRow} payments missed in a row`),
          body: [
            `Expected ${fmtDay(s.firstMissed)} (about ${fmt(s.expected)}).`,
            short?.paid !== undefined && short.state === 'partial' ? `Only ${fmt(short.paid)} was paid.` : null,
            s.lastPaid ? `Last paid ${fmtDay(s.lastPaid)}.` : null,
            s.direction === 'in' ? 'Worth checking with your employer if it’s late.' : s.source === 'debt' ? 'Late payments can bring fees and affect your credit file.' : 'Worth checking your balance, or whether it was cancelled.',
          ].filter(Boolean).join(' '),
        });
      }
      const lateNeeded = Math.max(2, typeof rule === 'number' ? rule : 2);
      if (s.lateCount >= lateNeeded && s.missedInRow === 0) {
        const lastLate = s.history.filter((o) => o.state === 'late').at(-1)!;
        out.push({
          id: `late:${s.key}:${s.lateCount}:${lastLate.due}`, at: now, kind: 'missed', route,
          title: `${s.label} keeps arriving late`,
          body: `Paid late ${s.lateCount} of the last ${s.history.length} times. The most recent was ${fmtDay(lastLate.paidOn ?? lastLate.due)}, due ${fmtDay(lastLate.due)}.`,
        });
      }
    }
  }

  // ---- month-end report card ------------------------------------------------------
  if (prefs.monthEnd && i.cycle.phase === 'current' && diffDays(i.cycle.start, today) <= 9) {
    const startDay = Number(i.cycle.start.slice(8, 10));
    const prevKey = cycleKey(addDays(i.cycle.start, -1), startDay);
    if (!i.reportsClosed.includes(prevKey)) {
      out.push({
        id: `report:${prevKey}`, at: now, kind: 'statement', route: '/report',
        title: `${cycleLabel(prevKey, startDay)} is over: time to reconcile`,
        body: 'Add your latest statements and get your report card, including how the month compared with your history.',
      });
    }
  }

  // ---- stale statements ------------------------------------------------------
  if (prefs.statements) {
    const last = lastCovered(i.coverage);
    if (last && diffDays(last, today) >= 30) {
      out.push({
        id: `stmt:${today.slice(0, 7)}`, at: now, kind: 'statement', route: '/import',
        title: 'Time to add your latest statement',
        body: `Your imports run up to ${fmtDay(last)}. Add the newest one to keep your budget accurate.`,
      });
    }
  }

  // ---- Monday digest of last week -------------------------------------------
  if (prefs.weekly) {
    const thisMon = weekStart(today);
    const lastMon = addDays(thisMon, -7);
    const prevMon = addDays(thisMon, -14);
    const last = lastCovered(i.coverage);
    if (last && last >= addDays(thisMon, -1)) {
      const wk = (s: ISODate) => i.txns.filter((t) => t.date >= s && t.date <= addDays(s, 6));
      const cur = totals(wk(lastMon), i.cats).spent;
      const prev = totals(wk(prevMon), i.cats).spent;
      const top = byCategory(wk(lastMon), i.cats)[0];
      const delta = prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null;
      out.push({
        id: `weekly:${thisMon}`, at: at9(thisMon), kind: 'weekly', route: '/',
        title: `Last week: ${fmt(cur)} spent`,
        body: [delta === null ? null : `${delta >= 0 ? 'Up' : 'Down'} ${Math.abs(delta)}% on the week before.`, top ? `Most went on ${i.cats.get(top.categoryId)?.name ?? 'other'}.` : null].filter(Boolean).join(' '),
      });
    }
  }

  // ---- unusual or doubled charges (last 14 days) -----------------------------
  if (prefs.budget) {
    const since = addDays(today, -14);
    for (const f of i.flags.filter((x) => x.txn.date >= since).slice(0, 3)) {
      out.push({
        id: `flag:${f.txn.id}`, at: now, kind: 'unusual', route: '/transactions',
        title: f.kind === 'double' ? 'Possible double charge' : 'Unusually large payment',
        body: `${f.txn.merchant} ${fmt(-f.txn.amount)} on ${fmtDay(f.txn.date)}. ${f.note}.`,
      });
    }
  }
  return out;
}
