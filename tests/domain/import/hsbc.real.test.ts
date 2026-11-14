import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isHsbcStatement, parseHsbc } from '../../../src/domain/import/hsbc';
import { readPdf } from '../../../src/domain/import/pdf';

/**
 * Runs the parser against REAL statements on this machine. Point TALLY_SAMPLES at a
 * folder of HSBC PDFs to enable it; it is skipped everywhere else (CI, other machines)
 * so no personal data ever needs to live in the repo.
 */
const dir = process.env.TALLY_SAMPLES;
const files = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /Basic Bank_Statement\.pdf$/i.test(f)) : [];

describe.skipIf(files.length === 0)('HSBC parser on real statements', () => {
  for (const f of files) {
    it(`reconciles ${f}`, async () => {
      const pdfjs = await import(/* @vite-ignore */ 'pdfjs-dist/legacy/build/pdf.mjs');
      const pages = await readPdf(new Uint8Array(fs.readFileSync(path.join(dir!, f))), pdfjs as never);
      expect(isHsbcStatement(pages)).toBe(true);
      const s = parseHsbc(pages);
      const summary = `${f}: ${s.txns.length} txns, ${s.periodStart}→${s.periodEnd}, checks=${s.checks.map((c) => `${c.ok ? 'OK' : 'FAIL'}[${c.detail}]`).join(' ')} warnings=${s.warnings.join(';')}`;
      console.log(summary);
      expect(s.txns.length).toBeGreaterThan(50);
      for (const c of s.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
    });
  }
});
