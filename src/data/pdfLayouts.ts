import { matchesLayout } from '../domain/import/generic';
import type { PdfLayout } from '../domain/import/generic';
import { db } from './db';

/**
 * PDF layouts the user has confirmed, so the next statement from the same bank imports
 * without asking. Only column positions and roles are kept: never a transaction, name or number.
 */
const KEY = 'pdfLayouts';

export async function loadPdfLayouts(): Promise<PdfLayout[]> {
  const row = await db.kv.get(KEY);
  return Array.isArray(row?.value) ? (row.value as PdfLayout[]) : [];
}

export async function savePdfLayout(layout: PdfLayout): Promise<void> {
  await db.transaction('rw', db.kv, async () => {
    const all = await loadPdfLayouts();
    const next = [layout, ...all.filter((l) => !matchesLayout(l, layout))].slice(0, 30);
    await db.kv.put({ key: KEY, value: next });
  });
}
