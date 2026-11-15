import { makeDate } from '../../lib/dates';
import { fmt, parseMoney } from '../../lib/money';
import type { Pence } from '../../lib/money';
import { region } from '../../lib/region';
import { bankFrom } from './banks';
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
 *
 * Layouts seen in Nigerian statements (docs/07-regions.md) added: times after dates, dates split over two
 * lines, descriptions printed above and below the amount, "label over value" summary boxes, printed totals
 * and counts, rows from the same minute printed out of order, a wrong printed opening balance, and two
 * accounts (wallet and savings) in one PDF.
 */

export type MoneyRole = 'out' | 'in' | 'amount' | 'fee' | 'balance' | 'ignore';
const MONEY_ROLES: MoneyRole[] = ['out', 'in', 'amount', 'fee', 'balance'];
export type Anchor = 'right' | 'left' | 'centre';
export type Currency = 'GBP' | 'NGN' | 'USD' | 'EUR';

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
  y: number;
  dateText: string;
  /** Description lines, top to bottom. Usually one; several when a block of rows was merged. */
  texts: string[];
  money: Array<{ col: number; value: Pence }>;
  marker: 'bf' | 'cf' | 'total' | null;
  time?: string;
  ref?: string;
  /** Payment-type code from a "Type" column, in the codes the categoriser knows. */
  type?: string;
}

/**
 * UK banks' payment-type codes, as printed in a "Type" column (Lloyds, Halifax, Bank of Scotland, TSB), mapped to
 * the codes the categoriser already understands from HSBC. Unknown codes pass through unchanged.
 */
const TYPE_CODES: Record<string, string> = {
  DEB: 'VIS', POS: 'VIS', CPT: 'ATM', FPI: 'CR', BGC: 'CR', MPI: 'CR', DEP: 'CR', FPO: 'BP', MPO: 'BP', PAY: 'BP',
  CHG: 'FEE', FEE: 'FEE', DD: 'DD', SO: 'SO', BP: 'BP', TFR: 'TFR',
};
/** A Type or Category column that names the kind of payment in words (Revolut: "Merchant", "Top up"). */
const TYPE_WORDS: Record<string, string> = { MERCHANT: 'VIS', 'CARD PAYMENT': 'VIS', 'CARD PURCHASE': 'VIS', 'TOP UP': 'CR', 'TOP-UP': 'CR', 'DIRECT DEBIT': 'DD', 'STANDING ORDER': 'SO' };
const typeCode = (s: string): string | undefined => {
  const c = s.replace(/\s+/g, ' ').trim().toUpperCase();
  return TYPE_WORDS[c] ?? (/^[A-Z)]{1,4}$/.test(c) ? TYPE_CODES[c] ?? c : undefined);
};

/**
 * Payment codes some banks print at the start of each description instead of in a column of their own (HSBC:
 * "))) SHOP", "BP NAME", "CR NAME"). Only taken when most of the statement's descriptions start with one.
 */
const LEADING_CODES = new Set([')))', 'VIS', 'TFR', 'BP', 'CR', 'DR', 'DD', 'SO', 'ATM', 'CHQ', 'OBP', 'PAY', 'DEB', 'FPI', 'FPO', 'BGC', 'DEP', 'CPT', 'CHG', 'FEE', 'MPI', 'MPO', 'POS', 'PIM', 'DDR', 'VRP']);
const leadingCode = (s: string): [string, string] | null => {
  const m = /^(\){3}|[A-Z]{2,3})\s+(\S.*)$/.exec(s);
  return m && LEADING_CODES.has(m[1]!) ? [m[1]!, m[2]!] : null;
};

/** Marks a description line that is the wrapped tail of the line above it (see `joinWrapped`). */
const WRAP = '\u0001';
const joinWrapped = (lines: string[]): string[] => {
  const out: string[] = [];
  for (const s of lines) {
    if (s.startsWith(WRAP) && out.length) out[out.length - 1] += ` ${s.slice(1)}`;
    else out.push(s.replace(WRAP, ''));
  }
  return out;
};

/**
 * The kind of payment, from the statement's own codes or wording, for rows that have no Type column: leading codes
 * (when most rows have one), "Transfer to / To NAME" out, "Payment from / Transfer from / From NAME" in, and money
 * moved to or from the account's own savings ("To GBP Savings").
 */
function readWording(txns: RawTxn[]): void {
  const coded = txns.filter((t) => t.lines[0] && leadingCode(t.lines[0])).length;
  const useCodes = txns.length >= 3 && coded >= txns.length * 0.5;
  for (const t of txns) {
    if (useCodes && !t.type) {
      const c = t.lines[0] ? leadingCode(t.lines[0]) : null;
      if (c) { t.type = TYPE_CODES[c[0]] ?? c[0]; t.lines = [c[1], ...t.lines.slice(1)]; }
    }
    // Nigerian narrations ("Transfer to NAME | Bank | account", "Transfer to POS Transfer - NAME") carry more than a
    // name; the Nigerian narration reader handles those whole (categorize/narration.ts).
    if (region().id === 'ng') continue;
    if (t.type && t.type !== 'CR' && t.type !== 'BP') continue;
    const first = t.lines[0] ?? '';
    if (/^(?:transfer )?(?:to|from) (?:[A-Z]{3} )?(?:savings|pot)$/i.test(first)) { t.type = 'POT'; t.lines = ['Savings pot', ...t.lines]; continue; }
    const to = /^(?:transfer to|to)\s+(\S.*)$/i.exec(first);
    if (to && t.amount < 0 && t.type !== 'CR') { t.type = 'BP'; t.lines = [to[1]!, ...t.lines.slice(1)]; continue; }
    const from = /^(?:transfer from|payment from|from)\s+(\S.*)$/i.exec(first);
    if (from && t.amount > 0 && t.type !== 'BP') { t.type = 'CR'; t.lines = [from[1]!, ...t.lines.slice(1)]; }
  }
}

/** Facts a statement prints outside its table, in "label: value" or "label over value" form. */
export interface Facts {
  opening?: Pence;
  closing?: Pence;
  totalIn?: Pence;
  totalOut?: Pence;
  countIn?: number;
  countOut?: number;
  holder?: string;
  number?: string;
  /** The account's own name when the statement prints one ("Pot name: Holiday"). */
  name?: string;
}

export interface PdfAnalysis {
  bank: string;
  account: { sortCode?: string; number?: string; holder?: string; label?: string };
  /** Currency the statement's own text uses, when it shows one. */
  currency?: Currency;
  anchor: Anchor;
  columns: MoneyColumn[];
  dateOrder: DateOrder;
  /** Description first and amount on the last line ('last'), or amount on the first line ('first'). */
  style: 'first' | 'last';
  /** True when each transaction was a block of rows (description above and below the amount). */
  blocks: boolean;
  /** True when this is one of several accounts printed in the same PDF. */
  multi: boolean;
  lines: Line[];
  outside: { opening?: Pence; closing?: Pence; years: number[] } & Facts;
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
// "+ $182.00" (GO2bank) has a space between the sign and the number once the currency sign is gone.
const normMoney = (s: string) => s.trim().replace(/[−–]/g, '-').replace(/[£₦$€]\s?|(?:GBP|NGN|USD|EUR)\s?/gi, '').replace(/^([+-])\s+/, '$1');
const isMoney = (s: string) => MONEY_RE.test(normMoney(s));
const moneyValue = (s: string): Pence | null => parseMoney(normMoney(s));
/** "--" or "—" printed in an empty money cell. */
const isBlank = (s: string) => /^[-–—]{1,3}$/.test(s.trim());

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

/**
 * An amount and the date in the next cell printed as one piece of text ("6.18 01/10/2026", Zenith's credit
 * column running into its value date). Split it back into two cells, placing each by its share of the width.
 */
function splitGlued(items: PdfItem[]): PdfItem[] {
  return items.flatMap((it) => {
    const m = /^(\S+)(\s+)(\S+)$/.exec(it.str.trim());
    if (!m) return [it];
    const [, a, gap, b] = m as unknown as [string, string, string, string];
    const isDate = (s: string) => leadingDate(s) === s;
    if (!((isMoney(a) && isDate(b)) || (isDate(a) && isMoney(b)))) return [it];
    const cw = it.w / it.str.trim().length;
    return [
      { ...it, str: a, w: a.length * cw },
      { ...it, str: b, x: it.x + (a.length + gap.length) * cw, w: b.length * cw },
    ];
  });
}

const pos = (it: PdfItem, a: Anchor) => (a === 'right' ? it.x + it.w : a === 'left' ? it.x : it.x + it.w / 2);

/** Which currency the statement is written in, from the signs and codes it prints. */
function currencyOf(pages: PdfPage[]): Currency | undefined {
  const n: Record<Currency, number> = { GBP: 0, NGN: 0, USD: 0, EUR: 0 };
  for (const p of pages) for (const it of p) {
    const s = it.str;
    n.NGN += (s.match(/₦|\bNGN\b/g) ?? []).length;
    n.GBP += (s.match(/£|\bGBP\b/g) ?? []).length;
    n.USD += (s.match(/\$|\bUSD\b/g) ?? []).length;
    n.EUR += (s.match(/€|\bEUR\b/g) ?? []).length;
  }
  const best = (Object.keys(n) as Currency[]).sort((a, b) => n[b] - n[a])[0]!;
  return n[best] > 0 ? best : undefined;
}

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
const TIME = /^(\d{1,2}):(\d{2})(?::\d{2})?(?:\s?([AaPp])\.?[Mm]\.?)?(?![\w:])/;
const YEAR_ONLY = /^(?:19|20)\d{2}$/;
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

/** "11:04:01" or "2:05 PM" at the start of the text, as 24-hour "HH:MM". */
function leadingTime(text: string): { time: string; len: number } | null {
  const m = TIME.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const ap = m[3]?.toLowerCase();
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h > 23 || Number(m[2]) > 59) return null;
  return { time: `${String(h).padStart(2, '0')}:${m[2]}`, len: m[0].length };
}

// ---- headings & markers ----------------------------------------------------------------------

type HeadRole = MoneyRole | 'date' | 'description' | 'ref' | 'type';
const HEAD: Array<[HeadRole, RegExp]> = [
  ['amount', /\bin ?\/ ?out\b|\bout ?\/ ?in\b|paid in ?\/ ?out/i], // one signed column
  ['balance', /balance/i],
  ['fee', /^(?:fees?|charges?)$/i],
  ['out', /paid ?out|money ?out|payments? ?out|debits?\b|withdrawals?|outgoings?|spent|^out$/i],
  ['in', /paid ?in|money ?in|payments? ?in|credits?\b|deposits?|incomings?|received|^in$/i],
  ['amount', /amount|value$/i],
  ['date', /date/i],
  ['ref', /^(?:transaction |trans\.? )?(?:reference|ref\.?)(?: ?(?:no\.?|number))?$|^(?:transaction|session) id$/i],
  ['type', /^(?:transaction |payment |trans\.? )?type$|^category$/i],
  ['description', /description|details|transaction|narrative|narration|remarks?|particulars|payee|reference/i],
];
const headRole = (s: string): HeadRole | null => HEAD.find(([, re]) => re.test(s.replace(/[£₦$€]|\(|\)/g, '').replace(/\s+/g, ' ').trim()))?.[0] ?? null;

interface Phrase {
  str: string;
  x0: number;
  x1: number;
  role: HeadRole | null;
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
  return roles.size >= 2 && MONEY_ROLES.some((r) => roles.has(r as MoneyRole));
};

const BF_RE = /brought forward|b\/f\b|opening balance|start(?:ing)? balance|beginning balance|previous balance|balance from previous/i;
const CF_RE = /carried forward|c\/f\b|closing balance|end(?:ing)? balance|balance to next/i;
// "Total", "Sub total", and Zenith-style day footers such as "2 Debit(s) 1 Credit(s)".
// Also page-turn notes ("(Continued on next page)"), which are not part of any description.
const TOTAL_RE = /^(?:sub ?)?totals?\b|^\d+\s*debits?(?:\(s\))?\s+\d+\s*credits?(?:\(s\))?|^\(?continued (?:on|over)\b/i;
const markerOf = (text: string): Line['marker'] => (BF_RE.test(text) ? 'bf' : CF_RE.test(text) ? 'cf' : TOTAL_RE.test(text) ? 'total' : null);

// ---- summary boxes ---------------------------------------------------------------------------

type FactKey = keyof Facts;
const FACT_LABELS: Array<[FactKey, RegExp]> = [
  ['opening', /^(?:opening|start(?:ing)?|beginning|previous) balance$|^balance (?:b\/f|brought forward)$/i],
  ['closing', /^(?:closing|end(?:ing)?) balance$|^balance (?:c\/f|carried forward)$/i],
  ['totalOut', /^total (?:debits?|withdrawals?|money out|paid out|payments out|outflows?|outgoings?)$/i],
  ['totalIn', /^total (?:credits?|deposits?|lodgements?|money in|paid in|payments in|inflows?|incomings?)$/i],
  ['countOut', /^(?:debit|withdrawal)s? count$|^(?:no\.?|number) of (?:debits|withdrawals)$/i],
  ['countIn', /^(?:credit|deposit)s? count$|^(?:no\.?|number) of (?:credits|deposits|lodgements)$/i],
  ['holder', /^(?:account name|account holder|customer name)$/i],
  ['number', /^(?:account (?:number|no\.?)|nuban)$/i],
  ['name', /^(?:pot|space|vault|pocket|jar|goal|savings?) name$/i],
];
/** Labels that belong in a summary box even when Tally doesn't use their value. */
const SUMMARY_WORDS = /^(?:current|available|effective available|cleared|uncleared|ledger|book) balance$|^(?:date printed|print date|statement date|start date|end date|period|account type|currency|sort ?code|branch|address|bvn)$/i;

const factKey = (s: string): FactKey | null => {
  const t = s.replace(/[£₦$€:]|\(|\)/g, '').replace(/\s+/g, ' ').trim();
  return FACT_LABELS.find(([, re]) => re.test(t))?.[0] ?? null;
};
const isSummaryLabel = (s: string) => !!factKey(s) || SUMMARY_WORDS.test(s.replace(/[:()]/g, '').replace(/\s+/g, ' ').trim());

/** Put each heading over its column (see docs/06). */
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
const quantile = (xs: number[], q: number, fallback: number) => {
  if (!xs.length) return fallback;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
};

// ---- analysis --------------------------------------------------------------------------------

interface TRow {
  page: number;
  y: number;
  items: PdfItem[];
  money: PdfItem[];
  text: string;
  date: string | null;
  /** How many characters of `text` the date takes (the date may have gained a year from the line below). */
  dateLen: number;
  header: boolean;
  /** Part of a summary box (labels or their values), never part of the table. */
  summary: boolean;
  /** Facts read from this row's labels (with values on this row or the row below). */
  facts: Facts;
}

/** Text columns named by the table heading: where descriptions and references sit. */
interface TextSpans { desc?: [number, number]; ref?: [number, number]; type?: [number, number] }
function textSpans(hdr: TRow | null, rows: TRow[] = []): TextSpans {
  if (!hdr) return {};
  const ph = phrases(hdr.items);
  const span = (p: Phrase): [number, number] => {
    const next = ph.filter((q) => q.x0 > p.x1).map((q) => q.x0);
    // A heading can be centred over its column (Zenith), so the column starts where its text does: the leftmost
    // place where text under the heading begins, if that happens on at least two rows.
    const starts = new Map<number, number>();
    for (const r of rows) {
      for (const it of r.items) {
        if (r.money.includes(it) || leadingDate(it.str) || it.x > p.x0 + 8 || it.x + it.w < p.x0) continue;
        const k = Math.round(it.x);
        starts.set(k, (starts.get(k) ?? 0) + 1);
      }
    }
    const left = Math.min(p.x0 - 8, ...[...starts].filter(([, n]) => n >= 2).map(([x]) => x - 4));
    return [left, next.length ? Math.min(...next) - 2 : Infinity];
  };
  const desc = ph.find((p) => p.role === 'description');
  const ref = ph.find((p) => p.role === 'ref');
  const type = ph.find((p) => p.role === 'type');
  if (!desc) return ref ? { desc: span(ref), type: type ? span(type) : undefined } : {};
  return { desc: span(desc), ref: ref ? span(ref) : undefined, type: type ? span(type) : undefined };
}

/** A statement's own title line ("Pot statement"), normalised, or null. */
function statementTitle(r: TRow): string | null {
  const ph = phrases(r.items);
  if (!ph.length || ph.length > 2) return null;
  const s = ph[0]!.str.replace(/\s+/g, ' ').trim();
  return /\bstatement\b/i.test(s) && s.length <= 40 && !/\d/.test(s) ? s.toLowerCase() : null;
}

/** Exported for tests and debugging only. */
export function buildRows(pages: PdfPage[]): TRow[][] {
  const rows: TRow[][] = pages.map((page, pi) => {
    // Accessibility-tagged PDFs (Lloyds) add invisible text in a microscopic font: column names on every row, "blank."
    // in empty cells, a "." after every value. Real text is a few points wide per character; drop anything far
    // narrower, unless the page has hardly any widths at all (then the widths can't be trusted).
    const visible = page.filter((i) => i.w / Math.max(1, i.str.length) > 0.5);
    const items = visible.length >= Math.min(10, page.length / 2) ? visible : page;
    return groupRows(items).map((r: Row) => makeRow(pi, r.y, splitGlued(mergeTouching(r.items)).filter((i) => !isBlank(i.str))));
  });
  // Dates split over two lines ("03-Aug-" above "2026"): give the date its year and drop the year line's copy.
  for (const pr of rows) {
    pr.forEach((r, i) => {
      if (!r.date || dateParts(r.date, 'dmy')?.y !== null) return;
      const dx = r.items.find((it) => !r.money.includes(it))?.x ?? 0;
      for (let j = i + 1; j < pr.length && r.y - pr[j]!.y <= 24; j++) {
        const yr = pr[j]!.items.find((it) => YEAR_ONLY.test(it.str.trim()) && Math.abs(it.x - dx) <= 6);
        if (!yr) continue;
        r.date = `${r.date.replace(/[\s,/.-]+$/, '')} ${yr.str.trim()}`;
        pr[j] = makeRow(pr[j]!.page, pr[j]!.y, pr[j]!.items.filter((it) => it !== yr));
        break;
      }
    });
  }
  return rows;
}

function makeRow(page: number, y: number, items: PdfItem[]): TRow {
  const money = items.filter((i) => isMoney(i.str));
  const text = joinItems(items.filter((i) => !money.includes(i)));
  let date = leadingDate(text);
  // "01/10/2026 - 15/11/2026" is the statement period, not a transaction.
  if (date) {
    const rest = /^\s*(?:-|–|to|until)\s*(.*)$/i.exec(text.slice(date.length));
    if (rest && leadingDate(rest[1]!)) date = null;
  }
  return { page, y, items, money, text, date, dateLen: date?.length ?? 0, header: isHeader(items), summary: false, facts: {} };
}

/**
 * Summary boxes: "Opening Balance  Total Debit  Debit Count" with the values on the row below, lined up under
 * each label, or "Opening balance £10.00" on one row. Rows that form such a box are kept out of the table.
 */
function readSummaries(rows: TRow[][]): void {
  for (const pr of rows) {
    pr.forEach((r, i) => {
      const labels = phrases(r.items.filter((it) => !r.money.includes(it)));
      const summaryish = labels.filter((p) => isSummaryLabel(p.str));
      if (!summaryish.length) return;
      const below = pr[i + 1] && r.y - pr[i + 1]!.y <= 30 && !pr[i + 1]!.header ? pr[i + 1]! : null;
      let aligned = 0;
      for (const p of labels) {
        const key = factKey(p.str);
        if (!key) continue;
        // Value on the row below, starting under the label, or (Monzo: "£1,034.09" over "Total outgoings") on a row
        // just above, lined up with it. When both exist, the nearer one belongs to this label.
        const near: Array<{ it: PdfItem; dy: number }> = [];
        for (const it of below?.items ?? []) {
          if ((Math.abs(it.x - p.x0) <= 8 || (it.x >= p.x0 - 2 && it.x < p.x1)) && !isSummaryLabel(it.str)) near.push({ it, dy: r.y - below!.y });
        }
        for (let j = i - 1; j >= 0 && pr[j]!.y - r.y <= 22; j--) {
          for (const it of pr[j]!.items) if ((Math.abs(it.x + it.w - p.x1) <= 3 || Math.abs(it.x - p.x0) <= 3) && !isSummaryLabel(it.str)) near.push({ it, dy: pr[j]!.y - r.y });
        }
        near.sort((a, b) => a.dy - b.dy);
        if (near.some((n) => assignFact(r.facts, key, n.it.str))) {
          aligned++;
          continue;
        }
        // Or on the same row, just to the right.
        const right = r.items.filter((it) => it.x >= p.x1 - 1).sort((a, b) => a.x - b.x)[0];
        if (right && right.x - p.x1 <= 220 && !isSummaryLabel(right.str) && !headRole(right.str)
          && !((key === 'holder' || key === 'number' || key === 'name') && !/:\s*$/.test(p.str) && right.x - p.x1 > 60)) {
          assignFact(r.facts, key, right.str);
        }
      }
      if (summaryish.length >= 2 && aligned >= 1) {
        r.summary = true;
        below!.summary = true;
      }
    });
  }
}

function assignFact(f: Facts, key: FactKey, raw: string): boolean {
  const s = raw.trim();
  if (key === 'name') {
    if (!/[A-Za-z]{2}/.test(s) || s.length > 40) return false;
    f.name ??= s;
    return true;
  }
  if (key === 'holder') {
    if (!/[A-Za-z]{2}/.test(s) || /\d{4}/.test(s)) return false;
    f.holder ??= s;
    return true;
  }
  if (key === 'number') {
    const m = /\b(\d{8,12})\b/.exec(s.replace(/\s/g, ''));
    if (!m) return false;
    f.number ??= m[1];
    return true;
  }
  if (key === 'countIn' || key === 'countOut') {
    if (!/^\d{1,6}$/.test(s)) return false;
    f[key] ??= Number(s);
    return true;
  }
  if (!isMoney(s)) return false;
  const v = moneyValue(s);
  if (v === null) return false;
  f[key] ??= v;
  return true;
}

export function analysePdf(pages: PdfPage[], opts: { saved?: PdfLayout[]; year?: number } = {}): PdfAnalysis {
  return analysePdfSections(pages, opts)[0]!;
}

/**
 * Some statements hold several accounts one after another (a wallet and its savings pot), each with its own
 * opening balance and table. Each comes back as its own analysis, in the order printed.
 */
export function analysePdfSections(pages: PdfPage[], opts: { saved?: PdfLayout[]; year?: number } = {}): PdfAnalysis[] {
  const rows = buildRows(pages);
  readSummaries(rows);
  for (const pr of rows) for (const r of pr) if (r.summary) r.header = false;

  // Typical line spacing inside tables.
  const gaps: number[] = [];
  for (const pr of rows) for (let i = 1; i < pr.length; i++) if (pr[i]!.money.length || pr[i]!.date) {
    const g = pr[i - 1]!.y - pr[i]!.y;
    if (g > 0 && g < 40) gaps.push(g);
  }
  const step = median(gaps, 12);
  // Some layouts space whole transactions further apart than lines (a block of rows per transaction); the
  // table continues over those bigger gaps too, as long as they are typical between the first and last row.
  const inner: number[] = [];
  for (const pr of rows) {
    const idx = pr.flatMap((r, i) => (r.date && r.money.length && !r.summary ? [i] : []));
    if (idx.length < 2) continue;
    for (let i = idx[0]! + 1; i <= idx[idx.length - 1]!; i++) {
      const g = pr[i - 1]!.y - pr[i]!.y;
      if (g > 0 && g < 60) inner.push(g);
    }
  }
  const tol = inner.length >= 10 ? Math.max(step * 1.5, quantile(inner, 0.9, 0) * 1.25) : step * 3;

  // Table zones: from each heading (or each first dated row) down over tightly spaced rows.
  const inZone = rows.map((pr) => pr.map(() => false));
  const zoneHeader: Array<Array<TRow | null>> = rows.map((pr) => pr.map(() => null));
  let lastHeader: TRow | null = null;
  rows.forEach((pr, p) => {
    let i = 0;
    while (i < pr.length) {
      const r = pr[i]!;
      let start = -1;
      let hdr: TRow | null = null;
      if (r.header) { start = i + 1; hdr = r; }
      // A dated row with its amounts on it, on the row below, or (Wise: description, amounts, then "26 April 2023 |
      // Transaction: …") just above it.
      else if (!r.summary && r.date && (r.money.length || (pr[i + 1]?.money.length && r.y - pr[i + 1]!.y <= step * 3)
        || (pr[i - 1]?.money.length && !pr[i - 1]!.summary && !pr[i - 1]!.header && pr[i - 1]!.y - r.y <= step * 1.8))) {
        start = i;
        // Rows carried over from the previous page sit above the first date.
        while (start > 0 && !pr[start - 1]!.header && !pr[start - 1]!.summary && pr[start - 1]!.y - pr[start]!.y <= step * 1.8 && pr[start - 1]!.money.length) start--;
        // A description printed just above its own dated row (centred in a taller cell).
        while (start > 0 && !pr[start - 1]!.header && !pr[start - 1]!.summary && !pr[start - 1]!.money.length && !pr[start - 1]!.date
          && pr[start - 1]!.y - pr[start]!.y <= step * 1.2 && pr[start]!.y - (pr[start + 1]?.y ?? -Infinity) <= step * 1.2 && i - start < 2) start--;
        if (start > 0 && pr[start - 1]!.header) hdr = pr[start - 1]!;
        // A table that runs on from the previous page without repeating its heading keeps the old one.
        hdr ??= lastHeader;
      }
      if (start < 0) { i++; continue; }
      if (hdr) lastHeader = hdr;
      let j = start;
      while (j < pr.length && !pr[j]!.header && !pr[j]!.summary && (j === start || pr[j - 1]!.y - pr[j]!.y <= tol)) j++;
      // A "table" with no amount in it is something else that happens to look like a heading (a key to the
      // payment-type codes, a list of terms). Leave it out.
      if (pr.slice(start, j).some((r) => r.money.length)) {
        for (let k = start; k < j; k++) { inZone[p]![k] = true; zoneHeader[p]![k] = hdr; }
      }
      i = Math.max(j, i + 1);
    }
  });

  if (!rows.some((pr, p) => pr.some((r, i) => inZone[p]![i] && r.date)) || !rows.some((pr, p) => pr.some((r, i) => inZone[p]![i] && r.money.length))) {
    throw new ImportError('No transaction table was found in this PDF. If it is a statement, download a CSV, OFX or QIF from online banking instead.');
  }

  // Sections: after transactions have been read, a new account starts at a summary box with an opening balance,
  // or at a statement title not seen before ("Personal Account statement", then "Pot statement"). A title printed
  // on every page ("Your Statement") is not new and never splits.
  const flat = rows.flatMap((pr, p) => pr.map((r, i) => ({ r, zone: inZone[p]![i]!, hdr: zoneHeader[p]![i] ?? null })));
  const sections: Array<typeof flat> = [[]];
  const titles = new Set<string>();
  let lastOpening: Pence | undefined;
  let seenTxn = false;
  for (const e of flat) {
    const title = e.zone ? null : statementTitle(e.r);
    const newTitle = !!title && !titles.has(title);
    if (title) titles.add(title);
    // A summary box repeated at the top of every page (Zenith) carries the same opening balance: not a new account.
    const newOpening = e.r.facts.opening !== undefined && e.r.facts.opening !== lastOpening;
    if (e.r.facts.opening !== undefined && !e.zone) lastOpening = e.r.facts.opening;
    if (!e.zone && seenTxn && (newOpening || newTitle)) {
      // The section's title rows ("Savings Account") sit just above its summary box.
      const cur = sections[sections.length - 1]!;
      const moved: typeof flat = [];
      while (cur.length && !cur[cur.length - 1]!.zone && cur[cur.length - 1]!.r.page === e.r.page && cur[cur.length - 1]!.r.y - e.r.y <= 80) moved.unshift(cur.pop()!);
      sections.push(moved);
      seenTxn = false;
    }
    sections[sections.length - 1]!.push(e);
    if (e.zone && e.r.money.length) seenTxn = true;
  }

  const currency = currencyOf(pages);
  const everyFlat = flat.map((e) => e.r.text.toLowerCase().replace(/\s+/g, ''));
  const firstPages = flat.filter((e) => !e.zone && e.r.page < 2).map((e) => e.r.text.toLowerCase().replace(/\s+/g, ''));
  const otherOutside = flat.filter((e) => !e.zone && e.r.page >= 2).map((e) => e.r.text.toLowerCase().replace(/\s+/g, ''));
  const bank = bankFrom([...firstPages, ...otherOutside], everyFlat);
  const years: number[] = [];
  for (const e of flat) for (const m of e.r.text.matchAll(/\b(20\d{2})\b/g)) years.push(Number(m[1]));
  const docFacts: Facts = {};
  for (const e of flat) for (const k of ['holder', 'number'] as const) if (e.r.facts[k] && !docFacts[k]) docFacts[k] = e.r.facts[k] as never;

  const out = sections
    .filter((s) => s.some((e) => e.zone && e.r.date) && s.some((e) => e.zone && e.r.money.length))
    .map((s, si, all) => analyseSection(s, { bank, currency, step, years, docFacts, multi: all.length > 1, index: si, opts }));
  if (!out.length) throw new ImportError('No transaction table was found in this PDF. If it is a statement, download a CSV, OFX or QIF from online banking instead.');
  return out;
}

interface SectionCtx {
  bank: string;
  currency?: Currency;
  step: number;
  years: number[];
  docFacts: Facts;
  multi: boolean;
  index: number;
  opts: { saved?: PdfLayout[]; year?: number };
}

/** A copy of a row moved left by `dx` points (money items stay identifiable as money). */
function shiftRow(r: TRow, dx: number): TRow {
  if (!dx) return r;
  const items = r.items.map((it) => ({ ...it, x: it.x - dx }));
  return { ...r, items, money: items.filter((_, k) => r.money.includes(r.items[k]!)) };
}

function analyseSection(rawEntries: Array<{ r: TRow; zone: boolean; hdr: TRow | null }>, ctx: SectionCtx): PdfAnalysis {
  // Pages can be printed a few points to one side of each other (Barclays): when a page repeats the first page's
  // table heading at an offset, move that page's table back into line so its columns match.
  const baseHdr = rawEntries.find((e) => e.zone && e.hdr)?.hdr ?? null;
  const basePh = baseHdr ? phrases(baseHdr.items) : [];
  const shiftCache = new Map<TRow, number>();
  const shiftOf = (h: TRow | null): number => {
    if (!h || !baseHdr || h === baseHdr) return 0;
    if (!shiftCache.has(h)) {
      const ph = phrases(h.items);
      const same = ph.length === basePh.length && ph.every((p, i) => p.str.toLowerCase() === basePh[i]!.str.toLowerCase());
      const d = same ? median(ph.map((p, i) => p.x0 - basePh[i]!.x0), 0) : 0;
      shiftCache.set(h, Math.abs(d) >= 2 ? d : 0);
    }
    return shiftCache.get(h)!;
  };
  const shiftedHdr = new Map<TRow, TRow>();
  const entries = rawEntries.map((e) => {
    const dx = e.zone ? shiftOf(e.hdr) : 0;
    if (!dx || !e.hdr) return e;
    if (!shiftedHdr.has(e.hdr)) shiftedHdr.set(e.hdr, shiftRow(e.hdr, dx));
    return { ...e, r: shiftRow(e.r, dx), hdr: shiftedHdr.get(e.hdr)! };
  });
  const zoneRows = entries.filter((e) => e.zone);
  const outsideRows = entries.filter((e) => !e.zone).map((e) => e.r);

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

  const spansOf = new Map<TRow | null, TextSpans>();
  // Where the description column ends: the next heading, or for a last column, the widest line printed in it.
  const descEnd = new Map<TRow | null, number>();
  let above: { page: number; right: number } | null = null;
  let lines: Line[] = zoneRows.map(({ r, hdr }) => {
    if (!spansOf.has(hdr)) spansOf.set(hdr, textSpans(hdr, zoneRows.filter((z) => z.hdr === hdr).map((z) => z.r)));
    const spans = spansOf.get(hdr)!;
    // A date only counts if it sits left of the description column; one inside it ("07 Sep" on a continuation line)
    // is part of the description.
    const first = r.items.find((it) => !r.money.includes(it));
    const dated = !!r.date && !(spans.desc && first && first.x >= spans.desc[0] && first.x > (hdr?.items[0]?.x ?? 0) + 20);
    const dateText = dated ? r.date! : '';
    let rest = dated ? r.text.slice(r.dateLen).trim() : r.text;
    const tm = dated ? leadingTime(rest) : null;
    if (tm) rest = rest.slice(tm.len).trim();
    let text: string;
    let ref: string | undefined;
    let payType: string | undefined;
    let wrap = false;
    if (spans.desc) {
      // The heading says where descriptions are: anything else on the row (channel, value date, reference) is not one.
      const words = r.items.filter((it) => !r.money.includes(it));
      const inside = (it: PdfItem, s?: [number, number]) => !!s && it.x >= s[0] && it.x < s[1];
      const descItems = words.filter((it) => inside(it, spans.desc) && !(dated && it.x < (words[0]?.x ?? 0) + 1 && leadingDate(it.str)));
      text = joinItems(descItems);
      // A line is the wrapped tail of the one above when its first word would not have fitted on that line.
      if (!descEnd.has(hdr)) {
        const rights = zoneRows.filter((z) => z.hdr === hdr).flatMap((z) => z.r.items.filter((it) => !z.r.money.includes(it) && inside(it, spans.desc)).map((it) => it.x + it.w));
        descEnd.set(hdr, Number.isFinite(spans.desc![1]) ? spans.desc![1] : Math.max(0, ...rights));
      }
      const head = descItems[0];
      if (head && text) {
        const cw = head.w / Math.max(1, head.str.length);
        const firstWord = text.split(' ')[0]!;
        const wrapped = above && above.page === r.page && above.right + cw + firstWord.length * cw > descEnd.get(hdr)! + 1;
        above = { page: r.page, right: Math.max(...descItems.map((it) => it.x + it.w)) };
        if (wrapped) wrap = true;
      } else above = null;
      const refText = joinItems(words.filter((it) => inside(it, spans.ref)));
      const loose = words.filter((it) => !inside(it, spans.desc) && !inside(it, spans.ref)).map((it) => it.str.trim()).find((s) => /^(?=.*\d)[A-Z0-9/-]{6,}$/i.test(s) && !leadingDate(s));
      ref = refText || loose || undefined;
      const code = joinItems(words.filter((it) => inside(it, spans.type)));
      if (code) payType = typeCode(code);
    } else {
      const second = dated ? leadingDate(rest) : null; // a value date printed next to the posting date
      text = second ? rest.slice(second.length).trim() : rest;
    }
    text = text.replace(/^[\s,.:;–-]+(?=\S)/, '').trim();
    if (wrap && text) text = WRAP + text;
    const line: Line = {
      page: r.page, y: r.y, dateText, texts: text ? [text] : [],
      money: r.money.map((t) => ({ col: colOf(t), value: moneyValue(t.str) })).filter((m): m is { col: number; value: Pence } => m.col >= 0 && m.value !== null),
      marker: markerOf(r.text),
    };
    if (tm) line.time = tm.time;
    if (ref) line.ref = ref;
    if (payType) line.type = payType;
    return line;
  });

  const blocks = findBlocks(lines);
  if (blocks) lines = blocks;

  // Facts printed outside the table: summary boxes, account, opening/closing.
  const facts: Facts = {};
  for (const r of entries.map((e) => e.r)) for (const [k, v] of Object.entries(r.facts) as Array<[FactKey, never]>) if (facts[k] === undefined) facts[k] = v;
  const outside: PdfAnalysis['outside'] = { years: ctx.years, ...facts };
  let sortCode: string | undefined;
  let number = facts.number;
  outsideRows.forEach((r, i) => {
    if (!sortCode) sortCode = /\b(\d{2}-\d{2}-\d{2})\b/.exec(r.text)?.[1];
    if (!number && /account/i.test(r.text)) number = /\b(\d{10}|\d{8})\b/.exec(r.text)?.[1] ?? /\b(\d{10}|\d{8})\b/.exec(outsideRows[i + 1]?.text ?? '')?.[1];
    if (r.summary) return;
    const mk = markerOf(r.text);
    const v = r.money.length ? moneyValue(r.money[r.money.length - 1]!.str) : null;
    if (v !== null && mk === 'bf' && outside.opening === undefined) outside.opening = v;
    if (v !== null && mk === 'cf' && outside.closing === undefined) outside.closing = v;
  });
  number ??= ctx.docFacts.number;
  // In a statement holding several accounts, name each one: the printed pot or account name, else its title
  // ("Wallet Account", "Savings Account"), else the statement title without the word "statement".
  const statementName = outsideRows.map(statementTitle).find(Boolean);
  const title = ctx.multi
    ? facts.name
      ?? (statementName ? outsideRows.map((r) => phrases(r.items)[0]?.str ?? '').find((s) => s.toLowerCase() === statementName)?.replace(/\s*statement\s*/i, ' ').trim().replace(/^\S+$/, '') || undefined : undefined)
      ?? outsideRows.map((r) => phrases(r.items)[0]?.str ?? '').find((s) => /\b(?:account|wallet|savings?|current|pot)\b/i.test(s) && !/statement|balance|[\d:]/i.test(s) && !isSummaryLabel(s) && s.length <= 40)
    : undefined;

  const dateOrder = detectDateOrder(lines.filter((l) => l.dateText).map((l) => l.dateText));
  const dated = lines.filter((l) => l.dateText && !l.marker);
  const style = blocks || (dated.length && dated.filter((l) => l.money.length).length / dated.length >= 0.6) ? 'first' : 'last';

  const base: Omit<PdfAnalysis, 'roles' | 'fromSaved' | 'result'> = {
    bank: ctx.bank,
    account: { sortCode, number, holder: facts.holder ?? ctx.docFacts.holder, label: title ?? (ctx.multi ? `Account ${ctx.index + 1}` : undefined) },
    currency: ctx.currency, anchor, columns, dateOrder, style, blocks: !!blocks, multi: ctx.multi, lines, outside, fallbackYear: ctx.opts.year ?? new Date().getFullYear(),
  };

  // Choose roles: saved layout, headings, and every valid assignment, scored by the balance.
  const saved = (ctx.opts.saved ?? []).find((l) => matchesLayout(l, base));
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

/**
 * Some statements give each transaction a block of rows: the description wraps above and below the line that
 * carries the date and amounts, and blocks are spaced further apart than the rows inside them. When the gaps
 * split cleanly into "inside a block" and "between blocks", and no block holds two amounts, each block becomes
 * one line. Otherwise the statement is read row by row as before.
 */
function findBlocks(lines: Line[]): Line[] | null {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) if (lines[i]!.page === lines[i - 1]!.page) gaps.push(Math.round((lines[i - 1]!.y - lines[i]!.y) * 2) / 2);
  // Only gap sizes that recur count: a handful of odd gaps (a wrapped reference) must not hide the jump.
  const freq = new Map<number, number>();
  for (const g of gaps) if (g > 0) freq.set(g, (freq.get(g) ?? 0) + 1);
  const uniq = [...freq.entries()].filter(([, n]) => n >= Math.max(1, Math.ceil(gaps.length * 0.03))).map(([g]) => g).sort((a, b) => a - b);
  // Every clear jump in gap size is a candidate cut. A cut that leaves dates on their own (Wise prints the date line
  // under the amounts) only wins if nothing else works; then the cut that leaves the fewest text lines without an
  // amount wins (GTBank centres the amount in a tall cell, so half-line gaps inside a cell look like a jump too).
  let best: { merged: Line[]; stranded: boolean; orphans: number } | null = null;
  const better = (c: { stranded: boolean; orphans: number }) =>
    !best || (c.stranded !== best.stranded ? !c.stranded : c.orphans < best.orphans);
  for (let k = 1; k < uniq.length; k++) {
    const ratio = uniq[k]! / uniq[k - 1]!;
    if (ratio < 1.4) continue;
    const cut = (uniq[k]! + uniq[k - 1]!) / 2;
    const groups: Line[][] = [];
    lines.forEach((l, i) => {
      const prev = lines[i - 1];
      if (!prev || prev.page !== l.page || prev.y - l.y > cut) groups.push([l]);
      else groups[groups.length - 1]!.push(l);
    });
    // A block cut by a page break: text left at the foot of one page belongs to the first block of the next.
    for (let g = 0; g < groups.length - 1; g++) {
      const a = groups[g]!;
      const b = groups[g + 1]!;
      if (!a.some((l) => l.money.length) && b[0]!.page === a[0]!.page + 1 && b.some((l) => l.money.length)) { groups[g + 1] = [...a, ...b]; groups[g] = []; }
    }
    const withMoney = groups.filter((g) => g.some((l) => l.money.length));
    if (groups.some((g) => g.filter((l) => l.money.length).length > 1)) break;
    // Too few multi-row blocks at this cut: the gap was noise between rows; try the next jump. Some statements wrap
    // only the odd long description (Monzo), so a few clear blocks are enough; no block ever holds two amounts.
    const multi = withMoney.filter((g) => g.length > 1).length;
    if (!withMoney.length || !(multi >= Math.max(2, withMoney.length * 0.05) || (multi && multi >= withMoney.length * 0.3))) continue;
    // A gentler jump (under 1.8×) only counts when most rows are tall cells, as in GTBank; otherwise it is the odd
    // wrapped line or footer spacing in a one-line-per-row table (Halifax).
    if (ratio < 1.8 && multi < withMoney.length * 0.5) continue;
    const merged = withMoney.map((g) => {
      const main = g.find((l) => l.money.length)!;
      const merged: Line = {
        page: main.page, y: main.y,
        dateText: g.find((l) => l.dateText)?.dateText ?? '',
        texts: g.flatMap((l) => l.texts),
        money: main.money,
        marker: g.map((l) => l.marker).find(Boolean) ?? null,
      };
      const time = g.find((l) => l.time)?.time;
      if (time) merged.time = time;
      const ref = g.flatMap((l) => (l.ref ? [l.ref] : [])).join('');
      if (ref) merged.ref = ref;
      const type = g.find((l) => l.type)?.type;
      if (type) merged.type = type;
      return merged;
    });
    const stranded = groups.some((g) => !g.some((l) => l.money.length) && g.some((l) => l.dateText));
    const orphans = groups.filter((g) => g.length && !g.some((l) => l.money.length)).length;
    if (better({ stranded, orphans })) best = { merged, stranded, orphans };
  }
  return best?.merged ?? null;
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
  if (s.totalsOk === true) sc += 2;
  if (s.totalsOk === false) sc -= 2;
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

interface Stats { confirmed: number; wrong: number; flipped: number; closingOk: boolean | null; hasBalance: boolean; totalsOk: boolean | null; reordered: number; openingFixed: boolean }

/** Walk the running balance from `start`. Same-day neighbours the balance shows the other way round are swapped. */
function reconcile(txns: RawTxn[], start: Pence | undefined, inferred: boolean, unsigned: boolean, apply: boolean) {
  const stats = { confirmed: 0, wrong: 0, flipped: 0, reordered: 0, end: start };
  if (start === undefined) return stats;
  // When only counting, work on a copy so trying one starting point never disturbs the next.
  const list = apply ? txns : [...txns];
  let run = start;
  let since = 0;
  for (let i = 0; i < list.length; i++) {
    let t = list[i]!;
    if (inferred && i === 0) { run = t.balance!; continue; }
    // Rows from the same moment can be printed in the wrong order (a top-up shown after the payment it paid for,
    // a fee before its transfer). When this row's balance doesn't follow but one of the next few same-day rows'
    // does, that row comes first. Only an exact balance match moves anything.
    if (!unsigned && t.balance !== undefined && since === 0 && run + t.amount !== t.balance) {
      for (let k = i + 1; k < Math.min(list.length, i + 5) && list[k]!.date === t.date; k++) {
        const n = list[k]!;
        if (n.balance === undefined || run + n.amount !== n.balance) continue;
        list.splice(k, 1);
        list.splice(i, 0, n);
        t = n;
        stats.reordered++;
        break;
      }
    }
    let amt = t.amount;
    if (unsigned && t.balance !== undefined && since === 0 && Math.abs(t.balance - run) === Math.abs(t.amount) && t.balance - run !== t.amount) {
      amt = t.balance - run; // the column has no signs; the balance says which way it went
      if (apply) t.amount = amt;
    } else if (!unsigned && t.balance !== undefined && since === 0 && t.balance - run === -t.amount && t.amount !== 0) {
      stats.flipped++;
    }
    run += amt;
    since++;
    if (t.balance !== undefined) {
      if (t.balance === run) stats.confirmed++;
      else { stats.wrong++; run = t.balance; }
      since = 0;
    }
  }
  stats.end = run;
  return stats;
}

function readWith(a: Omit<PdfAnalysis, 'roles' | 'fromSaved' | 'result'>, roles: MoneyRole[], order: DateOrder, light = false): PdfReading & { stats: Stats } {
  const role = (col: number): MoneyRole => roles[col] ?? 'ignore';
  const unsigned = roles.includes('amount') && !a.lines.some((l) => l.money.some((m) => role(m.col) === 'amount' && m.value < 0));

  interface Draft { parts: DateParts | null; lines: string[]; amount: Pence; balance?: Pence; type: string; time?: string; ref?: string }
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
      const d: Draft = { parts: curDate, lines: light ? [] : [...pending, ...l.texts], amount: amt ?? 0, type: '' };
      if (l.time) d.time = l.time;
      if (l.ref) d.ref = l.ref;
      if (l.type) d.type = l.type;
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
      // Barclays repeats the balance on a description's second line; the text still belongs to the payment.
      if (l.texts.length && !light && a.style === 'first' && last && !l.dateText) last.lines.push(...l.texts);
    } else if (l.texts.length && !light) {
      if (a.style === 'first' && last && !l.dateText) last.lines.push(...l.texts);
      else pending.push(...l.texts);
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
    const lines = joinWrapped(d.lines);
    const t: RawTxn = { date: makeDate(year, d.parts.m, d.parts.d), amount: d.amount, type: d.type, lines: lines.length || light ? lines : ['(no description)'] };
    if (d.balance !== undefined) t.balance = d.balance;
    if (d.time) t.time = d.time;
    if (d.ref) t.ref = d.ref;
    if (t.amount !== 0) txns.push(t);
  }
  if (descending) txns.reverse();
  if (!light) readWording(txns);

  // Reconcile against the printed balance.
  const hasBalance = roles.includes('balance');
  if (opening === undefined) opening = a.outside.opening;
  if (closing === undefined) closing = a.outside.closing;
  const first = txns[0];
  const canInfer = first?.balance !== undefined;
  const inferredStart = canInfer ? first.balance! - first.amount : undefined;
  // With no printed opening balance, the first row's balance sets the start; that row then proves nothing.
  let start = opening ?? inferredStart;
  let inferred = opening === undefined && canInfer;
  let openingFixed = false;
  let rec = reconcile(txns, start, inferred, unsigned, false);
  // A printed opening balance can itself be wrong (one bank prints the balance after the first row). If starting
  // from the first row instead makes every later balance and the closing balance agree, trust the rows.
  if (opening !== undefined && canInfer && rec.wrong > 0) {
    const alt = reconcile(txns, inferredStart, true, unsigned, false);
    const closes = closing === undefined || alt.end === closing;
    if (alt.wrong === 0 && alt.confirmed > 0 && closes) {
      start = inferredStart;
      inferred = true;
      openingFixed = true;
      rec = alt;
    }
  }
  rec = reconcile(txns, start, inferred, unsigned, true);
  // With no balance column (many US statements), the printed opening and closing balances still prove the reading:
  // the opening plus every transaction must come to the closing balance exactly.
  const ends = !hasBalance && opening !== undefined && closing !== undefined && txns.length
    ? opening + txns.reduce((s, t) => s + t.amount, 0) === closing : null;
  const stats: Stats = {
    confirmed: rec.confirmed, wrong: rec.wrong, flipped: rec.flipped, reordered: rec.reordered, hasBalance, openingFixed,
    closingOk: hasBalance ? (start !== undefined && closing !== undefined ? rec.end === closing : null) : ends,
    totalsOk: null,
  };

  // Printed totals and counts: a second, independent proof.
  const sumIn = txns.reduce((s, t) => s + (t.amount > 0 ? t.amount : 0), 0);
  const sumOut = txns.reduce((s, t) => s + (t.amount < 0 ? -t.amount : 0), 0);
  const nIn = txns.filter((t) => t.amount > 0).length;
  const nOut = txns.filter((t) => t.amount < 0).length;
  const o = a.outside;
  const totalChecks: boolean[] = [];
  if (o.totalIn !== undefined) totalChecks.push(Math.abs(o.totalIn) === sumIn);
  if (o.totalOut !== undefined) totalChecks.push(Math.abs(o.totalOut) === sumOut);
  if (o.countIn !== undefined) totalChecks.push(o.countIn === nIn);
  if (o.countOut !== undefined) totalChecks.push(o.countOut === nOut);
  if (totalChecks.length) stats.totalsOk = totalChecks.every(Boolean);

  const checks: Check[] = [];
  let reason: string | undefined;
  if (!hasBalance && ends !== null) {
    checks.push(ends
      ? { name: 'Opening and closing balances agree', ok: true, detail: `${fmt(opening!)} plus every transaction comes to ${fmt(closing!)}.` }
      : { name: 'Opening and closing balances do not agree', ok: false, detail: `${fmt(opening!)} plus the transactions read comes to ${fmt(opening! + txns.reduce((s, t) => s + t.amount, 0))}; the statement says ${fmt(closing!)}.` });
    if (!ends) reason = 'The transactions read don’t take the opening balance to the closing balance. A column may be the wrong way round.';
  } else if (!hasBalance) {
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
  if (stats.totalsOk !== null) {
    const parts = [
      o.totalIn !== undefined ? `money in ${fmt(sumIn)}` : '', o.totalOut !== undefined ? `money out ${fmt(sumOut)}` : '',
      o.countIn !== undefined ? `${nIn} in` : '', o.countOut !== undefined ? `${nOut} out` : '',
    ].filter(Boolean).join(', ');
    checks.push({
      name: stats.totalsOk ? 'Printed totals agree' : 'Printed totals do not agree',
      ok: stats.totalsOk,
      detail: stats.totalsOk ? `Read ${parts}.` : `Read ${parts}; the statement prints ${[
        o.totalIn !== undefined ? `in ${fmt(Math.abs(o.totalIn))}` : '', o.totalOut !== undefined ? `out ${fmt(Math.abs(o.totalOut))}` : '',
        o.countIn !== undefined ? `${o.countIn} in` : '', o.countOut !== undefined ? `${o.countOut} out` : '',
      ].filter(Boolean).join(', ')}.`,
    });
    if (!stats.totalsOk && !reason) reason = 'The totals printed on the statement do not match the transactions read.';
  }
  if (openingFixed && !light) {
    warnings.push(`The statement prints an opening balance of ${fmt(opening!)}, but its first transaction only adds up from ${fmt(start!)}. Every later balance agrees with ${fmt(start!)}, so that was used.`);
  }
  if (stats.reordered && !light) {
    warnings.push(`${stats.reordered} same-day transaction${stats.reordered === 1 ? ' was' : 's were'} printed out of order; the running balance put them back.`);
  }
  if (skipped) warnings.push(`${skipped} row(s) had no date and were skipped.`);

  const statementCurrency = a.currency;
  if (statementCurrency && statementCurrency !== region().currency && !light) {
    reason = `This statement is in ${CURRENCY_NAME[statementCurrency]}, but Tally is set to ${region().name} (${region().symbol}). Change “Where you bank” in Settings before importing it.`;
    checks.push({ name: 'Currency does not match', ok: false, detail: `Statement in ${CURRENCY_NAME[statementCurrency]}; Tally set to ${region().unitName}.` });
  }

  const dates = txns.map((t) => t.date).sort();
  const parsed: ParsedStatement = {
    bank: a.bank || 'PDF statement',
    format: 'pdf-generic',
    account: {
      sortCode: a.account.sortCode, number: a.account.number, holder: a.account.holder,
      label: a.account.label ?? (a.account.number ? undefined : a.bank || undefined),
      ...(a.multi ? { section: a.account.label } : {}),
    },
    periodStart: dates[0],
    periodEnd: dates[dates.length - 1],
    opening: openingFixed ? start : opening,
    closing,
    totalIn: o.totalIn,
    totalOut: o.totalOut,
    txns,
    checks,
    warnings,
  };
  const verified = !reason && txns.length > 0 && (stats.confirmed >= 2 || (stats.confirmed >= 1 && txns.length <= 2) || ends === true) && !skipped;
  if (!reason && !verified) reason = skipped ? 'Some rows had no date.' : 'Too few printed balances to be sure.';
  return { parsed, verified, reason: verified ? undefined : reason, stats };
}

const CURRENCY_NAME: Record<Currency, string> = { GBP: 'pounds (£)', NGN: 'naira (₦)', USD: 'dollars ($)', EUR: 'euros (€)' };

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
