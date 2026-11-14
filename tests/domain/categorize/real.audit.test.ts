import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toCatMap } from '../../../src/domain/analytics/aggregate';
import { buildIncomeProfile, incomePatternPatches } from '../../../src/domain/analytics/income';
import { detectRecurring } from '../../../src/domain/analytics/recurring';
import { rentPatternPatches } from '../../../src/domain/analytics/rent';
import { DEFAULT_CATEGORIES } from '../../../src/domain/categorize/categories';
import { buildTxns } from '../../../src/domain/import/build';
import { isHsbcStatement, parseHsbc } from '../../../src/domain/import/hsbc';
import { readPdf } from '../../../src/domain/import/pdf';
import type { Txn } from '../../../src/domain/types';

/**
 * Categorisation audit on REAL statements (same gate as hsbc.real.test.ts): runs the exact import pipeline
 * and prints every merchant with the category it got, so the dictionary can be checked against reality.
 * Prints only; nothing personal is written anywhere.
 */
const dir = process.env.TALLY_SAMPLES;
const files = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /Basic Bank_Statement\.pdf$/i.test(f)).sort() : [];
const money = (p: number) => `£${(Math.abs(p) / 100).toFixed(2)}`;

describe.skipIf(files.length === 0)('categorisation audit on real statements', () => {
  it('prints every merchant and its category', async () => {
    const pdfjs = await import(/* @vite-ignore */ 'pdfjs-dist/legacy/build/pdf.mjs');
    const cats = toCatMap(DEFAULT_CATEGORIES);
    let all: Txn[] = [];
    const holders: string[] = [];
    for (const f of files) {
      const pages = await readPdf(new Uint8Array(fs.readFileSync(path.join(dir!, f))), pdfjs as never);
      expect(isHsbcStatement(pages)).toBe(true);
      const s = parseHsbc(pages);
      if (s.account.holder && !holders.includes(s.account.holder)) holders.push(s.account.holder);
      all = all.concat(buildTxns(s, 'acct', f, { rules: [], holders }));
    }
    const seen = new Set<string>();
    all = all.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
    const asOf = all.reduce((m, t) => (t.date > m ? t.date : m), all[0]!.date);
    for (const p of [...incomePatternPatches(all, cats, asOf), ...rentPatternPatches(all, cats, asOf)]) {
      const t = all.find((x) => x.id === p.id);
      if (t) Object.assign(t, p.patch);
    }

    const groups = new Map<string, Txn[]>();
    for (const t of all) groups.set(`${t.amount < 0 ? 'out' : 'in'}:${t.mkey}`, [...(groups.get(`${t.amount < 0 ? 'out' : 'in'}:${t.mkey}`) ?? []), t]);
    const rows = [...groups.entries()]
      .map(([key, ts]) => ({
        key, n: ts.length, total: ts.reduce((s, t) => s + t.amount, 0), merchant: ts[0]!.merchant,
        cat: ts[0]!.categoryId, src: ts[0]!.catSource, conf: Math.min(...ts.map((t) => t.confidence)), types: [...new Set(ts.map((t) => t.type))].join('/'),
        raw: ts[0]!.raw, detail: [...new Set(ts.map((t) => t.detail))].slice(0, 3).join(' || '),
      }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
    const lines = [`${all.length} transactions, ${rows.length} merchants, ${all[0]!.date}→${asOf}`];
    for (const r of rows) lines.push(`${r.key.startsWith('in') ? 'IN ' : 'OUT'} ${String(r.n).padStart(3)}× ${money(r.total).padStart(10)}  ${r.cat.padEnd(14)} ${r.src.padEnd(10)} ${r.conf.toFixed(2)}  ${r.types.padEnd(7)} ${r.merchant}  ⟨${r.raw}⟩ ${r.detail ? `[${r.detail}]` : ''}`);
    lines.push('--- recurring ---');
    for (const r of detectRecurring(all, cats, asOf)) lines.push(`${r.direction} ${r.cadence.padEnd(11)} ${money(r.amount).padStart(9)} ${r.merchant} (${r.categoryId}) ×${r.dates.length} next ${r.nextDate}`);
    const inc = buildIncomeProfile(all, cats, detectRecurring(all, cats, asOf), asOf);
    lines.push('--- income ---', JSON.stringify({ streams: inc.streams.map((s) => [s.label, s.cadence, money(s.amount), s.dates.length]), expectedMonthly: money(inc.expectedMonthly), irregularMonthly: money(inc.irregularMonthly) }));
    // TALLY_AUDIT_OUT=<file> writes the table there (outside the repo) when the runner swallows console output.
    if (process.env.TALLY_AUDIT_OUT) {
      fs.writeFileSync(process.env.TALLY_AUDIT_OUT, lines.join('\n'));
      const every = [...all].sort((a, b) => a.date.localeCompare(b.date)).map((t) => `${t.date} ${t.type.padEnd(4)} ${(t.amount < 0 ? '-' : '+') + money(t.amount).padStart(9)} ${t.categoryId.padEnd(14)} ${t.merchant} ⟨${t.raw}⟩`);
      fs.writeFileSync(`${process.env.TALLY_AUDIT_OUT}.all.txt`, every.join('\n'));
    }
    else console.log(lines.join('\n'));
    expect(all.length).toBeGreaterThan(0);
  });
});
