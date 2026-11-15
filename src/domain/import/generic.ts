import { makeDate } from '../../lib/dates';
import { fmt, parseMoney } from '../../lib/money';
import type { Pence } from '../../lib/money';
import { detectDateOrder } from './csv';
import type { DateOrder } from './csv';
import { groupRows, joinItems } from './rows';
import type { Row } from './rows';
import type { Check, ParsedStatement, PdfItem, PdfPage, RawTxn } from './types';
import { ImportError } from './types';

/**
 * Reads a transaction table from any text-based PDF statement, whatever the bank.
 *
 * Case study (docs/06-pdf-statements.md): table extractors (Tabula, Camelot) find
 * columns in tables without ruling lines from where the text sits; commercial
 * converters lean on the running balance to catch misreads; finance apps that
 * skip PDFs entirely send people to CSV. So:
 *
 *  1. Find the table: a heading row (Date / Paid out / Money in / Balance ...) or
 *     rows that start with a date, extended over tightly spaced neighbours.
 *  2. Find the money columns by clustering where amounts sit (right edge, left
 *     edge or centre, whichever gives the cleanest columns).
 *  3. Decide which column is which. Headings give a first guess; then every
 *     possible assignment is tried and scored by whether the printed running
 *     balance agrees. Only a reading the balance proves is called verified.
 *  4. Anything unverified goes to the user to confirm, with a live preview, and
 *     the confirmed layout can be remembered for that bank's next statement.
 */

export type MoneyRole = 'out' | 'in' | 'amount' | 'fee' | 'balance' | 'ignore';
const MONEY_ROLES: MoneyRole[] = ['out', 'in', 'amount', 'fee', 'balance'];
export type Anchor = 'right' | 'left' | 'centre';

export interface MoneyColumn {
  edge: number;
  label: string; // heading printed above it, '' when the table has none
  hint: MoneyRole | null; // what that heading suggests
  samples: string[];
  count: number;
}

/** A confirmed layout, kept on this device. It holds column positions only, never transactions. */
export interface PdfLayout {
  bank: string;
  anchor: Anchor;
  columns: Array<{ edge: number; role: MoneyRole }>;
  dateOrder: DateOrder;
  savedAt: number;
}

interface DateParts {
  y: number | null;
  m: number;
  d: number;
}

interface Line {
  page: number;
  dateText: string;
  text: string;
  money: Array<{ col: number; value: Pence }>;
  marker: 'bf' | 'cf' | 'total' | null;
}

export interface PdfAnalysis {
  bank: string;
  account: { sortCode?: string; number?: string };
  anchor: Anchor;
  columns: MoneyColumn[];
  dateOrder: DateOrder;
  /** Description first and amount on the last line ('last'), or amount on the first line ('first'). */
  style: 'first' | 'last';
  lines: Line[];
  outside: { opening?: Pence; closing?: Pence; years: number[] };
  fallbackYear: number;
  /** Best assignment found, and whether a saved layout supplied it. */
  roles: MoneyRole[];
  fromSaved: boolean;
  result: PdfReading;
}

export interface PdfReading {
  parsed: ParsedStatement;
  verified: boolean;
  /** Why it isn't verified, in plain words. */
  reason?: string;
}

// ---- tokens ----------------------------------------------------------------------------------

const MONEY_RE = /^[-+]?\(?-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)?(?:\s?(?:CR|DR|D|-))?$/i;
const normMoney = (s: string) => s.trim().replace(/[−–]/g, '-').replace(/£\s?|GBP\s?/gi, '');
const isMoney = (s: string) => MONEY_RE.test(normMoney(s));
const moneyValue = (s: string): Pence | null => parseMoney(normMoney(s));

/** Merge items that touch (no visible gap): pdf.js often splits "£" or "-" from the number. */
function mergeTouching(items: PdfItem[]): PdfItem[] {
  const out: PdfItem[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (prev && it.x - (prev.x + prev.w) <= 1.2 && it.x >= prev.x) {
      out[out.length - 1] = { str: prev.str + it.str, x: prev.x, y: prev.y, w: it.x + it.w - prev.x };
    } else out.push({ ...it });
  }
  return out;
}

const pos = (it: PdfItem, a: Anchor) => (a === 'right' ? it.x + it.w : a === 'left' ? it.x : it.x + it.w / 2);

// ---- dates -----------------------------------------------------------------------------------

const MONTH_WORDS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_LONG = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthOf = (w: string): number => {
  const s = w.toLowerCase().replace(/\.$/, '');
  const i = MONTH_WORDS.indexOf(s);
  if (i >= 0) return i + 1;
  if (s === 'sept') return 9;
  const j = MONTH_LONG.indexOf(s);
  return j >= 0 ? j + 1 : 0;
};

const D_ISO = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?![\w])/;
const D_NAMED = /^(\d{1,2})(?:st|nd|rd|th)?[\s/.-]*([A-Za-z]{3,9}\.?)(?:[\s/.,-]+(\d{4}|\d{2}))?(?![\w])/;
const D_MONTH_FIRST = /^([A-Za-z]{3,9}\.?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?![\w])/;
const D_NUM = /^(\d{1,2})([/.-])(\d{1,2})(?:\2(\d{4}|\d{2}))?(?![\w.])/;
const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

/** The date a row starts with, as printed. Returns the matched text so it can be removed from the description. */
function leadingDate(text: string): string | null {
  let m = D_ISO.exec(text);
  if (m) return m[0];
  m = D_NAMED.exec(text);
  if (m && monthOf(m[2]!)) return m[0];
  m = D_MONTH_FIRST.exec(text);
  if (m && monthOf(m[1]!)) return m[0];
  m = D_NUM.exec(text);
  if (m && (m[2] !== '.' || m[4])) return m[0];
  return null;
}

function dateParts(s: string, order: DateOrder): DateParts | null {
  let m = D_ISO.exec(s);
  if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  m = D_NAMED.exec(s);
  if (m && monthOf(m[2]!)) return { y: m[3] ? fullYear(m[3]) : null, m: monthOf(m[2]!), d: Number(m[1]) };
  m = D_MONTH_FIRST.exec(s);
  if (m && monthOf(m[1]!)) return { y: m[3] ? Number(m[3]) : null, m: monthOf(m[1]!), d: Number(m[2]) };
  m = D_NUM.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    const [d, mo] = order === 'mdy' ? [b, a] : [a, b];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { y: m[4] ? fullYear(m[4]) : null, m: mo, d };
  }
  return null;
}

// ---- headings & markers ----------------------------------------------------------------------

const HEAD: Array<[MoneyRole | 'date' | 'description', RegExp]> = [
  ['amount', /\bin ?\/ ?out\b|\bout ?\/ ?in\b|paid in ?\/ ?out/i], // one signed column
  ['balance', /balance/i],
  ['fee', /^(?:£ ?)?(?:fees?|charges?)$/i],
  ['out', /paid ?out|money ?out|payments? ?out|debits?\b|withdrawals?|outgoings?|spent|^out$/i],
  ['in', /paid ?in|money ?in|payments? ?in|credits?\b|deposits?|incomings?|received|^in$/i],
  ['amount', /amount|value/i],
  ['date', /date/i],
  ['description', /description|details|transaction|narrative|particulars|payee|reference/i],
];
const headRole = (s: string) => HEAD.find(([, re]) => re.test(s.replace(/£|\(|\)/g, '').trim()))?.[0] ?? null;

interface Phrase {
  str: string;
  x0: number;
  x1: number;
  role: ReturnType<typeof headRole>;
}
function phrases(items: PdfItem[]): Phrase[] {
  const out: Phrase[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (prev && it.x - prev.x1 < 3.5) {
      prev.str += ` ${it.str.trim()}`;
      prev.x1 = it.x + it.w;
    } else out.push({ str: it.str.trim(), x0: it.x, x1: it.x + it.w, role: null });
  }
  for (const p of out) p.role = headRole(p.str);
  return out;
}
const isHeader = (items: PdfItem[]) => {
  if (items.some((i) => isMoney(i.str))) return false;
  const roles = new Set(phrases(items).map((p) => p.role).filter(Boolean));
  return roles.size >= 2 && MONEY_ROLES.some((r) => roles.has(r));
};

const BF_RE = /brought forward|b\/f\b|opening balance|start(?:ing)? balance|previous balance|balance from previous/i;
const CF_RE = /carried forward|c\/f\b|closing balance|end(?:ing)? balance|balance to next/i;
const TOTAL_RE = /^(?:sub ?)?totals?\b/i;
const markerOf = (text: string): Line['marker'] => (BF_RE.test(text) ? 'bf' : CF_RE.test(text) ? 'cf' : TOTAL_RE.test(text) ? 'total' : null);

/** National banks and e-money firms only — never anything local or personal. */
const BANKS: Array<[string, string]> = [
  ['firstdirect', 'first direct'], ['hsbc', 'HSBC'], ['barclays', 'Barclays'], ['lloyds', 'Lloyds'], ['halifax', 'Halifax'],
  ['bankofscotland', 'Bank of Scotland'], ['natwest', 'NatWest'], ['royalbankofscotland', 'Royal Bank of Scotland'],
  ['ulsterbank', 'Ulster Bank'], ['santander', 'Santander'], ['nationwide', 'Nationwide'], ['monzo', 'Monzo'],
  ['starling', 'Starling'], ['tsb', 'TSB'], ['metrobank', 'Metro Bank'], ['co-operativebank', 'Co-operative Bank'],
  ['cooperativebank', 'Co-operative Bank'], ['virginmoney', 'Virgin Money'], ['chase', 'Chase'], ['revolut', 'Revolut'],
  ['wise', 'Wise'], ['kroo', 'Kroo'], ['zopa', 'Zopa'], ['tide', 'Tide'], ['danske', 'Danske Bank'], ['coventrybuilding', 'Coventry BS'],
  ['skiptonbuilding', 'Skipton BS'], ['yorkshirebuilding', 'Yorkshire BS'], ['clydesdale', 'Clydesdale Bank'], ['aib', 'AIB'],
];

/**
 * Put each heading over its column. Headings are often left-aligned while amounts are
 * right-aligned, so for right-aligned money a heading must start at or before the
 * column's edge and end near it. One heading names one column: the nearest wins.
 */
function labelColumns(columns: MoneyColumn[], ph: Phrase[], anchor: Anchor): void {
  const near = (c: MoneyColumn, p: Phrase): number => {
    if (anchor === 'right') return p.x0 > c.edge ? Infinity : Math.max(0, c.edge - p.x1 - 6);
    if (anchor === 'left') return Math.abs(p.x0 - c.edge);
    return Math.abs((p.x0 + p.x1) / 2 - c.edge);
  };
  const claim = new Map<Phrase, { col: MoneyColumn; d: number }>();
  for (const c of columns) {
    if (c.label) continue;
    let bestP: Phrase | null = null;
    let bd = 30;
    for (const p of ph) {
      const d = near(c, p);
      if (d <= bd) { bd = d; bestP = p; }
    }
    if (!bestP) continue;
    const prev = claim.get(bestP);
    if (!prev || bd < prev.d) claim.set(bestP, { col: c, d: bd });
  }
  for (const [p, { col }] of claim) {
    col.label = p.str;
    col.hint = p.role && MONEY_ROLES.includes(p.role as MoneyRole) ? (p.role as MoneyRole) : null;
  }
}

// ---- clustering ------------------------------------------------------------------------------

function cluster(values: number[], tol: number): Array<{ edge: number; n: number }> {
  const v = [...values].sort((a, b) => a - b);
  const out: number[][] = [];
  for (const x of v) {
    const last = out[out.length - 1];
    if (last && x - last[last.length - 1]! <= tol) last.push(x);
    else out.push([x]);
  }
  return out.map((c) => ({ edge: c[Math.floor(c.length / 2)]!, n: c.length }));
}

const median = (xs: number[], fallback: number) => {
  if (!xs.length) return fallback;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

// ---- analysis --------------------------------------------------------------------------------

interface TRow {
  page: number;
  y: number;
  items: PdfItem[];
  money: PdfItem[];
  text: string;
  date: string | null;
  header: boolean;
}

export function analysePdf(pages: PdfPage[], opts: { saved?: PdfLayout[]; year?: number } = {}): PdfAnalysis {
  const rows: TRow[][] = pages.map((page, pi) =>
    groupRows(page).map((r: Row) => {
      const items = mergeTouching(r.items);
      const money = items.filter((i) => isMoney(i.str));
      const text = joinItems(items.filter((i) => !money.includes(i)));
      return { page: pi, y: r.y, items, money, text, date: leadingDate(text), header: isHeader(items) };
    }),
  );

  // Typical line spacing inside tables.
  const gaps: number[] = [];
  for (const pr of rows) for (let i = 1; i < pr.length; i++) if (pr[i]!.money.length || pr[i]!.date) {
    const g = pr[i - 1]!.y - pr[i]!.y;
    if (g > 0 && g < 40) gaps.push(g);
  }
  const step = median(gaps, 12);

  // Table zones: from each heading (or each first dated row) down over tightly spaced rows.
  const inZone = rows.map((pr) => pr.map(() => false));
  const zoneHeader: Array<Array<TRow | null>> = rows.map((pr) => pr.map(() => null));
  rows.forEach((pr, p) => {
    let i = 0;
    while (i < pr.length) {
      const r = pr[i]!;
      let start = -1;
      let hdr: TRow | null = null;
      if (r.header) { start = i + 1; hdr = r; }
      else if (r.date && (r.money.length || (pr[i + 1]?.money.length && r.y - pr[i + 1]!.y <= step * 3))) {
        start = i;
        // Rows carried over from the previous page sit above the first date.
        while (start > 0 && !pr[start - 1]!.header && pr[start - 1]!.y - pr[start]!.y <= step * 1.8 && pr[start - 1]!.money.length) start--;
        if (start > 0 && pr[start - 1]!.header) hdr = pr[start - 1]!;
      }
      if (start < 0) { i++; continue; }
      let j = start;
      while (j < pr.length && !pr[j]!.header && (j === start || pr[j - 1]!.y - pr[j]!.y <= step * 3)) {
        inZone[p]![j] = true;
        zoneHeader[p]![j] = hdr;
        j++;
      }
      i = Math.max(j, i + 1);
    }
  });

  const zoneRows = rows.flatMap((pr, p) => pr.filter((_, i) => inZone[p]![i]).map((r) => ({ r, hdr: zoneHeader[p]![pr.indexOf(r)] ?? null })));
  const outsideRows = rows.flatMap((pr, p) => pr.filter((_, i) => !inZone[p]![i]));
  if (!zoneRows.some(({ r }) => r.date) || !zoneRows.some(({ r }) => r.money.length)) {
    throw new ImportError('No transaction table was found in this PDF. If it is a statement, download a CSV, OFX or QIF from online banking instead.');
  }

  // Money columns: whichever alignment gives the fewest clean columns.
  const tokens = zoneRows.flatMap(({ r }) => (markerOf(r.text) ? [] : r.money));
  let anchor: Anchor = 'right';
  let best: Array<{ edge: number; n: number }> = [];
  for (const a of ['right', 'left', 'centre'] as Anchor[]) {
    const cs = cluster(tokens.map((t) => pos(t, a)), 6);
    if (!best.length || cs.length < best.length) { best = cs; anchor = a; }
  }
  let columns: MoneyColumn[] = best.map((c) => ({ edge: Math.round(c.edge * 10) / 10, label: '', hint: null, samples: [], count: c.n }));
  for (const hdr of new Set(zoneRows.map(({ hdr }) => hdr).filter((h): h is TRow => !!h))) labelColumns(columns, phrases(hdr.items), anchor);
  // A column with a single amount is real (one salary payment) unless there are too many columns to make sense of;
  // then lone, unheaded amounts are treated as stray numbers in descriptions.
  if (columns.length > 6) columns = columns.filter((c) => c.count > 1 || c.label);
  const colOf = (it: PdfItem): number => {
    const x = pos(it, anchor);
    let ci = -1;
    let d = 12;
    columns.forEach((c, i) => { const dd = Math.abs(c.edge - x); if (dd <= d) { d = dd; ci = i; } });
    return ci;
  };
  for (const { r } of zoneRows) {
    if (markerOf(r.text)) continue;
    for (const t of r.money) {
      const c = columns[colOf(t)];
      if (c && c.samples.length < 3) c.samples.push(t.str.trim());
    }
  }

  const lines: Line[] = zoneRows.map(({ r }) => {
    const dateText = r.date ?? '';
    let text = r.date ? r.text.slice(r.date.length).trim() : r.text;
    const second = leadingDate(text); // a value date printed next to the posting date
    if (second && r.date) text = text.slice(second.length).trim();
    return {
      page: r.page, dateText, text,
      money: r.money.map((t) => ({ col: colOf(t), value: moneyValue(t.str) })).filter((m): m is { col: number; value: Pence } => m.col >= 0 && m.value !== null),
      marker: markerOf(r.text),
    };
  });

  // Facts printed outside the table: bank, account, opening/closing, years.
  const outside: PdfAnalysis['outside'] = { years: [] };
  let bank = '';
  let sortCode: string | undefined;
  let number: string | undefined;
  outsideRows.forEach((r, i) => {
    const flat = r.text.toLowerCase().replace(/\s+/g, '');
    if (!bank && r.page < 2) bank = BANKS.find(([k]) => flat.includes(k))?.[1] ?? '';
    if (!sortCode) sortCode = /\b(\d{2}-\d{2}-\d{2})\b/.exec(r.text)?.[1];
    if (!number && /account/i.test(r.text)) number = /\b(\d{8})\b/.exec(r.text)?.[1] ?? /\b(\d{8})\b/.exec(outsideRows[i + 1]?.text ?? '')?.[1];
    const mk = markerOf(r.text);
    const v = r.money.length ? moneyValue(r.money[r.money.length - 1]!.str) : null;
    if (v !== null && mk === 'bf' && outside.opening === undefined) outside.opening = v;
    if (v !== null && mk === 'cf' && outside.closing === undefined) outside.closing = v;
  });
  for (const pr of rows) for (const r of pr) for (const m of r.text.matchAll(/\b(20\d{2})\b/g)) outside.years.push(Number(m[1]));

  const dateOrder = detectDateOrder(lines.filter((l) => l.dateText).map((l) => l.dateText));
  const dated = lines.filter((l) => l.dateText && !l.marker);
  const style = dated.length && dated.filter((l) => l.money.length).length / dated.length >= 0.6 ? 'first' : 'last';

  const base: Omit<PdfAnalysis, 'roles' | 'fromSaved' | 'result'> = {
    bank, account: { sortCode, number }, anchor, columns, dateOrder, style, lines, outside, fallbackYear: opts.year ?? new Date().getFullYear(),
  };

  // Choose roles: saved layout, headings, and every valid assignment, scored by the balance.
  const saved = (opts.saved ?? []).find((l) => matchesLayout(l, base));
  const headerGuess = columns.map((c) => c.hint ?? 'ignore');
  const candidates: MoneyRole[][] = [];
  if (saved) candidates.push(columns.map((c) => saved.columns.find((s) => Math.abs(s.edge - c.edge) <= 6)?.role ?? 'ignore'));
  candidates.push(headerGuess);
  // Columns that only ever print 0.00 (tax withheld, fees on a fee-free account) carry no information.
  const live = columns.map((_, i) => lines.some((l) => l.money.some((m) => m.col === i && m.value !== 0)));
  const liveIdx = live.flatMap((on, i) => (on ? [i] : []));
  const signed = columns.map((_, i) => lines.some((l) => !l.marker && l.money.some((m) => m.col === i && m.value < 0)));
  if (liveIdx.length <= 6) {
    for (const combo of assignments(liveIdx.length)) {
      const roles: MoneyRole[] = columns.map(() => 'ignore');
      liveIdx.forEach((ci, k) => { roles[ci] = combo[k]!; });
      candidates.push(roles);
    }
  }

  let top: { roles: MoneyRole[]; score: number; sig: string } | null = null;
  let tie = false;
  // A layout the user confirmed wins unless the printed balance contradicts it.
  const savedOk = saved && validRoles(candidates[0]!) && readWith({ ...base, dateOrder: saved.dateOrder }, candidates[0]!, saved.dateOrder, true).stats.wrong === 0;
  if (savedOk) candidates.splice(1);
  for (const roles of candidates) {
    if (!validRoles(roles)) continue;
    const sc = score({ ...base, dateOrder: saved?.dateOrder ?? dateOrder }, roles, headerGuess, signed);
    if (!top || sc.score > top.score) { top = { roles, score: sc.score, sig: sc.sig }; tie = false; }
    else if (sc.score === top.score && sc.sig !== top.sig) tie = true;
  }
  const roles = top?.roles ?? headerGuess;
  const order = saved?.dateOrder ?? dateOrder;
  const result = readWith({ ...base, dateOrder: order }, roles, order);
  if (tie && result.verified) {
    result.verified = false;
    result.reason = 'More than one reading of the columns adds up. Please confirm which is which.';
  }
  return { ...base, dateOrder: order, roles, fromSaved: !!saved && roles === candidates[0], result };
}

function validRoles(r: MoneyRole[]): boolean {
  const n = (x: MoneyRole) => r.filter((v) => v === x).length;
  if (n('out') > 1 || n('in') > 1 || n('amount') > 1 || n('balance') > 1 || n('fee') > 1) return false;
  if (n('amount') && (n('out') || n('in'))) return false;
  return n('amount') + n('out') + n('in') > 0;
}

function assignments(k: number): MoneyRole[][] {
  const all: MoneyRole[] = [...MONEY_ROLES, 'ignore'];
  let acc: MoneyRole[][] = [[]];
  for (let i = 0; i < k; i++) acc = acc.flatMap((a) => all.map((r) => [...a, r]));
  return acc.filter((r) => r.length === 0 || validRoles(r));
}

function score(a: Omit<PdfAnalysis, 'roles' | 'fromSaved' | 'result'>, roles: MoneyRole[], hints: MoneyRole[], signed: boolean[]) {
  const r = readWith(a, roles, a.dateOrder, true);
  const s = r.stats;
  let sc = s.confirmed * 2 - s.wrong * 4 - s.flipped;
  if (s.closingOk === true) sc += 3;
  if (s.closingOk === false) sc -= 3;
  roles.forEach((role, i) => {
    if (hints[i] !== 'ignore') sc += role === hints[i] ? 1 : -1;
    if (role === 'ignore') sc -= 0.25;
    // A column that prints minus signs is a signed amount, not a one-direction column.
    if (signed[i] && (role === 'out' || role === 'in' || role === 'fee')) sc -= 2;
  });
  if (!r.parsed.txns.length) sc = -Infinity;
  return { score: sc, sig: r.parsed.txns.map((t) => t.amount).join(',') };
}

/** Rebuild the statement with a given column assignment. Pure, cheap enough to run on every change. */
export function readPdfWith(a: PdfAnalysis, roles: MoneyRole[], dateOrder: DateOrder): PdfReading {
  const r = readWith(a, roles, dateOrder);
  return { parsed: r.parsed, verified: r.verified, reason: r.reason };
}

interface Stats { confirmed: number; wrong: number; flipped: number; closingOk: boolean | null; hasBalance: boolean }

function readWith(a: Omit<PdfAnalysis, 'roles' | 'fromSaved' | 'result'>, roles: MoneyRole[], order: DateOrder, light = false): PdfReading & { stats: Stats } {
  const role = (col: number): MoneyRole => roles[col] ?? 'ignore';
  const unsigned = roles.includes('amount') && !a.lines.some((l) => l.money.some((m) => role(m.col) === 'amount' && m.value < 0));

  interface Draft { parts: DateParts | null; lines: string[]; amount: Pence; balance?: Pence; type: string }
  const drafts: Draft[] = [];
  let curDate: DateParts | null = null;
  let pending: string[] = [];
  let last: Draft | null = null;
  let opening: Pence | undefined;
  let closing: Pence | undefined;
  let page = -1;

  for (const l of a.lines) {
    if (l.page !== page) { page = l.page; pending = []; }
    if (l.dateText) curDate = dateParts(l.dateText, order) ?? curDate;
    const bal = l.money.find((m) => role(m.col) === 'balance')?.value;
    if (l.marker) {
      const v = bal ?? l.money[l.money.length - 1]?.value;
      if (l.marker === 'bf' && opening === undefined && !drafts.length && v !== undefined) opening = v;
      if (l.marker === 'cf' && v !== undefined) closing = v;
      pending = [];
      continue;
    }
    let amt: Pence | null = null;
    let fee = 0;
    for (const m of l.money) {
      const r = role(m.col);
      if (r === 'out') amt = (amt ?? 0) - Math.abs(m.value);
      else if (r === 'in') amt = (amt ?? 0) + Math.abs(m.value);
      else if (r === 'amount') amt = (amt ?? 0) + m.value;
      else if (r === 'fee') fee += Math.abs(m.value);
    }
    if (amt === null) fee = 0; // a fee always sits beside the payment it belongs to
    if (amt !== null) {
      const d: Draft = { parts: curDate, lines: light ? [] : [...pending, ...(l.text ? [l.text] : [])], amount: amt ?? 0, type: '' };
      drafts.push(d);
      last = d;
      // A fee is its own transaction, after the payment it belongs to; the printed balance comes after both.
      if (fee) {
        last = { parts: curDate, lines: light ? [] : ['Bank fee'], amount: -fee, type: 'FEE' };
        drafts.push(last);
      }
      if (bal !== undefined) last.balance = bal;
      pending = [];
    } else if (bal !== undefined) {
      if (last && last.balance === undefined) last.balance = bal;
      else if (!drafts.length && opening === undefined) opening = bal;
    } else if (l.text && !light) {
      if (a.style === 'first' && last && !l.dateText) last.lines.push(l.text);
      else pending.push(l.text);
    }
  }

  // Years: printed, or carried from the statement period across a December → January turn.
  const seq = drafts.filter((d) => d.parts).map((d) => d.parts!);
  let up = 0;
  let down = 0;
  for (let i = 1; i < seq.length; i++) {
    const p = seq[i - 1]!.m * 32 + seq[i - 1]!.d;
    const c = seq[i]!.m * 32 + seq[i]!.d;
    if (c > p) up++;
    else if (c < p) down++;
  }
  const descending = down > up;
  const years = a.outside.years.filter((y) => y > 1990 && y < 2100);
  let year = seq.find((p) => p.y !== null)?.y ?? (years.length ? (descending ? Math.max(...years) : Math.min(...years)) : null);
  const warnings: string[] = [];
  if (year === null) {
    year = a.fallbackYear;
    if (!light) warnings.push(`No year is printed on this statement, so ${year} was assumed. Check the dates.`);
  }
  let prevM = 0;
  const txns: RawTxn[] = [];
  let skipped = 0;
  for (const d of drafts) {
    if (!d.parts) { skipped++; continue; }
    if (d.parts.y !== null) year = d.parts.y;
    else if (prevM) {
      if (!descending && d.parts.m < prevM && prevM - d.parts.m > 6) year++;
      if (descending && d.parts.m > prevM && d.parts.m - prevM > 6) year--;
    }
    prevM = d.parts.m;
    const t: RawTxn = { date: makeDate(year, d.parts.m, d.parts.d), amount: d.amount, type: d.type, lines: d.lines.length || light ? d.lines : ['(no description)'] };
    if (d.balance !== undefined) t.balance = d.balance;
    if (t.amount !== 0) txns.push(t);
  }
  if (descending) txns.reverse();

  // Reconcile against the printed balance.
  const stats: Stats = { confirmed: 0, wrong: 0, flipped: 0, closingOk: null, hasBalance: roles.includes('balance') };
  if (opening === undefined) opening = a.outside.opening;
  if (closing === undefined) closing = a.outside.closing;
  let start = opening;
  // With no printed opening balance, the first row's balance sets the start; that row then proves nothing.
  const inferred = start === undefined && txns[0]?.balance !== undefined;
  if (inferred) start = txns[0]!.balance! - txns[0]!.amount;
  if (start !== undefined) {
    let run = start;
    let since = 0;
    for (const [i, t] of txns.entries()) {
      if (inferred && i === 0) { run = t.balance!; continue; }
      if (unsigned && t.balance !== undefined && since === 0 && Math.abs(t.balance - run) === Math.abs(t.amount) && t.balance - run !== t.amount) {
        t.amount = t.balance - run; // the column has no signs; the balance says which way it went
      } else if (!unsigned && t.balance !== undefined && since === 0 && t.balance - run === -t.amount && t.amount !== 0) {
        stats.flipped++;
      }
      run += t.amount;
      since++;
      if (t.balance !== undefined) {
        if (t.balance === run) stats.confirmed++;
        else { stats.wrong++; run = t.balance; }
        since = 0;
      }
    }
    if (closing !== undefined && stats.hasBalance) stats.closingOk = run === closing;
  }

  const checks: Check[] = [];
  let reason: string | undefined;
  if (!stats.hasBalance) {
    reason = 'This statement has no balance column that Tally could find, so the reading cannot be proved.';
    checks.push({ name: 'No balance to check against', ok: false, detail: 'Compare the preview with your statement before importing.' });
  } else {
    const runOk = stats.wrong === 0 && stats.confirmed > 0;
    checks.push({
      name: runOk ? 'Running balance agrees' : 'Running balance does not agree',
      ok: runOk,
      detail: stats.wrong === 0
        ? `${stats.confirmed} printed balance${stats.confirmed === 1 ? '' : 's'} confirmed.`
        : `${stats.wrong} printed balance${stats.wrong === 1 ? '' : 's'} did not match the running total.`,
    });
    if (stats.closingOk !== null) {
      checks.push({
        name: stats.closingOk ? 'Closing balance agrees' : 'Closing balance does not agree',
        ok: stats.closingOk,
        detail: stats.closingOk ? `Ends at ${fmt(closing!)}.` : `The statement says ${fmt(closing!)}.`,
      });
    }
    if (stats.wrong) reason = 'Some printed balances do not match. A column may be the wrong way round.';
    else if (!stats.confirmed) reason = 'No printed balance could be matched.';
    else if (stats.closingOk === false) reason = 'The closing balance does not match.';
  }
  if (skipped) warnings.push(`${skipped} row(s) had no date and were skipped.`);

  const dates = txns.map((t) => t.date).sort();
  const parsed: ParsedStatement = {
    bank: a.bank || 'PDF statement',
    format: 'pdf-generic',
    account: { sortCode: a.account.sortCode, number: a.account.number, label: a.account.number ? undefined : a.bank || undefined },
    periodStart: dates[0],
    periodEnd: dates[dates.length - 1],
    opening,
    closing,
    txns,
    checks,
    warnings,
  };
  const verified = !reason && txns.length > 0 && (stats.confirmed >= 2 || (stats.confirmed >= 1 && txns.length <= 2)) && !skipped;
  if (!reason && !verified) reason = skipped ? 'Some rows had no date.' : 'Too few printed balances to be sure.';
  return { parsed, verified, reason: verified ? undefined : reason, stats };
}

// ---- remembered layouts ----------------------------------------------------------------------

interface LayoutBase { bank: string; anchor: Anchor; columns: Array<{ edge: number }> }

/** Same bank, same alignment, same money columns (within a few points). */
export function matchesLayout(l: PdfLayout, a: LayoutBase): boolean {
  return l.bank === a.bank && l.anchor === a.anchor && l.columns.length === a.columns.length
    && l.columns.every((c, i) => Math.abs(c.edge - a.columns[i]!.edge) <= 6);
}

export function layoutFrom(a: LayoutBase, roles: MoneyRole[], dateOrder: DateOrder, now: number): PdfLayout {
  return { bank: a.bank, anchor: a.anchor, columns: a.columns.map((c, i) => ({ edge: c.edge, role: roles[i] ?? 'ignore' })), dateOrder, savedAt: now };
}

export const ROLE_LABEL: Record<MoneyRole, string> = {
  out: 'Money out', in: 'Money in', amount: 'Amount (+/−)', fee: 'Fee (taken off)', balance: 'Balance', ignore: 'Ignore',
};
