import { detectDateOrder, parseLooseDate } from './csv';
import { ImportError } from './types';
import type { ParsedStatement, RawTxn } from './types';
import { parseMoney } from '../../lib/money';

/** QIF: one field per line (D date, T amount, P payee, M memo), records end with "^". */
export function parseQif(text: string, label = 'QIF import'): ParsedStatement {
  const records: Array<Record<string, string>> = [];
  let cur: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('!')) continue;
    if (line === '^') {
      if (cur.D && cur.T) records.push(cur);
      cur = {};
    } else cur[line[0]!] = line.slice(1).trim();
  }
  if (cur.D && cur.T) records.push(cur);
  const order = detectDateOrder(records.map((r) => r.D!));
  const txns: RawTxn[] = [];
  for (const r of records) {
    const date = parseLooseDate(r.D!, order);
    const amount = parseMoney(r.T!);
    if (!date || amount === null || amount === 0) continue;
    const lines = [r.P, r.M].filter((x): x is string => !!x);
    txns.push({ date, amount, type: '', lines: lines.length ? lines : ['(no description)'] });
  }
  if (!txns.length) throw new ImportError('No transactions found in that QIF file.');
  const dates = txns.map((t) => t.date).sort();
  return { bank: 'QIF', format: 'qif', account: { label }, periodStart: dates[0], periodEnd: dates.at(-1), txns, checks: [], warnings: [] };
}
