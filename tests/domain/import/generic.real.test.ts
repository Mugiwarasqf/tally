import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analysePdf } from '../../../src/domain/import/generic';
import { isHsbcStatement, parseHsbc } from '../../../src/domain/import/hsbc';
import { readPdf } from '../../../src/domain/import/pdf';
import { isRevolutStatement, parseRevolut } from '../../../src/domain/import/revolut';

/**
 * Pretends Tally has no dedicated reader and runs the generic one on REAL statements on this
 * machine, comparing every amount with what the dedicated parser reads. Skipped unless
 * TALLY_SAMPLES points at a folder of PDFs, so no personal data ever needs to live in the repo.
 * Only counts are logged, never descriptions or amounts.
 */
const dir = process.env.TALLY_SAMPLES;
const files = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /statement.*\.pdf$/i.test(f)) : [];

describe.skipIf(files.length === 0)('generic PDF reader on real statements', () => {
  for (const f of files) {
    it(`matches the dedicated parser on ${f}`, async () => {
      const pdfjs = await import(/* @vite-ignore */ 'pdfjs-dist/legacy/build/pdf.mjs');
      const pages = await readPdf(new Uint8Array(fs.readFileSync(path.join(dir!, f))), pdfjs as never);
      const known = isHsbcStatement(pages) ? parseHsbc(pages) : isRevolutStatement(pages) ? parseRevolut(pages) : null;
      const a = analysePdf(pages);
      const got = a.result.parsed.txns.map((t) => `${t.date} ${t.amount}`);
      const want = known?.txns.map((t) => `${t.date} ${t.amount}`) ?? [];
      const missing = want.filter((x) => !got.includes(x)).length;
      const extra = got.filter((x) => !want.includes(x)).length;
      console.log(`${f}: ${known?.bank ?? 'unknown'} | generic ${got.length} txns vs ${want.length} | verified=${a.result.verified} | roles=${a.roles.join('/')} | anchor=${a.anchor} | missing=${missing} extra=${extra} | ${a.result.reason ?? 'ok'}`);
      if (known) {
        expect(missing).toBe(0);
        expect(extra).toBe(0);
      }
    });
  }
});
