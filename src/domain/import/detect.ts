import { parseCsvRows, analyseCsv } from './csv';
import type { CsvAnalysis } from './csv';
import { isHsbcStatement, parseHsbc } from './hsbc';
import { parseOfx } from './ofx';
import { readPdfInBrowser } from './pdf';
import { parseQif } from './qif';
import { isRevolutStatement, parseRevolut } from './revolut';
import { ImportError } from './types';
import type { ParsedStatement } from './types';

/** What we could read from a dropped file. CSVs keep their raw rows so the user can adjust the column mapping. */
export interface FileRead {
  parsed: ParsedStatement | null;
  csv?: CsvAnalysis;
}

export const ACCEPTED = '.pdf,.csv,.ofx,.qfx,.qif,.txt';

export async function readStatementFile(file: File, bytes: ArrayBuffer): Promise<FileRead> {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  const label = file.name.replace(/\.[^.]+$/, '');
  const text = () => new TextDecoder('utf-8').decode(bytes);

  if (ext === 'pdf') {
    const pages = await readPdfInBrowser(bytes);
    if (!pages.some((p) => p.length)) throw new ImportError('This PDF has no readable text. Scanned (image-only) statements are not supported — download the PDF from online banking instead, or export a CSV.');
    if (isHsbcStatement(pages)) return { parsed: parseHsbc(pages) };
    if (isRevolutStatement(pages)) return { parsed: parseRevolut(pages) };
    throw new ImportError('This PDF layout is not recognised yet. PDFs from HSBC UK and Revolut are supported. For other banks, download a CSV, OFX or QIF instead.');
  }
  if (ext === 'ofx' || ext === 'qfx') return { parsed: parseOfx(text()) };
  if (ext === 'qif') return { parsed: parseQif(text(), label) };
  if (ext === 'csv' || ext === 'txt') {
    const csv = analyseCsv(text());
    return { parsed: csv.confident ? parseCsvRows(csv.rows, csv.mapping, label) : null, csv };
  }
  throw new ImportError(`.${ext} files are not supported. Use PDF (HSBC or Revolut), CSV, OFX or QIF.`);
}
