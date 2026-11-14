import { db } from './db';
import type { Category, Txn } from '../domain/types';

/**
 * Backup = every table as JSON, encrypted with a passphrase.
 * AES-GCM with a key derived from the passphrase via PBKDF2 (SHA-256, 250k rounds),
 * all through the browser's built-in WebCrypto — no library, no network.
 */
const TABLES = ['accounts', 'files', 'txns', 'categories', 'rules', 'budgets', 'plans', 'debts', 'kv'] as const;
const ITER = 250_000;

interface Envelope {
  app: 'tally';
  v: 1;
  salt: string;
  iv: string;
  data: string;
}

const b64 = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  bytes.forEach((x) => (s += String.fromCharCode(x)));
  return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(pass: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptJson(payload: unknown, pass: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  const env: Envelope = { app: 'tally', v: 1, salt: b64(salt), iv: b64(iv), data: b64(data) };
  return JSON.stringify(env);
}

export async function decryptJson(text: string, pass: string): Promise<unknown> {
  let env: Envelope;
  try {
    env = JSON.parse(text) as Envelope;
  } catch {
    throw new Error('That file is not a Tally backup.');
  }
  if (env.app !== 'tally' || !env.data) throw new Error('That file is not a Tally backup.');
  try {
    const key = await deriveKey(pass, unb64(env.salt));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) as BufferSource }, key, unb64(env.data) as BufferSource);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error('Wrong passphrase, or the file is damaged.');
  }
}

export async function exportBackup(pass: string): Promise<Blob> {
  const dump: Record<string, unknown[]> = {};
  for (const t of TABLES) dump[t] = await db.table(t).toArray();
  return new Blob([await encryptJson(dump, pass)], { type: 'application/json' });
}

/** Replace all data with the backup's contents. */
export async function restoreBackup(text: string, pass: string): Promise<void> {
  const dump = (await decryptJson(text, pass)) as Record<string, unknown[]>;
  await db.transaction('rw', TABLES.map((t) => db.table(t)), async () => {
    for (const t of TABLES) {
      await db.table(t).clear();
      if (Array.isArray(dump[t]) && dump[t]!.length) await db.table(t).bulkAdd(dump[t]!);
    }
  });
}

/** Plain spreadsheet export of transactions (for Excel/Sheets). */
export async function exportCsv(): Promise<Blob> {
  const cats = new Map((await db.categories.toArray()).map((c: Category) => [c.id, c.name]));
  const accts = new Map((await db.accounts.toArray()).map((a) => [a.id, a.name]));
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const rows = (await db.txns.orderBy('date').toArray()).map((t: Txn) =>
    [t.date, t.time ?? '', esc(accts.get(t.accountId) ?? ''), esc(t.merchant), esc(cats.get(t.categoryId) ?? ''), (t.amount / 100).toFixed(2), esc(t.place ?? ''), esc(t.detail), esc(t.note ?? '')].join(','),
  );
  return new Blob([['Date,Time,Account,Merchant,Category,Amount (GBP),Place,Detail,Note', ...rows].join('\n')], { type: 'text/csv' });
}

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const stamp = (): string => new Date().toISOString().slice(0, 10);
