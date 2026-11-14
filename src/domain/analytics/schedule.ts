import { addDays, addMonths, daysInMonth, diffDays, makeDate } from '../../lib/dates';
import type { ISODate } from '../../lib/dates';
import type { Pence } from '../../lib/money';
import type { Debt, Txn } from '../types';
import type { CatMap } from './aggregate';
import type { Cadence, Recurring } from './recurring';

/**
 * Missed and late payment detection.
 *
 * A recurring payment is treated as a schedule of due dates. Each due date is matched to the
 * nearest real payment inside a tolerance window and classified:
 *
 *   paid     – arrived on time (within `onTime` days of the due date)
 *   late     – arrived, but later than that
 *   partial  – arrived but for clearly less than expected (debts only)
 *   missed   – nothing arrived and the data covers well past the due date
 *   pending  – nothing yet, but the statements don't reach far enough past the due date to say
 *
 * That last state is the important one. "I can't see a payment" only means "it wasn't made" when
 * the imported statements actually cover the period; otherwise everything due since your last
 * import would be flagged. `horizon` is therefore the last day your statements cover.
 */
export type PayState = 'paid' | 'late' | 'partial' | 'missed' | 'pending';

export interface Occurrence {
  due: ISODate;
  state: PayState;
  paidOn?: ISODate;
  paid?: Pence;
}

export interface Schedule {
  key: string; // recurring key, or "debt:<id>"
  label: string;
  source: 'recurring' | 'debt';
  direction: 'out' | 'in';
  expected: Pence;
  /** Most recent due dates, oldest first (at most six). */
  history: Occurrence[];
  /** Consecutive recent due dates that were missed or underpaid. */
  missedInRow: number;
  /** How many of the recent due dates were paid late. */
  lateCount: number;
  firstMissed?: ISODate;
  lastPaid?: ISODate;
  status: 'ok' | 'pending' | 'late' | 'missed';
}

interface Window {
  early: number; // days before the due date that still count
  late: number; // days after the due date that still count
  onTime: number; // days after the due date that are still "on time"
  missedAfter: number; // days past the due date, covered by data, before we call it missed
}

const WINDOWS: Record<Cadence, Window> = {
  weekly: { early: 2, late: 2, onTime: 2, missedAfter: 4 },
  fortnightly: { early: 3, late: 3, onTime: 3, missedAfter: 6 },
  monthly: { early: 5, late: 20, onTime: 2, missedAfter: 7 },
  yearly: { early: 14, late: 14, onTime: 7, missedAfter: 21 },
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
};

const monthDue = (key: string, day: number): ISODate => makeDate(Number(key.slice(0, 4)), Number(key.slice(5, 7)), Math.min(day, daysInMonth(key)));

/** Every due date from `first` up to the horizon. */
function dueDates(cadence: Cadence, first: ISODate, day: number, horizon: ISODate): ISODate[] {
  const out: ISODate[] = [];
  if (cadence === 'weekly' || cadence === 'fortnightly') {
    const step = cadence === 'weekly' ? 7 : 14;
    for (let d = first; d <= horizon; d = addDays(d, step)) out.push(d);
    return out;
  }
  const step = cadence === 'monthly' ? 1 : 12;
  const floor = addDays(first, -WINDOWS[cadence].early);
  for (let k = first.slice(0, 7); k <= horizon.slice(0, 7); k = addMonths(k, step)) {
    const due = monthDue(k, day);
    if (due >= floor && due <= horizon) out.push(due);
  }
  return out;
}

/** Summarise a list of classified due dates. */
function summarise(base: Omit<Schedule, 'history' | 'missedInRow' | 'lateCount' | 'firstMissed' | 'lastPaid' | 'status'>, all: Occurrence[]): Schedule {
  const history = all.slice(-6);

  // Walk backwards from the newest due date, collecting the unbroken run of misses. A pending
  // date hasn't been judged yet, so it neither breaks nor extends the run.
  const streak: Occurrence[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const o = history[i]!;
    if (o.state === 'pending') continue;
    if (o.state === 'missed' || o.state === 'partial') streak.push(o);
    else break;
  }
  const missedInRow = streak.length;
  const lastSettled = history.filter((o) => o.state !== 'pending').at(-1);
  return {
    ...base,
    history,
    missedInRow,
    lateCount: history.filter((o) => o.state === 'late').length,
    firstMissed: streak.at(-1)?.due, // pushed newest-first, so the last element is the oldest miss
    lastPaid: [...history].reverse().find((o) => o.paidOn)?.paidOn,
    status: missedInRow > 0 ? 'missed' : history.at(-1)?.state === 'pending' ? 'pending' : lastSettled?.state === 'late' ? 'late' : 'ok',
  };
}

/** Check a detected recurring payment against its own rhythm. */
export function checkRecurring(r: Recurring, horizon: ISODate): Schedule {
  const w = WINDOWS[r.cadence];
  const day = median(r.dates.map((d) => Number(d.slice(8, 10))));
  const dues = dueDates(r.cadence, r.dates[0]!, day, horizon);
  const unused = new Set(r.dates);
  const all: Occurrence[] = dues.map((due) => {
    let best: ISODate | undefined;
    for (const d of unused) {
      const delta = diffDays(due, d);
      if (delta < -w.early || delta > w.late) continue;
      if (best === undefined || Math.abs(delta) < Math.abs(diffDays(due, best))) best = d;
    }
    if (best) {
      unused.delete(best);
      return { due, state: diffDays(due, best) <= w.onTime ? 'paid' : 'late', paidOn: best, paid: r.amount };
    }
    return { due, state: diffDays(due, horizon) >= w.missedAfter ? 'missed' : 'pending' };
  });
  return summarise({ key: r.key, label: r.merchant, source: 'recurring', direction: r.direction, expected: r.amount }, all);
}

/**
 * Check a debt that has a due day and a way to recognise its payments. Unlike a subscription, a
 * debt payment can arrive but fall short of the minimum, so partial payments are reported too.
 * Returns null when there is nothing to check against (no due day, or no `match` text).
 */
export function checkDebt(d: Debt, expected: Pence, txns: Txn[], cats: CatMap, horizon: ISODate, dataStart: ISODate): Schedule | null {
  if (!d.dueDay || !d.match) return null;
  const w = WINDOWS.monthly;
  const needle = d.match.toLowerCase();
  const pays = txns.filter((t) => t.amount < 0 && cats.get(t.categoryId)?.kind !== 'transfer' && `${t.merchant} ${t.raw}`.toLowerCase().includes(needle));
  // Nothing before the balance date (already reflected in it) or before the data begins can be judged.
  const from = d.asOf > dataStart ? d.asOf : dataStart;
  const all: Occurrence[] = [];
  for (let k = from.slice(0, 7); k <= horizon.slice(0, 7); k = addMonths(k, 1)) {
    const due = monthDue(k, d.dueDay);
    if (due < from || due > horizon) continue;
    const inWindow = pays.filter((t) => diffDays(due, t.date) >= -w.early && diffDays(due, t.date) <= w.late);
    if (!inWindow.length) {
      all.push({ due, state: diffDays(due, horizon) >= w.missedAfter ? 'missed' : 'pending' });
      continue;
    }
    const paid = inWindow.reduce((s, t) => s - t.amount, 0);
    const paidOn = inWindow.map((t) => t.date).sort()[0]!;
    const short = expected > 0 && paid < expected * 0.9;
    all.push({ due, paid, paidOn, state: short ? 'partial' : diffDays(due, paidOn) <= w.onTime ? 'paid' : 'late' });
  }
  return summarise({ key: `debt:${d.id}`, label: d.name, source: 'debt', direction: 'out', expected }, all);
}

/** Everything the app watches, in one pass. */
export function buildSchedules(args: {
  recurring: Recurring[];
  debts: Debt[];
  /** Effective minimum per debt id (what the plan expects each month). */
  expected: Map<string, Pence>;
  txns: Txn[];
  cats: CatMap;
  horizon: ISODate | undefined;
  dataStart: ISODate | undefined;
}): Schedule[] {
  if (!args.horizon || !args.dataStart) return [];
  const rec = args.recurring.map((r) => checkRecurring(r, args.horizon!));
  const debt = args.debts
    .map((d) => checkDebt(d, args.expected.get(d.id) ?? d.minPayment, args.txns, args.cats, args.horizon!, args.dataStart!))
    .filter((s): s is Schedule => s !== null);
  return [...debt, ...rec];
}
