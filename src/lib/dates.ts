// Dates are plain 'YYYY-MM-DD' strings throughout. Arithmetic goes through UTC
// so daylight-saving changes can never shift a day.
export type ISODate = string;
export type CycleKey = string; // 'YYYY-MM' — the month in which a budget cycle starts

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const monthIndex = (name: string): number => {
  const i = MONTHS.findIndex((m) => name.toLowerCase().startsWith(m.toLowerCase()));
  return i;
};

const toUTC = (d: ISODate) => {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y!, m! - 1, day!);
};
const fromUTC = (t: number): ISODate => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

export const makeDate = (y: number, m1: number, d: number): ISODate => `${y}-${pad(m1)}-${pad(d)}`;
export const addDays = (d: ISODate, n: number): ISODate => fromUTC(toUTC(d) + n * 86_400_000);
export const diffDays = (a: ISODate, b: ISODate): number => Math.round((toUTC(b) - toUTC(a)) / 86_400_000);
export const dow = (d: ISODate): number => new Date(toUTC(d)).getUTCDay(); // 0 = Sunday
export const isValidDate = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d) && fromUTC(toUTC(d)) === d;

export function today(): ISODate {
  const d = new Date();
  return makeDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** Monday of the week containing d. */
export function weekStart(d: ISODate): ISODate {
  const w = (dow(d) + 6) % 7; // Monday = 0
  return addDays(d, -w);
}

export const monthStart = (d: ISODate): ISODate => `${d.slice(0, 7)}-01`;
export function daysInMonth(key: CycleKey): number {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

// ---- budget cycles ---------------------------------------------------------
// A cycle runs from `startDay` of one month to the day before `startDay` of the
// next. With startDay = 1 these are calendar months. People paid on the 25th can
// set 25 and every total in the app follows.

export function cycleKey(d: ISODate, startDay = 1): CycleKey {
  if (startDay <= 1) return d.slice(0, 7);
  const day = Number(d.slice(8, 10));
  return day >= startDay ? d.slice(0, 7) : addMonths(d.slice(0, 7), -1);
}

export function addMonths(key: CycleKey, n: number): CycleKey {
  const [y, m] = key.split('-').map(Number);
  const t = (y! * 12 + (m! - 1)) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}

export function cycleRange(key: CycleKey, startDay = 1): { start: ISODate; end: ISODate } {
  const start = `${key}-${pad(Math.max(1, startDay))}`;
  const end = addDays(`${addMonths(key, 1)}-${pad(Math.max(1, startDay))}`, -1);
  return { start, end };
}

export function cycleDays(key: CycleKey, startDay = 1): number {
  const { start, end } = cycleRange(key, startDay);
  return diffDays(start, end) + 1;
}

export function cycleLabel(key: CycleKey, startDay = 1, short = false): string {
  const [y, m] = key.split('-').map(Number);
  if (startDay <= 1) return short ? `${MONTHS[m! - 1]} ${String(y).slice(2)}` : `${MONTHS_LONG[m! - 1]} ${y}`;
  const { start, end } = cycleRange(key, startDay);
  return `${fmtDay(start)} – ${fmtDay(end)}`;
}

// ---- formatting ------------------------------------------------------------
export function fmtDay(d: ISODate): string {
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
}
export function fmtDayYear(d: ISODate): string {
  return `${fmtDay(d)} ${d.slice(0, 4)}`;
}
export function fmtWeekday(d: ISODate): string {
  return DOW[dow(d)]!;
}
/** 1 → "1st", 2 → "2nd", 11 → "11th", 22 → "22nd". */
export const ordinal = (n: number): string => `${n}${n % 10 > 3 || n % 10 === 0 || [11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10]}`;

/** "Thursday 15 Oct 2026" */
export function fmtFull(d: ISODate): string {
  return `${DOW_LONG[dow(d)]} ${fmtDayYear(d)}`;
}
/** "Today", "Yesterday", or "Tue 14 Oct". */
export function fmtRelative(d: ISODate, now: ISODate = today()): string {
  const diff = diffDays(d, now);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return `${fmtWeekday(d)} ${fmtDay(d)}`;
}
export const monthShort = (m1: number): string => MONTHS[m1 - 1]!;

export function* eachDay(start: ISODate, end: ISODate): Generator<ISODate> {
  for (let d = start; d <= end; d = addDays(d, 1)) yield d;
}

export const clampDate = (d: ISODate, lo: ISODate, hi: ISODate): ISODate => (d < lo ? lo : d > hi ? hi : d);
