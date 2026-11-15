import type { PdfItem, PdfPage } from '../../src/domain/import/types';

/**
 * Invented statements in the layouts Nigerian banks and wallets use. Names, numbers and amounts are made up;
 * only the geometry and wording style follow the real thing (see docs/07-regions.md).
 */
const t = (x: number, y: number, str: string): PdfItem => ({ str, x, y, w: str.length * 3 });
const m = (edge: number, y: number, str: string): PdfItem => ({ str, x: edge - str.length * 4, y, w: str.length * 4 });
const naira = (x: number, y: number, amount: string): PdfItem[] => [t(x, y, '₦'), t(x + 3.5, y, amount)];

/**
 * A wallet app: label-over-value summary boxes, "date time" + value date, descriptions wrapped above and below the
 * amount row, "--" in empty cells, a reference column, a same-minute pair printed in the wrong order, and a second
 * account (the savings pot) in the same PDF.
 */
export function walletStatement(): PdfPage[] {
  const header = (y: number): PdfItem[] => [
    t(20, y, 'Trans. Time'), t(90, y, 'Value Date'), t(135, y, 'Description'),
    t(260, y, 'Debit(₦)'), t(300, y, 'Credit(₦)'), t(340, y, 'Balance After(₦)'), t(400, y, 'Channel'), t(440, y, 'Transaction Reference'),
  ];
  const block = (y: number, when: string, above: string | null, onRow: string | null, below: string | null, debit: string | null, credit: string | null, bal: string, ref: string): PdfItem[] => [
    ...(above ? [t(135, y + 6, above)] : []),
    t(20, y, when), t(90, y, when.slice(0, 11)),
    ...(onRow ? [t(135, y, onRow)] : []),
    debit ? m(290, y, debit) : t(262, y, '--'),
    credit ? m(330, y, credit) : t(302, y, '--'),
    m(390, y, bal), t(400, y, 'Mobile'), t(440, y, ref),
    ...(below ? [t(135, y - 6, below)] : []),
  ];
  const summary = (top: number, open: string, close: string, out: string, nOut: string, inn: string, nIn: string): PdfItem[] => [
    t(66, top, 'Opening Balance'), t(224, top, 'Total Debit'), t(383, top, 'Debit Count'),
    ...naira(66, top - 10, open), ...naira(224, top - 10, out), t(383, top - 10, nOut),
    t(66, top - 36, 'Closing Balance'), t(224, top - 36, 'Total Credit'), t(383, top - 36, 'Credit Count'),
    ...naira(66, top - 46, close), ...naira(224, top - 46, inn), t(383, top - 46, nIn),
  ];
  const p1: PdfItem[] = [
    t(240, 690, 'Account Statement'),
    t(66, 646, 'Account Name'), t(224, 646, 'Account Number'),
    t(66, 635, 'ADA EXAMPLE OKAFOR'), t(224, 635, '9012345678'),
    t(66, 580, 'Wallet Account'), t(224, 580, 'Period: 01 Mar 2026 - 02 Mar 2026'),
    ...summary(551, '0.00', '0.00', '6,000.00', '2', '6,000.00', '2'),
    ...header(464),
    ...block(437, '01 Mar 2026 09:00:01', 'Transfer from CHIDI TEST', null, '| OPay | 801****111', null, '5,000.00', '5,000.00', '260301000001'),
    ...block(410, '01 Mar 2026 09:01:10', null, 'Auto-save to OWealth Balance', null, '5,000.00', null, '0.00', '260301000002'),
    // Printed in the wrong order: the transfer comes before the savings withdrawal that paid for it.
    ...block(383, '02 Mar 2026 12:42:26', 'Transfer to SAMPLE STORES LTD', null, '| Moniepoint | 5012345678', '1,000.00', null, '0.00', '260302000003'),
    ...block(356, '02 Mar 2026 12:42:33', null, 'OWealth Withdrawal(Transaction Payment)', null, null, '1,000.00', '1,000.00', '260302000004'),
  ];
  const p2: PdfItem[] = [
    t(66, 656, 'Savings Account'), t(224, 656, 'Period: 01 Mar 2026 - 02 Mar 2026'),
    ...summary(628, '100.00', '4,100.50', '1,000.00', '1', '5,000.50', '2'),
    ...header(541),
    ...block(513, '01 Mar 2026 01:14:29', null, 'OWealth Interest Earned', null, null, '0.50', '100.50', 'X10001'),
    ...block(486, '01 Mar 2026 09:01:10', null, 'Auto-save to OWealth Balance', null, null, '5,000.00', '5,100.50', 'X10002'),
    ...block(459, '02 Mar 2026 12:42:33', 'OWealth Withdrawal', null, '(Transaction Payment)', '1,000.00', null, '4,100.50', 'X10003'),
  ];
  return [p1, p2];
}

/**
 * A bank statement with dates split over two lines ("03-Mar-" above "2026"), a reference column left of the
 * details, a summary whose printed opening balance is really the balance after the first row, and a transfer
 * followed by its COMM and VAT charges, all three sharing one reference.
 */
export function bankStatement(): PdfPage[] {
  const row = (y: number, day: string, ref: string, details: string, credit: string | null, debit: string | null, bal: string): PdfItem[] => [
    t(19, y + 6, `${day}-`), t(64, y, ref), t(134, y, details),
    ...(credit ? [m(458, y, credit)] : []), ...(debit ? [m(510, y, debit)] : []), m(560, y, bal),
    t(19, y - 6, '2026'),
  ];
  return [[
    t(13, 733, 'Account Statement'),
    t(13, 684, 'Account Name'), t(13, 662, 'Ada Example'),
    t(13, 584, 'Account Number'), t(13, 570, '0123456789'),
    t(39, 453, 'Opening Balance'), t(168, 453, 'Closing Balance'), t(292, 453, 'Start Date'), t(403, 453, 'End Date'),
    ...naira(39, 439, '8,000.00'), ...naira(168, 439, '12,989.25'), t(292, 439, '01-Mar-2026'), t(403, 439, '31-Mar-2026'),
    t(21, 393, 'Date'), t(136, 393, 'Transaction Details'), t(431, 393, 'Credit(₦)'), t(482, 393, 'Debit(₦)'), t(531, 393, 'Balance(₦)'),
    ...row(358, '03-Mar', 'S1000001', 'POS Buy on 03-03-2026@Psk*AB1-Spotify', null, '2,000.00', '8,000.00'),
    ...row(321, '05-Mar', 'S1000002', 'NIP:TEST PERSON ONE-Rent share', '10,000.00', null, '18,000.00'),
    ...row(284, '06-Mar', 'S1000003', 'ALAT NIP TRANSFER TO SAMPLE PERSON TWO FROM ADA EXAMPLE', null, '5,000.00', '13,000.00'),
    ...row(247, '06-Mar', 'S1000003', 'COMM ALAT NIP TRANSFER TO SAMPLE PERSON TWO FROM ADA EXAMPLE', null, '10.00', '12,990.00'),
    ...row(210, '06-Mar', 'S1000003', 'VAT ALAT NIP TRANSFER TO SAMPLE PERSON TWO FROM ADA EXAMPLE', null, '0.75', '12,989.25'),
    t(13, 120, 'alat.ng | wemabank.com'),
  ]];
}
