import { ImportError } from './types';

/**
 * Spreadsheet statements, read on the device with no library.
 *
 * Case study: banks offer "Excel" downloads in three shapes. Modern .xlsx is a zip of XML files. Many ".xls"
 * downloads (common with Nigerian internet banking) are really an HTML table or an XML Spreadsheet 2003 file
 * with an Excel extension. Genuine old binary .xls (BIFF) needs a large parser; those are rare now and the user
 * is asked to save as .xlsx or CSV instead. Every shape becomes rows of text, which then go through exactly the
 * same column detection as CSV files.
 */

/** Raw DEFLATE decompression (browser: DecompressionStream; Node tests: zlib). Injected to keep this file pure. */
export type Inflate = (raw: Uint8Array) => Promise<Uint8Array>;

export type SheetKind = 'xlsx' | 'html' | 'xml' | 'biff' | 'unknown';

export function sniffSheet(bytes: Uint8Array): SheetKind {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'xlsx'; // "PK"
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'biff';
  const head = new TextDecoder('utf-8').decode(bytes.slice(0, 2048)).replace(/^﻿/, '').trimStart().toLowerCase();
  if (head.includes('urn:schemas-microsoft-com:office:spreadsheet') || head.includes('<workbook')) return 'xml';
  if (head.startsWith('<') && /<table|<html|<!doctype/.test(head)) return 'html';
  return 'unknown';
}

/** Rows of cell text from the first sheet of any supported spreadsheet. */
export async function readSheet(bytes: Uint8Array, inflate: Inflate): Promise<string[][]> {
  const kind = sniffSheet(bytes);
  if (kind === 'xlsx') return readXlsx(bytes, inflate);
  if (kind === 'xml') return readSpreadsheetXml(new TextDecoder('utf-8').decode(bytes));
  if (kind === 'html') return readHtmlTable(new TextDecoder('utf-8').decode(bytes));
  if (kind === 'biff') throw new ImportError('This is an old-style Excel file (.xls) that Tally can’t read. Open it in Excel, Numbers or Google Sheets and save it as .xlsx or CSV, then add that.');
  throw new ImportError('This file doesn’t look like a spreadsheet. Download the statement as .xlsx, CSV or PDF.');
}

// ---- xml helpers -----------------------------------------------------------------------------

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decodeXml = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENT[e.toLowerCase()] ?? m;
  });
const attr = (tag: string, name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const textOf = (xml: string): string => decodeXml([...xml.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => m[1]).join(''));
const stripTags = (html: string): string => decodeXml(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** Excel stores dates as days since 30 Dec 1899. */
export function serialToISO(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400) * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Numbers as plain text a money parser understands: no float noise (12.670000000000002 → 12.67). */
const numText = (v: string): string => {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
};

// ---- zip -------------------------------------------------------------------------------------

interface ZipEntry { name: string; method: number; size: number; offset: number }

function zipEntries(b: Uint8Array): ZipEntry[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ImportError('This Excel file looks damaged. Try downloading it again, or use CSV.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder('utf-8');
  for (let k = 0; k < count && dv.getUint32(p, true) === 0x02014b50; k++) {
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extra = dv.getUint16(p + 30, true);
    const comment = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    // The data starts after the local header, whose own name and extra lengths can differ from the central one.
    const offset = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    out.push({ name, method, size, offset });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

async function readXlsx(bytes: Uint8Array, inflate: Inflate): Promise<string[][]> {
  const entries = zipEntries(bytes);
  const dec = new TextDecoder('utf-8');
  const file = async (name: string): Promise<string | null> => {
    const e = entries.find((x) => x.name === name);
    if (!e) return null;
    const raw = bytes.subarray(e.offset, e.offset + e.size);
    if (e.method === 0) return dec.decode(raw);
    if (e.method === 8) return dec.decode(await inflate(raw));
    throw new ImportError('This Excel file uses a compression Tally can’t read. Save it as .xlsx again, or use CSV.');
  };

  // First sheet, as the workbook lists it.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = await file('xl/workbook.xml');
  const rels = await file('xl/_rels/workbook.xml.rels');
  const firstSheet = wb ? /<(?:\w+:)?sheet\b[^>]*>/.exec(wb)?.[0] : undefined;
  const rid = firstSheet ? /\br:id="([^"]+)"/.exec(firstSheet)?.[1] : undefined;
  if (rid && rels) {
    const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => attr(r, 'Id') === rid);
    const target = rel ? attr(rel, 'Target') : undefined;
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  const sheet = await file(sheetPath);
  if (!sheet) throw new ImportError('No worksheet was found in this Excel file.');

  const shared = [...((await file('xl/sharedStrings.xml')) ?? '').matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => textOf(m[1]!));

  // Which cell styles are dates, so date serials can be turned back into dates.
  const styles = (await file('xl/styles.xml')) ?? '';
  const custom = new Map([...styles.matchAll(/<(?:\w+:)?numFmt\b[^>]*>/g)].map((m) => [Number(attr(m[0], 'numFmtId')), decodeXml(attr(m[0], 'formatCode') ?? '')]));
  const xfBlock = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(styles)?.[1] ?? '';
  const isDateFmt = (id: number): boolean => {
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true;
    const code = custom.get(id);
    return !!code && /[dmy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]/g, '')) && !/^[#0.,%\s]+$/.test(code);
  };
  const dateStyle = [...xfBlock.matchAll(/<(?:\w+:)?xf\b[^>]*>/g)].map((m) => isDateFmt(Number(attr(m[0], 'numFmtId') ?? 0)));

  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const r = Number(attr(rm[1]!, 'r') ?? rows.length + 1) - 1;
    const cells: string[] = [];
    for (const cm of rm[2]!.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const a = cm[1]!;
      const body = cm[2] ?? '';
      const ref = attr(a, 'r');
      const col = ref ? colIndex(ref) : cells.length;
      const t = attr(a, 't');
      const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
      let s = '';
      if (t === 's') s = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') s = textOf(body);
      else if (t === 'str' || t === 'e') s = decodeXml(v ?? '');
      else if (t === 'b') s = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) {
        const style = Number(attr(a, 's') ?? -1);
        s = dateStyle[style] && Number(v) > 0 ? serialToISO(Number(v)) : numText(v);
      }
      cells[col] = s.trim();
    }
    rows[r] = Array.from(cells, (c) => c ?? '');
  }
  return Array.from(rows, (r) => r ?? []).filter((r) => r.some((c) => c));
}

const colIndex = (ref: string): number => {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

// ---- ".xls" files that are really HTML or XML ---------------------------------------------------

function readHtmlTable(html: string): string[][] {
  const rows: string[][] = [];
  for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1]!.matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].flatMap((m) => {
      const span = Number(/colspan="?(\d+)/i.exec(m[1]!)?.[1] ?? 1);
      return [stripTags(m[2]!), ...Array.from({ length: Math.max(0, span - 1) }, () => '')];
    });
    if (cells.some((c) => c)) rows.push(cells);
  }
  if (!rows.length) throw new ImportError('No table was found in this file.');
  return rows;
}

function readSpreadsheetXml(xml: string): string[][] {
  const ws = /<(?:\w+:)?Worksheet\b[\s\S]*?<\/(?:\w+:)?Worksheet>/.exec(xml)?.[0] ?? xml;
  const rows: string[][] = [];
  for (const rm of ws.matchAll(/<(?:\w+:)?Row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Row>/g)) {
    const cells: string[] = [];
    for (const cm of rm[1]!.matchAll(/<(?:\w+:)?Cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?Cell>)/g)) {
      const idx = /\bss:Index="(\d+)"/.exec(cm[1]!)?.[1];
      if (idx) while (cells.length < Number(idx) - 1) cells.push('');
      const data = /<(?:\w+:)?Data\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Data>/.exec(cm[2] ?? '');
      let s = data ? stripTags(data[2]!) : '';
      if (data && /ss:Type="DateTime"/.test(data[1]!)) s = s.slice(0, 10);
      else if (data && /ss:Type="Number"/.test(data[1]!)) s = numText(s);
      cells.push(s);
    }
    if (cells.some((c) => c)) rows.push(cells);
  }
  if (!rows.length) throw new ImportError('No rows were found in this file.');
  return rows;
}

/** Which currency a sheet's text shows, if any. */
export function currencyInRows(rows: string[][]): 'GBP' | 'NGN' | 'USD' | undefined {
  const text = rows.slice(0, 200).map((r) => r.join(' ')).join(' ');
  const n = { NGN: (text.match(/₦|\bNGN\b/g) ?? []).length, GBP: (text.match(/£|\bGBP\b/g) ?? []).length, USD: (text.match(/\$|\bUSD\b/g) ?? []).length };
  const best = (Object.keys(n) as Array<keyof typeof n>).sort((a, b) => n[b] - n[a])[0]!;
  return n[best] ? best : undefined;
}
