import type { PdfPage } from './types';

/** The slice of the pdf.js API we use, so Node tests can inject the legacy build. */
interface PdfJs {
  getDocument(src: { data: Uint8Array; useSystemFonts?: boolean; isEvalSupported?: boolean }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{
        getTextContent(): Promise<{ items: Array<{ str?: string; transform?: number[]; width?: number }> }>;
      }>;
    }>;
  };
}

/** Extract positioned text from every page of a text-based PDF. */
export async function readPdf(data: Uint8Array, pdfjs: PdfJs): Promise<PdfPage[]> {
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
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
 */
export async function readPdfInBrowser(buf: ArrayBuffer): Promise<PdfPage[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const worker = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  return readPdf(new Uint8Array(buf), pdfjs as unknown as PdfJs);
}
