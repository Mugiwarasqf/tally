import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toCatMap } from '../../../src/domain/analytics/aggregate';
import { DEFAULT_CATEGORIES } from '../../../src/domain/categorize/categories';
import { buildTxns } from '../../../src/domain/import/build';
import { readPdf } from '../../../src/domain/import/pdf';
import { isRevolutStatement, parseRevolut } from '../../../src/domain/import/revolut';

/**
 * Runs the Revolut parser against REAL statements on this machine (same gate as hsbc.real.test.ts).
 * TALLY_AUDIT_OUT=<file> also writes how each payee was categorised, outside the repo.
 */
const dir = process.env.TALLY_SAMPLES;
const files = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /statement.*\.pdf$/i.test(f)) : [];

describe.skipIf(files.length === 0)('Revolut parser on real statements', () => {
  it('reconciles every Revolut statement found', async () => {
    const pdfjs = await import(/* @vite-ignore */ 'pdfjs-dist/legacy/build/pdf.mjs');
    let seen = 0;
    const lines: string[] = [];
    for (const f of files) {
      const pages = await readPdf(new Uint8Array(fs.readFileSync(path.join(dir!, f))), pdfjs as never);
      if (!isRevolutStatement(pages)) continue;
      seen++;
      const s = parseRevolut(pages);
      lines.push(`${f}: ${s.txns.length} txns, ${s.periodStart}→${s.periodEnd}, holder=${s.account.holder ? 'yes' : 'no'}, number=${s.account.number}, sort=${s.account.sortCode}, opening=${s.opening}, closing=${s.closing}`);
      for (const c of s.checks) lines.push(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.name}: ${c.detail}`);
      for (const w of s.warnings) lines.push(`  warning: ${w}`);
      expect(s.checks.length).toBeGreaterThanOrEqual(2);
      for (const c of s.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);

      const cats = toCatMap(DEFAULT_CATEGORIES);
      const txns = buildTxns(s, 'acct', f, { rules: [], holders: s.account.holder ? [s.account.holder] : [] });
      const groups = new Map<string, typeof txns>();
      for (const t of txns) groups.set(`${t.amount < 0 ? 'out' : 'in'}:${t.mkey}`, [...(groups.get(`${t.amount < 0 ? 'out' : 'in'}:${t.mkey}`) ?? []), t]);
      lines.push('--- payees');
      for (const [k, ts] of [...groups].sort((a, b) => Math.abs(b[1].reduce((x, t) => x + t.amount, 0)) - Math.abs(a[1].reduce((x, t) => x + t.amount, 0)))) {
        const total = ts.reduce((x, t) => x + t.amount, 0);
        lines.push(`${k.startsWith('in') ? 'IN ' : 'OUT'} ${String(ts.length).padStart(3)}× ${(total / 100).toFixed(2).padStart(9)}  ${ts[0]!.categoryId.padEnd(14)} ${ts[0]!.catSource.padEnd(10)} ${ts[0]!.confidence.toFixed(2)} ${ts[0]!.type.padEnd(4)} ${ts[0]!.merchant}  (${cats.get(ts[0]!.categoryId)?.kind})`);
      }
    }
    if (process.env.TALLY_AUDIT_OUT) fs.writeFileSync(process.env.TALLY_AUDIT_OUT, lines.join('\n'));
    expect(seen).toBeGreaterThan(0);
  });
});
