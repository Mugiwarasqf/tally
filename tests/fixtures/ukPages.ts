import type { PdfItem, PdfPage } from '../../src/domain/import/types';

/**
 * Invented statements in two more UK layouts. Names, numbers and amounts are made up; only the geometry
 * follows the real thing.
 */
const t = (x: number, y: number, str: string): PdfItem => ({ str, x, y, w: str.length * 4.5 });
const r = (right: number, y: number, str: string): PdfItem => ({ str, x: right - str.length * 4.5, y, w: str.length * 4.5 });
/** Invisible text in a microscopic font, as accessibility-tagged PDFs add it. */
const ghost = (x: number, y: number, str: string): PdfItem => ({ str, x, y, w: str.length * 0.03 });

/**
 * Accessibility-tagged statement: every visible cell is followed by an invisible ".", hidden column names repeat
 * on every row, a Type column holds payment codes, and page 2 is a key to those codes that looks like a heading.
 */
export function taggedStatement(): PdfPage[] {
  const cell = (x: number, y: number, s: string, right = false): PdfItem[] => {
    const it = right ? r(x, y, s) : t(x, y, s);
    return [it, ghost(it.x + it.w, y, '.')];
  };
  const row = (y: number, date: string, desc: string, type: string, inn: string | null, out: string | null, bal: string): PdfItem[] => [
    ghost(57, y + 9, 'Date'), ghost(122, y + 9, 'Description'), ghost(271, y + 9, 'Type'), ghost(375, y + 9, inn ? 'Money Out (£)' : 'Money In (£)'), ghost(538, y + 9, 'Balance (£)'),
    ghost(inn ? 453 : 375, y + 5, 'blank.'),
    ...cell(57, y, date), ...cell(122, y, desc), ...cell(271, y, type),
    ...(inn ? cell(375, y, inn, true) : []), ...(out ? cell(453, y, out, true) : []), ...cell(538, y, bal, true),
  ];
  return [
    [
      t(57, 810, 'Example Bank'),
      t(306, 722, 'Sort Code'), t(393, 722, '11-22-33'), t(306, 710, 'Account Number'), t(393, 710, '12345678'),
      ...cell(57, 618, 'Money In'), ...cell(291, 618, '£60.00', true), ...cell(304, 618, 'Balance on 01 March 2026'), ...cell(538, 618, '£10.00', true),
      t(57, 563, 'Your Transactions'),
      ...['Column', 'Column', 'Column', 'Column', 'Column', 'Column'].map((s, i) => ghost([57, 122, 271, 375, 453, 538][i]!, 539, s)),
      ...cell(57, 530, 'Date'), ...cell(122, 530, 'Description'), ...cell(271, 530, 'Type'), ...cell(323, 530, 'Money In (£)'), ...cell(393, 530, 'Money Out (£)'), ...cell(490, 530, 'Balance (£)'),
      ...row(505, '01 Mar 26', 'SAMPLE PERSON', 'FPI', '50.00', null, '60.00'),
      ...row(480, '02 Mar 26', 'SAMPLE STORES', 'DEB', null, '12.50', '47.50'),
      ...row(455, '03 Mar 26', 'SAMPLE PERSON', 'FPO', null, '20.00', '27.50'),
      ...row(430, '03 Mar 26', 'SAMPLE EMPLOYER', 'BGC', '10.00', null, '37.50'),
      t(57, 422, '(Continued on next page)'),
    ],
    [
      t(89, 330, 'Transaction types'),
      t(91, 310, 'BGC Bank Giro Credit'), t(250, 310, 'DEP Deposit'), t(400, 310, 'FPI Faster Payment In'),
      t(91, 296, 'FPO Faster Payment Out'), t(250, 296, 'DEB Debit Card'), t(400, 296, 'SO Standing Order'),
      t(89, 270, 'If you think something is incorrect, please contact us'),
    ],
  ];
}

/**
 * Two pages whose tables are printed 9 points apart, a summary box repeated on each page, a heading centred over a
 * description column that starts further left, and continuation lines that begin with a date ("On / 07 Sep").
 */
export function offsetPages(): PdfPage[] {
  const page = (dx: number, rows: Array<[string | null, string, string | null, string | null, string]>, top = 600): PdfItem[] => [
    t(400, 760, 'Opening Balance:'), r(560, 760, '1,000.00'), t(400, 748, 'Closing Balance:'), r(560, 748, '1,009.00'),
    t(50 + dx, 700, 'Date'), t(160 + dx, 700, 'Description'), t(280 + dx, 700, 'Money out'), t(340 + dx, 700, 'Money in'), t(405 + dx, 700, 'Balance'),
    ...rows.flatMap(([date, desc, out, inn, bal], i) => [
      ...(date ? [t(50 + dx, top - i * 14, date)] : []), t(100 + dx, top - i * 14, desc),
      ...(out ? [r(314 + dx, top - i * 14, out)] : []), ...(inn ? [r(368 + dx, top - i * 14, inn)] : []), r(432 + dx, top - i * 14, bal),
    ]),
  ];
  return [
    page(0, [
      ['01 Sep', 'Start Balance', null, null, '1,000.00'],
      ['02 Sep', 'Card Payment to Sample Cafe On', '5.00', null, '995.00'],
      [null, '01 Sep', null, null, '995.00'],
      ['03 Sep', 'Card Payment to Sample Books', '6.00', null, '989.00'],
    ]),
    page(-9, [
      ['05 Sep', 'Received from Sample Ltd', null, '30.00', '1,019.00'],
      ['06 Sep', 'Card Payment to Sample Shop On', '10.00', null, '1,009.00'],
      [null, '05 Sep', null, null, '1,009.00'],
    ]),
  ];
}

/** A US-style statement with no running balance: "+ $" amounts, a beginning and an ending balance. */
export function noBalanceColumn(): PdfPage[] {
  const rows: Array<[string, string, string]> = [
    ['01/11/2026', 'SAMPLE PAYROLL DD', '+ $500.00'], ['01/12/2026', 'SAMPLE GROCERY', '- $42.10'],
    ['01/14/2026', 'ATM WITHDRAWAL', '- $60.00'], ['01/20/2026', 'SAMPLE REFUND', '+ $12.10'],
  ];
  return [[
    t(24, 700, 'Beginning Balance on Jan. 11, 2026'), r(300, 700, '$100.00'),
    t(24, 680, 'Ending Balance on Feb. 10, 2026'), r(300, 680, '$510.00'),
    t(22, 600, 'DATE'), t(97, 600, 'DESCRIPTION'), t(545, 600, 'AMOUNT'),
    ...rows.flatMap(([d, desc, amt], i) => [t(22, 580 - i * 30, d), t(97, 580 - i * 30, desc), r(587, 580 - i * 30, amt)]),
  ]];
}

/**
 * A current account followed by a savings pot in one PDF. Each part starts with its own title; summary values
 * are printed above their labels; the newest transaction comes first; a long description wraps around its row.
 */
export function accountWithPot(): PdfPage[] {
  const head = (y: number) => [t(70, y, 'Date'), t(153, y, 'Description'), t(373, y, '(GBP) Amount'), t(456, y, '(GBP) Balance')];
  const line = (y: number, date: string, desc: string | null, amt: string, bal: string): PdfItem[] => [
    t(70, y, date), ...(desc ? [t(153, y, desc)] : []), r(441, y, amt), r(524, y, bal),
  ];
  const summary = (top: number, pairs: Array<[string, string]>): PdfItem[] => pairs.flatMap(([v, l], i) => [r(532, top - i * 42, v), r(532, top - i * 42 - 14, l)]);
  return [
    [
      t(281, 704, 'Personal Account statement'), t(359, 677, '01/03/2026 - 05/03/2026'),
      t(63, 649, 'Sam Example'),
      ...summary(591, [['£50.00', 'Personal Account balance'], ['-£31.00', 'Total outgoings'], ['+£50.00', 'Total deposits']]),
      t(63, 425, 'Sort code: 11-22-33'), t(63, 411, 'Account number: 87654321'),
      ...head(334),
      ...line(305, '05/03/2026', 'Transfer to Pot', '-1.00', '50.00'),
      t(153, 282, 'SAMPLE FRIEND (Faster Payments)'), ...line(275, '04/03/2026', null, '50.00', '51.00'), t(153, 268, 'Reference: Thanks'),
      t(153, 253, 'SAMPLE MOBILE LIMITED'), ...line(246, '03/03/2026', null, '-10.00', '1.00'), t(153, 239, 'London GBR'),
      ...line(217, '02/03/2026', 'Transfer to Pot', '-20.00', '11.00'),
    ],
    [
      t(407, 704, 'Pot statement'), t(359, 677, '01/03/2026 - 05/03/2026'),
      ...summary(649, [['£121.00', 'Pot balance'], ['£0.00', 'Total outgoings'], ['+£21.00', 'Total deposits']]),
      r(532, 480, 'Rainy Day'), r(532, 466, 'Pot name'),
      ...head(397),
      ...line(367, '05/03/2026', 'Deposit', '1.00', '121.00'),
      ...line(338, '02/03/2026', 'Deposit', '20.00', '120.00'),
    ],
  ];
}

/**
 * An app-bank layout: a Category column ("Merchant", "Top up", "Others"), names that wrap when the next word won't
 * fit before the Category column, "Payment from / Transfer to NAME" wording, and moves to the account's own savings.
 */
export function categoryColumn(): PdfPage[] {
  const row = (y: number, date: string, desc: string, cat: string, amt: string, bal: string): PdfItem[] => [
    t(40, y, date), t(125, y, desc), t(258, y, cat), r(375, y, amt), r(415, y, bal),
  ];
  return [[
    t(40, 700, 'Opening balance'), r(415, 700, '£100.00'), t(40, 688, 'Closing balance'), r(415, 688, '£79.00'),
    t(40, 590, 'Date'), t(125, 590, 'Description'), t(258, 590, 'Category'), t(343, 590, 'Money in/out'), t(385, 590, 'Balance'),
    // 'Payment from SAMPLE SERVICES' ends at 251; 'LTD' (13.5 wide) would not fit before 256, so it wrapped.
    ...row(560, '6 Mar 2026', 'Payment from SAMPLE SERVICES', 'Top up', '£50.00', '£150.00'), t(125, 550, 'LTD'),
    ...row(530, '7 Mar 2026', 'SAMPLE COFFEE', 'Merchant', '-£4.00', '£146.00'), t(125, 520, 'London'),
    ...row(500, '8 Mar 2026', 'Transfer to SAMPLE FRIEND', 'Others', '-£20.00', '£126.00'),
    ...row(480, '9 Mar 2026', 'To GBP Savings', 'Others', '-£50.00', '£76.00'),
    ...row(460, '10 Mar 2026', 'From GBP Savings', 'Others', '£3.00', '£79.00'),
  ]];
}
