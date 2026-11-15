import { parseCsvRows, analyseCsv } from './csv';
import type { CsvAnalysis } from './csv';
import { isHsbcStatement, parseHsbc } from './hsbc';
import { analysePdf } from './generic';
import type { PdfAnalysis, PdfLayout } from './generic';
import { parseOfx } from './ofx';
import { readPdfInBrowser } from './pdf';
import { parseQif } from './qif';
import { isRevolutStatement, parseRevolut } from './revolut';
import { ImportError } from './types';
import type { ParsedStatement } from './types';

/**
 * What we could read from a dropped file. CSVs and unknown PDFs keep what the reader found,
 * so the user can confirm or adjust the columns.
 */
export interface FileRead {
  parsed: ParsedStatement | null;
  csv?: CsvAnalysis;
  pdf?: PdfAnalysis;
}

export const ACCEPTED = '.pdf,.csv,.ofx,.qfx,.qif,.txt';

export async function readStatementFile(file: File, bytes: ArrayBuffer, layouts: PdfLayout[] = []): Promise<FileRead> {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  const label = file.name.replace(/\.[^.]+$/, '');
  const text = () => new TextDecoder('utf-8').decode(bytes);

  if (ext === 'pdf') {
    const pages = await readPdfInBrowser(bytes);
    if (!pages.some((p) => p.length)) throw new ImportError('This PDF has no readable text. Scanned (image-only) statements are not supported — download the PDF from online banking instead, or export a CSV.');
    if (isHsbcStatement(pages)) return { parsed: parseHsbc(pages) };
    if (isRevolutStatement(pages)) return { parsed: parseRevolut(pages) };
    // Any other bank: read the table generically. Only a reading the printed balance proves goes straight through.
    const pdf = analysePdf(pages, { saved: layouts });
    return { parsed: pdf.result.verified ? pdf.result.parsed : null, pdf };
  }
  if (ext === 'ofx' || ext === 'qfx') return { parsed: parseOfx(text()) };
  if (ext === 'qif') return { parsed: parseQif(text(), label) };
  if (ext === 'csv' || ext === 'txt') {
    const csv = analyseCsv(text());
    return { parsed: csv.confident ? parseCsvRows(csv.rows, csv.mapping, label) : null, csv };
  }
  throw new ImportError(`.${ext} files are not supported. Use a PDF, CSV, OFX or QIF statement.`);
}
