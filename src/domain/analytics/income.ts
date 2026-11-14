import { diffDays } from '../../lib/dates';
import type { ISODate } from '../../lib/dates';
import { fmt, roundTo5 } from '../../lib/money';
import type { Pence } from '../../lib/money';
import type { TxnPatch } from '../import/pair';
import type { Profile, Txn } from '../types';
import { dateRange, kindOf } from './aggregate';
import type { CatMap } from './aggregate';
import { detectRecurring, stepDate } from './recurring';
import type { Cadence, Recurring } from './recurring';

/**
 * Income as the stem of the budget.
 *
 * Money in is split into two kinds:
 *   - regular streams: pay that repeats on a rhythm (weekly, fortnightly or monthly), found by the same
 *     pattern detection used for bills. These are dependable, so they count in full.
 *   - irregular income: side income, gifts, one-offs. Real, but not something to budget against, so only
 *     half of its typical amount counts toward what you can plan to spend.
 */
export interface IncomeStream {
  key: string;
  label: string;
  categoryId: string;
  cadence: Exclude<Cadence, 'yearly'>;
  amount: Pence; // typical single payment
  monthly: Pence; // monthly equivalent (weekly × 52/12, fortnightly × 26/12)
  dates: ISODate[];
  lastDate: ISODate;
  nextDate: ISODate;
  /** Day of the month it usually lands on (monthly pay only). */
  payday?: number;
}

export interface IncomeProfile {
  streams: IncomeStream[];
  main?: IncomeStream;
  regularMonthly: Pence;
  irregularMonthly: Pence;
  /** What it's safe to plan on per month: regular pay in full plus half of irregular income. */
  expectedMonthly: Pence;
  /** Day of month of the main monthly salary, if there is one. */
  payday?: number;
  nextPay?: { date: ISODate; amount: Pence; label: string; projected: boolean };
  /** True when the pay figure came from the user's profile rather than detection. */
  declared: boolean;
}

const PER_MONTH: Record<IncomeStream['cadence'], number> = { weekly: 52 / 12, fortnightly: 26 / 12, monthly: 1 };
const MONTH_DAYS = 30.44;
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;

export function buildIncomeProfile(txns: Txn[], cats: CatMap, recurring: Recurring[], today: ISODate, profile?: Profile): IncomeProfile {
  const declared = !!(profile?.payAmount && profile.payCadence);
  let streams: IncomeStream[] = recurring
    .filter((r): r is Recurring & { cadence: IncomeStream['cadence'] } => r.direction === 'in' && r.cadence !== 'yearly')
    .map((r) => ({
      key: r.key,
      label: r.merchant,
      categoryId: r.categoryId,
      cadence: r.cadence,
      amount: r.amount,
      monthly: Math.round(r.amount * PER_MONTH[r.cadence]),
      dates: r.dates,
      lastDate: r.lastDate,
      nextDate: r.nextDate,
      payday: r.cadence === 'monthly' ? median(r.dates.map((d) => Number(d.slice(8, 10)))) : undefined,
    }))
    .sort((a, b) => b.monthly - a.monthly);

  // Which credits count as pay. Declared: the payers the user ticked (or, failing that, whatever is categorised
  // as salary); the amount and rhythm are the user's own figures, so the budget plans on exactly those.
  let regularMkeys = new Set(streams.map((s) => s.key.slice(3)));
  if (declared) {
    const keys = new Set(profile!.payKeys ?? []);
    const pay = txns.filter((t) => t.amount > 0 && (keys.size ? keys.has(t.mkey) : t.categoryId === 'salary')).sort((a, b) => a.date.localeCompare(b.date));
    const dates = [...new Set(pay.map((t) => t.date))];
    const last = dates.at(-1);
    const cadence = profile!.payCadence!;
    streams = [{
      key: 'declared', label: pay.at(-1)?.merchant ?? 'Your pay', categoryId: 'salary', cadence,
      amount: profile!.payAmount!, monthly: Math.round(profile!.payAmount! * PER_MONTH[cadence]),
      dates, lastDate: last ?? today, nextDate: last ? stepDate(last, cadence) : today,
      payday: cadence === 'monthly' && dates.length ? median(dates.map((d) => Number(d.slice(8, 10)))) : undefined,
    }];
    regularMkeys = new Set(pay.map((t) => t.mkey));
  }

  const range = dateRange(txns);
  const months = range ? Math.max(1, (diffDays(range.min, range.max) + 1) / MONTH_DAYS) : 1;
  const irregularTotal = txns
    .filter((t) => kindOf(t, cats) === 'income' && t.categoryId !== 'refunds' && !regularMkeys.has(t.mkey))
    .reduce((s, t) => s + t.amount, 0);
  const irregularMonthly = Math.max(0, Math.round(irregularTotal / months));
  const regularMonthly = streams.reduce((s, x) => s + x.monthly, 0);

  // Next payday: the soonest of every stream, rolled forward past today when the statements stop earlier.
  let nextPay: IncomeProfile['nextPay'];
  for (const s of streams) {
    if (!s.dates.length) continue; // declared pay with no matching credit yet: nothing to project from
    let d = s.nextDate;
    let projected = false;
    for (let i = 0; i < 60 && d < today; i++) {
      d = stepDate(d, s.cadence);
      projected = true;
    }
    if (!nextPay || d < nextPay.date) nextPay = { date: d, amount: s.amount, label: s.label, projected };
  }
  const main = streams[0];
  return {
    streams, main, regularMonthly, irregularMonthly, declared,
    // Declared pay is planned on exactly; detected pay also counts half of irregular income.
    expectedMonthly: declared ? regularMonthly : roundTo5(regularMonthly + irregularMonthly * 0.5),
    payday: main?.payday,
    nextPay,
  };
}

/** Pay dates of one stream inside a window: ones already received, plus ones its rhythm says are still to come. */
export function payDatesIn(s: IncomeStream, start: ISODate, end: ISODate): ISODate[] {
  const out = s.dates.filter((d) => d >= start && d <= end);
  let d = s.lastDate;
  for (let i = 0; i < 80; i++) {
    d = stepDate(d, s.cadence);
    if (d > end) break;
    if (d >= start) out.push(d);
  }
  return out;
}

/**
 * Income to plan on for a budget cycle. For fortnightly and weekly pay this counts the pay dates that
 * actually fall in the cycle, so a month with three fortnightly paydays plans on three payments, not
 * a flat average.
 */
export function expectedIncomeFor(p: IncomeProfile, start: ISODate, end: ISODate): { total: Pence; paydays: number } {
  let total = 0;
  let paydays = 0;
  for (const s of p.streams) {
    const n = payDatesIn(s, start, end).length;
    total += n * s.amount;
    if (s === p.main) paydays = n;
  }
  const days = diffDays(start, end) + 1;
  if (!p.declared) total += Math.round(p.irregularMonthly * 0.5 * (days / MONTH_DAYS));
  return { total: roundTo5(total), paydays };
}

const LOCKED = new Set(['manual', 'rule', 'learned']);
const RHYTHM: Record<IncomeStream['cadence'], string> = { weekly: 'every week', fortnightly: 'every two weeks', monthly: 'every month' };

/**
 * Pattern-based income detection. Money that arrives on a steady rhythm from the same source, and that no
 * rule or dictionary entry could explain, is almost certainly pay. Reclassify it as salary so the budget
 * stem is right even when the bank's wording says nothing like "wages".
 */
export function incomePatternPatches(txns: Txn[], cats: CatMap, asOf: ISODate): TxnPatch[] {
  const patches: TxnPatch[] = [];
  for (const r of detectRecurring(txns, cats, asOf)) {
    if (r.direction !== 'in' || r.cadence === 'yearly') continue;
    const mkey = r.key.slice(3); // strip "in:"
    for (const t of txns) {
      if (t.mkey !== mkey || t.amount <= 0 || LOCKED.has(t.catSource)) continue;
      const unexplained = t.categoryId === 'unsorted-in' || (t.categoryId === 'other-income' && t.catSource === 'heuristic');
      if (!unexplained) continue;
      patches.push({
        id: t.id,
        patch: { categoryId: 'salary', catSource: 'heuristic', confidence: 0.85, reason: `Arrives ${RHYTHM[r.cadence]} for about ${fmt(r.amount)}: looks like regular pay` },
      });
    }
  }
  return patches;
}
