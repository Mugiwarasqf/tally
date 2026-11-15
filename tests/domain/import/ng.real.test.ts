import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analysePdfSections } from '../../../src/domain/import/generic';
import { readPdf } from '../../../src/domain/import/pdf';
import { setRegion } from '../../../src/lib/region';

/**
 * Runs the generic reader, in the Nigeria region, on REAL statements on this machine. Skipped unless
 * TALLY_NG_SAMPLES points at a folder of PDFs (statements only, never committed). Every account in every file must
 * be proved by its running balance. Only counts are logged, never names, descriptions or amounts.
 * Password-protected PDFs are skipped (not supported yet).
 */
const dir = process.env.TALLY_NG_SAMPLES;
const files = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.pdf$/i.test(f)) : [];

describe.skipIf(files.length === 0)('generic PDF reader on real Nigerian statements', () => {
  beforeAll(() => { setRegion('ng'); });
  afterAll(() => { setRegion('uk'); });
  files.forEach((f, i) => {
    it(`reads and proves statement #${i + 1}`, async () => {
      const pdfjs = await import(/* @vite-ignore */ 'pdfjs-dist/legacy/build/pdf.mjs');
      let pages;
      try {
        pages = await readPdf(new Uint8Array(fs.readFileSync(path.join(dir!, f))), pdfjs as never);
      } catch (e) {
        if (String(e).includes('Password')) { console.log(`#${i + 1}: password-protected, skipped`); return; }
        throw e;
      }
      for (const a of analysePdfSections(pages)) {
        const p = a.result.parsed;
        console.log(`#${i + 1}: ${a.bank || 'unknown bank'} ${a.account.label ?? ''} | ${p.txns.length} txns | blocks=${a.blocks} | ${p.checks.map((c) => `${c.name}: ${c.ok}`).join('; ')}`);
        expect(a.result.verified, a.result.reason).toBe(true);
      }
    });
  });
});
