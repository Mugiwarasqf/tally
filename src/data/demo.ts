import { addDays, addMonths, cycleKey, cycleRange, dow, makeDate, today } from '../lib/dates';
import type { ISODate } from '../lib/dates';
import { uid } from '../lib/hash';
import { buildTxns } from '../domain/import/build';
import type { RawTxn } from '../domain/import/types';
import { toCatMap } from '../domain/analytics/aggregate';
import { history, suggestBudgets } from '../domain/analytics/budget';
import { DEFAULT_CATEGORIES } from '../domain/categorize/categories';
import type { Account, Debt, ImportedFile } from '../domain/types';
import { db, ensureSeed } from './db';
import { buildSavingsPlan } from '../domain/analytics/cuts';
import { buildIncomeProfile } from '../domain/analytics/income';
import { detectRecurring } from '../domain/analytics/recurring';
import { refreshDerived } from './importer';
import { saveSettings } from './settings';

/** Small seeded PRNG so the demo looks identical every time. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOLDER = 'Alex Morgan';
const SAVINGS_ACCT = '112233 44556677';

function generate(from: ISODate, to: ISODate): RawTxn[] {
  const rnd = mulberry32(2026);
  const between = (lo: number, hi: number) => Math.round((lo + rnd() * (hi - lo)) * 100);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const out: RawTxn[] = [];
  const add = (date: ISODate, amount: number, type: string, ...lines: string[]) => out.push({ date, amount, type, lines });
  const monthsBack = (d: ISODate) => Math.round((Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7))) - (Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7))));

  for (let d = from; d <= to; d = addDays(d, 1)) {
    const day = Number(d.slice(8, 10));
    const wk = dow(d);
    const weekday = wk >= 1 && wk <= 5;

    // fixed monthly rhythm
    if (day === 1) add(d, -85_000, 'BP', 'Harbour Lettings Ltd', 'Rent');
    if (day === 2) add(d, -5_500, 'DD', 'BARCLAYCARD', 'Card repayment');
    if (day === 3) add(d, -1_099, 'VIS', "INT'L 0000011111", 'NETFLIX.COM');
    if (day === 5) add(d, monthsBack(d) === 0 ? -1_299 : -1_199, 'VIS', "INT'L 0000022222", 'SPOTIFY');
    if (day === 6) add(d, -14_000, 'DD', 'TSB LOAN REPAY', 'Loan');
    if (day === 8 && monthsBack(d) > 1) add(d, -2_499, 'DD', 'PUREGYM LTD', 'Membership'); // missed in the last two months
    if (day === 12) add(d, -1_800, 'DD', 'EE LIMITED', 'Mobile');
    if (day === 14) add(d, -4_799, 'DD', 'VIRGIN MEDIA', 'Broadband'); // above the UK typical, so the plan has a bill to compare
    // Due on the 15th, but twice paid nine days late.
    if (day === ([1, 3].includes(monthsBack(d)) ? 24 : 15)) add(d, -3_500, 'VIS', 'ZILCH INSTALMENT', 'GB');
    if (day === 20) add(d, -between(62, 88), 'DD', 'OCTOPUS ENERGY', 'Electricity');
    if (day === 21) add(d, -between(100, 140), 'VIS', 'LemFi', 'Austin');
    // Weekly shift pay with varying hours; nothing in the wording says "wages", so only its rhythm gives it away.
    if (wk === 5) add(d, between(70, 105), 'CR', 'Greenfield Events Ltd', 'Shift');
    if (day === 28) {
      add(d, 245_000, 'CR', 'Northwind Studio Ltd', 'Wages');
      add(d, -30_000, 'OBP', 'Chip Savings', 'Auto save');
      add(d, -5_000, 'TFR', SAVINGS_ACCT, 'INTERNET TRANSFER'); // a small move between your own accounts
    }

    // everyday spending
    if (rnd() < 0.62) add(d, -between(6, 38), ')))', pick(['TESCO STORES 4821', 'ALDI', 'LIDL GB LEEDS', 'ASDA STORES 1177', "SAINSBURY'S S/MKTS"]), pick(['LEEDS', 'MANCHESTER']));
    if (rnd() < 0.34) add(d, -between(4, 24), ')))', pick(['PRET A MANGER', 'GREGGS', 'COSTA COFFEE', 'NANDOS', 'LEON RESTAURANT']), 'LEEDS');
    if (weekday && rnd() < 0.55) add(d, -between(2.8, 14), 'VIS', pick(['TFL TRAVEL CHARGE', 'TRAINLINE', 'UBER *TRIP']), 'LONDON');
    if (rnd() < 0.12) add(d, -between(8, 70), 'VIS', pick(['AMAZON.CO.UK', 'PRIMARK', 'ARGOS', 'H&M']), 'ONLINE');
    if (rnd() < 0.045) add(d, -between(6, 22), ')))', 'BOOTS', 'LEEDS');
    if (rnd() < 0.04) add(d, -between(7, 18), ')))', pick(['VUE ENTERTAINMENT', 'STEAM PURCHASE']), 'LEEDS');
    if (rnd() < 0.05) add(d, -2_000, 'ATM', 'CASH HALIFAX', 'LEEDS@17:01');
    if (rnd() < 0.07) add(d, -between(14, 30), 'VIS', 'DELIVEROO', 'LONDON');
    if (rnd() < 0.045) add(d, -between(12, 40), 'BP', pick(['Jamie Rivera', 'Priya Shah', 'Sam Okafor']), pick(['Dinner', 'Money', 'Thanks']));
    if (rnd() < 0.02) add(d, between(15, 60), 'CR', pick(['Jamie Rivera', 'Priya Shah']), 'Sent from Revolut');
    if (rnd() < 0.03) add(d, -between(5, 30), ')))', 'QWXZ TRADING', 'LEEDS');
  }

  // A few moments that make the insights worth looking at.
  const recent = (n: number) => addDays(to, -n);
  add(recent(6), -3_850, ')))', 'PIZZA EXPRESS', 'LEEDS');
  add(recent(6), -3_850, ')))', 'PIZZA EXPRESS', 'LEEDS'); // double charge
  add(recent(10), -18_900, 'VIS', 'AMAZON.CO.UK', 'ONLINE'); // unusually large
  return out.filter((t) => t.date >= from && t.date <= to);
}

/** Load a realistic, entirely fictional dataset into the (separate) demo database. */
export async function loadDemo(): Promise<void> {
  if ((await db.accounts.count()) > 0) return;
  await ensureSeed();
  const end = addDays(today(), -2);
  const start = makeDate(Number(addMonths(end.slice(0, 7), -5).slice(0, 4)), Number(addMonths(end.slice(0, 7), -5).slice(5, 7)), 1);
  const raws = generate(start, end).sort((a, b) => a.date.localeCompare(b.date));

  // Running balance, printed on the last transaction of each day like a real statement.
  let bal = 120_000;
  raws.forEach((t, i) => {
    bal += t.amount;
    if (i === raws.length - 1 || raws[i + 1]!.date !== t.date) t.balance = bal;
  });

  const account: Account = { id: uid(), name: 'Everyday account', bank: 'Demo Bank', holder: HOLDER, key: 'demo:112233:00001111', createdAt: Date.now() };
  await db.accounts.add(account);

  // One "statement" per calendar month, so the coverage timeline has something to show.
  const files: ImportedFile[] = [];
  const all = [];
  for (let k = cycleKey(start); k <= cycleKey(end); k = addMonths(k, 1)) {
    const { start: s, end: e } = cycleRange(k);
    const part = raws.filter((t) => t.date >= s && t.date <= e);
    if (!part.length) continue;
    const fileId = uid();
    files.push({
      id: fileId, hash: `demo-${k}`, name: `Statement ${k}.pdf`, format: 'pdf-hsbc', accountId: account.id,
      periodStart: s, periodEnd: e < end ? e : end, txnCount: part.length, addedCount: part.length, reconciled: true, importedAt: Date.now(),
    });
    all.push(...buildTxns({ bank: 'Demo Bank', format: 'csv', account: { holder: HOLDER }, txns: part, checks: [], warnings: [] }, account.id, fileId, { rules: [], holders: [HOLDER] }));
  }
  await db.files.bulkAdd(files);
  await db.txns.bulkPut(all);
  await refreshDerived(); // pay patterns, like a real import

  const debts: Debt[] = [
    { id: uid(), name: 'Barclaycard', kind: 'card', balance: 1_850_00, asOf: start, apr: 22.9, minPayment: 55_00, dueDay: 2, match: 'barclaycard', createdAt: Date.now() },
    { id: uid(), name: 'TSB personal loan', kind: 'loan', balance: 3_200_00, asOf: start, apr: 9.9, minPayment: 140_00, dueDay: 6, match: 'tsb loan', createdAt: Date.now() },
    { id: uid(), name: 'Zilch', kind: 'bnpl', balance: 240_00, asOf: start, apr: 0, minPayment: 35_00, dueDay: 15, match: 'zilch', createdAt: Date.now() },
  ];
  await db.debts.bulkAdd(debts);

  // Starting budgets for this and next cycle, from the data's own history.
  const cats = DEFAULT_CATEGORIES;
  const catMap = toCatMap(cats);
  const nowKey = cycleKey(today());
  const hist = history(all, catMap, nowKey, 1);
  const profile = buildIncomeProfile(all, catMap, detectRecurring(all, catMap, end), today());
  const savingsBudget = buildSavingsPlan({
    typical: hist.spend, recent: hist.perCycle, categories: cats, income: profile.expectedMonthly, goal: 300_00, debtPlanned: 0,
    recurring: detectRecurring(all, catMap, end), txns: all, asOf: end,
  }).targets;
  // Budgets for this and next month, and for the three before (each from the history available at that time),
  // so the month-end report card has a real plan to grade against.
  for (const key of [addMonths(nowKey, -3), addMonths(nowKey, -2), addMonths(nowKey, -1), nowKey, addMonths(nowKey, 1)]) {
    // This month and next get a savings budget (typical spending with the easiest cuts applied); earlier months keep
    // plain "usual spending" budgets, which is what an un-optimised budget looks like.
    const base = key < nowKey ? suggestBudgets(history(all, catMap, key, 1).spend, cats) : savingsBudget;
    for (const [categoryId, amount] of base) await db.budgets.put({ month: key, categoryId, amount });
    await db.plans.put({ month: key, savings: 300_00 }); // income comes from the detected pay schedule
  }
  await saveSettings({ onboarded: true });
}
