import type { PdfItem, PdfPage } from '../../src/domain/import/types';

/**
 * A fully invented two-page HSBC-style statement, laid out with the same column geometry as
 * the real thing (date x≈52, type x≈112, details x≈139, amounts right-aligned at 397/476/555).
 * No real person, account or merchant data.
 */
const OUT = 397;
const IN = 476;
const BAL = 555;

const text = (x: number, y: number, str: string): PdfItem => ({ str, x, y, w: str.length * 5 });
const money = (edge: number, y: number, str: string): PdfItem => {
  const w = str.length * 5.2;
  return { str, x: edge - w, y, w };
};

const header = (y: number): PdfItem[] => [
  text(52, y, 'Date'), text(116, y, 'Payment type and details'),
  { str: '£ Paid out', x: 349, y, w: 38 }, { str: '£ Paid in', x: 437, y, w: 33 }, { str: '£ Balance', x: 512, y, w: 36 },
];
const footer = (y: number): PdfItem[] => [text(52, y, 'HSBC UK Bank plc 1 Centenary Square Birmingham')];

export function syntheticHsbc(opts: { breakTotals?: boolean } = {}): PdfPage[] {
  const page1: PdfItem[] = [
    text(438, 790, 'Your Statement'),
    text(52, 700, '20 August to 21 August 2026'),
    text(360, 640, 'Opening Balance'), money(548, 640, '£100.00'),
    text(360, 626, 'Payments In'), money(548, 626, '£1,000.00'),
    text(360, 612, 'Payments Out'), money(548, 612, opts.breakTotals ? '£999.99' : '£245.50'),
    text(360, 598, 'Closing Balance'), money(548, 598, '£854.50'),
    text(52, 560, 'Account Name'), text(356, 560, 'Sortcode'), text(415, 560, 'Account Number'),
    text(52, 548, 'Alex Example'), text(356, 548, '12-34-56'), text(415, 548, '12345678'), text(493, 548, '1'),
    ...header(500),
    text(52, 488, '19 Aug 26'), text(139, 488, 'BALANCE BROUGHT FORWARD'), money(BAL, 488, '100.00'),
    text(52, 476, '20 Aug 26'), text(112, 476, 'CR'), text(139, 476, 'Acme Payroll Ltd'),
    text(139, 464, 'Wages'), money(IN, 464, '1,000.00'),
    text(112, 452, 'VIS'), text(139, 452, 'TESCO STORES 1234'),
    text(139, 440, 'LONDON'), money(OUT, 440, '25.50'), money(BAL, 440, '1,074.50'),
    text(139, 428, 'BALANCE CARRIED FORWARD'), money(BAL, 428, '1,074.50'),
    ...footer(60),
  ];
  const page2: PdfItem[] = [
    ...header(700),
    text(139, 688, 'BALANCE BROUGHT FORWARD'), money(BAL, 688, '1,074.50'),
    // No date here: it carries over from the previous page (20 Aug).
    text(112, 676, 'TFR'), text(139, 676, '112233 12345678'),
    text(139, 664, 'INTERNET TRANSFER'), money(OUT, 664, '200.00'), money(BAL, 664, '874.50'),
    text(52, 652, '21 Aug 26'), text(112, 652, 'ATM'), text(139, 652, 'CASH HALIFAX AUG21'),
    text(139, 640, 'HFX LONDON@17:01'), money(OUT, 640, '20.00'), money(BAL, 640, '854.50'),
    text(139, 628, 'BALANCE CARRIED FORWARD'), money(BAL, 628, '854.50'),
    ...footer(60),
  ];
  const cover: PdfItem[] = [text(60, 700, 'Terms and conditions')];
  return [page1, page2, cover];
}
