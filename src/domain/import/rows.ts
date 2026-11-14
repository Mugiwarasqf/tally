import type { PdfItem, PdfPage } from './types';

/** Shared by the PDF parsers: turn positioned text into visual rows. */
export interface Row {
  y: number;
  items: PdfItem[];
  text: string; // all items joined, spaces removed, lower-cased — for label matching
}

const ROW_TOL = 2.5;

/** Group items that sit on the same baseline (within a small tolerance), top of the page first. */
export function groupRows(page: PdfPage): Row[] {
  const rows: Row[] = [];
  for (const it of [...page].sort((a, b) => b.y - a.y)) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= ROW_TOL);
    if (row) row.items.push(it);
    else rows.push({ y: it.y, items: [it], text: '' });
  }
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    r.text = r.items.map((i) => i.str).join('').replace(/\s+/g, '').toLowerCase();
  }
  return rows;
}

/** Join items on a row, inserting a space only where there is a visible gap. */
export function joinItems(items: PdfItem[]): string {
  let out = '';
  let edge = -Infinity;
  for (const it of items) {
    if (out && it.x - edge > 1.2) out += ' ';
    out += it.str.trim();
    edge = it.x + it.w;
  }
  return out.replace(/\s+/g, ' ').trim();
}
