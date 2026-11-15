import type { PdfPage } from './types';
import { PasswordNeeded } from './types';

/** The slice of the pdf.js API we use, so Node tests can inject the legacy build. */
interface PdfJs {
  getDocument(src: { data: Uint8Array; password?: string; useSystemFonts?: boolean; isEvalSupported?: boolean }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{
        getTextContent(): Promise<{ items: Array<{ str?: string; transform?: number[]; width?: number }> }>;
      }>;
    }>;
  };
}

/**
 * Extract positioned text from every page of a text-based PDF.
 *
 * Many Nigerian banks (GTBank, Zenith) email statements locked with a password. pdf.js opens those itself when
 * given the password; it is used for this one read and never stored. A locked file, or a wrong password,
 * comes back as `PasswordNeeded` so the page can ask.
 */
export async function readPdf(data: Uint8Array, pdfjs: PdfJs, password?: string): Promise<PdfPage[]> {
  let doc;
  try {
    doc = await pdfjs.getDocument({ data, password, useSystemFonts: true, isEvalSupported: false }).promise;
  } catch (e) {
    // pdf.js: code 1 = a password is needed, code 2 = the one given is wrong.
    const err = e as { name?: string; code?: number };
    if (err?.name === 'PasswordException') throw new PasswordNeeded(err.code === 2);
    throw e;
  }
  const pages: PdfPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .filter((it) => typeof it.str === 'string' && it.str.trim() !== '' && it.transform)
        .map((it) => ({ str: it.str!, x: it.transform![4]!, y: it.transform![5]!, w: it.width ?? 0 })),
    );
  }
  return pages;
}

/**
 * Browser entry point. pdf.js and its worker load lazily — only when a PDF is dropped.
 * The legacy build is used on purpose: the modern one calls very new JavaScript
 * (Map.getOrInsertComputed, Math.sumPrecise) that iPhone Safari does not have yet,
 * so every PDF failed there. The legacy build carries polyfills for them.
 * The bytes are copied because pdf.js hands its buffer to the worker, and a locked file is read twice.
 */
export async function readPdfInBrowser(buf: ArrayBuffer, password?: string): Promise<PdfPage[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const worker = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  return readPdf(new Uint8Array(buf.slice(0)), pdfjs as unknown as PdfJs, password);
}
