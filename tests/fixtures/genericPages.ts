import type { PdfItem, PdfPage } from '../../src/domain/import/types';

/**
 * Invented PDF statements in several layouts that no dedicated parser knows.
 * No real person, account or merchant data: names, numbers and amounts are made up.
 */
export const text = (x: number, y: number, str: string): PdfItem => ({ str, x, y, w: str.length * 5 });
export const money = (edge: number, y: number, str: string): PdfItem => {
  const w = str.length * 5.2;
  return { str, x: edge - w, y, w };
};

interface R { date?: string; desc?: string; out?: string; in?: string; amt?: string; bal?: string }
const COL = { out: 400, in: 470, amt: 450, bal: 550 };

function table(top: number, rows: R[], step = 14): PdfItem[] {
  const items: PdfItem[] = [];
  rows.forEach((r, i) => {
    const y = top - i * step;
    if (r.date) items.push(text(50, y, r.date));
    if (r.desc) items.push(text(120, y, r.desc));
    if (r.out) items.push(money(COL.out, y, r.out));
    if (r.in) items.push(money(COL.in, y, r.in));
    if (r.amt) items.push(money(COL.amt, y, r.amt));
    if (r.bal) items.push(money(COL.bal, y, r.bal));
  });
  return items;
}

/** Headed "Money out / Money in / Balance", full dates, continuation lines below the amount, two pages. */
export function headedStatement(): PdfPage[] {
  const header = (y: number) => [text(50, y, 'Date'), text(120, y, 'Description'), text(360, y, 'Money out'), text(432, y, 'Money in'), text(515, y, 'Balance')];
  const p1 = [
    text(50, 800, 'Barclays Bank UK PLC'),
    text(50, 770, 'Account number 87654321'), text(300, 770, 'Sort code 11-22-33'),
    ...header(700),
    ...table(686, [
      { date: '01/03/2026', desc: 'Opening balance', bal: '500.00' },
      { date: '02/03/2026', desc: 'CARD PAYMENT TO GREGGS', out: '3.50', bal: '496.50' },
      { desc: 'ON 01 MAR' },
      { date: '03/03/2026', desc: 'SALARY ACME LTD', in: '1,200.00', bal: '1,696.50' },
      { date: '05/03/2026', desc: 'DIRECT DEBIT EE', out: '20.00', bal: '1,676.50' },
      { date: '05/03/2026', desc: 'TFR TO SAVINGS', out: '100.00', bal: '1,576.50' },
    ]),
    text(50, 60, 'Barclays Bank UK PLC is authorised by the Prudential Regulation Authority'),
  ];
  const p2 = [
    ...header(760),
    ...table(746, [
      { date: '07/03/2026', desc: 'AMAZON MARKETPLACE', out: '12.99', bal: '1,563.51' },
      { date: '08/03/2026', desc: 'REFUND AMAZON', in: '12.99', bal: '1,576.50' },
      { desc: 'Closing balance', bal: '1,576.50' },
    ]),
  ];
  return [p1, p2];
}

/** No headings, one signed amount column, dates without a year across New Year. */
export function signedNoYear(opts: { descending?: boolean } = {}): PdfPage[] {
  const rows: R[] = [
    { date: '30 Dec', desc: 'COFFEE SHOP', amt: '-4.20', bal: '995.80' },
    { date: '31 Dec', desc: 'PAYMENT FROM A FRIEND', amt: '50.00', bal: '1,045.80' },
    { date: '2 Jan', desc: 'TRAIN TICKET', amt: '-12.40', bal: '1,033.40' },
    { date: '3 Jan', desc: 'SUPERMARKET', amt: '-33.40', bal: '1,000.00' },
  ];
  return [[
    text(50, 800, 'Monzo Bank Limited'),
    text(50, 770, 'Statement period: 30 December 2025 - 3 January 2026'),
    ...table(700, opts.descending ? [...rows].reverse() : rows),
  ]];
}

/** Headed "Amount / Balance" where amounts carry no sign at all. */
export function unsignedAmounts(): PdfPage[] {
  return [[
    text(50, 800, 'Statement 2026'),
    text(50, 700, 'Date'), text(120, 700, 'Details'), text(415, 700, 'Amount'), text(515, 700, 'Balance'),
    ...table(686, [
      { date: '10 Apr 2026', desc: 'Balance brought forward', bal: '200.00' },
      { date: '11 Apr 2026', desc: 'GROCER', amt: '25.00', bal: '175.00' },
      { date: '12 Apr 2026', desc: 'WAGES', amt: '900.00', bal: '1,075.00' },
      { date: '14 Apr 2026', desc: 'RENT', amt: '700.00', bal: '375.00' },
    ]),
  ]];
}

/** No headings at all: out, in and balance columns must be worked out from the balance. */
export function unlabelled(): PdfPage[] {
  return [[
    text(50, 800, 'Your statement, May 2026'),
    ...table(700, [
      { date: '01 May 26', desc: 'POCKET MONEY IN', in: '40.00', bal: '140.00' },
      { date: '02 May 26', desc: 'CINEMA', out: '9.50', bal: '130.50' },
      { date: '04 May 26', desc: 'BOOKS', out: '15.00', bal: '115.50' },
      { date: '06 May 26', desc: 'SOLD BIKE', in: '60.00', bal: '175.50' },
    ]),
  ]];
}

/** "Money in/out" (one signed column), a fee column that is usually 0.00, and an always-zero tax column. */
export function signedWithFees(): PdfPage[] {
  const row = (y: number, date: string, desc: string, amt: string, bal: string, fee: string) => [
    text(40, y, date), text(125, y, desc), money(368, y, amt), money(411, y, bal), money(449, y, '£0.00'), money(554, y, fee),
  ];
  return [[
    text(40, 800, 'Kroo Bank Ltd'),
    text(343, 712, 'Money in/out'),
    text(40, 700, 'Date'), text(125, 700, 'Description'), text(385, 700, 'Balance'), text(428, 700, 'Tax withheld'), text(536, 700, 'Fees'),
    ...row(686, '3 Feb 2026', 'Top up', '£100.00', '£150.00', '£0.00'),
    ...row(672, '4 Feb 2026', 'Cafe', '-£3.20', '£146.80', '£0.00'),
    ...row(658, '6 Feb 2026', 'Cash abroad', '-£20.00', '£125.80', '£1.00'),
    ...row(644, '7 Feb 2026', 'Bookshop', '-£9.80', '£116.00', '£0.00'),
  ]];
}

/** Headed but with no balance column: readable, never provable. */
export function noBalance(): PdfPage[] {
  return [[
    text(50, 700, 'Date'), text(120, 700, 'Description'), text(360, 700, 'Paid out'), text(435, 700, 'Paid in'),
    ...table(686, [
      { date: '01/06/2026', desc: 'GYM', out: '30.00' },
      { date: '02/06/2026', desc: 'INTEREST', in: '0.12' },
      { date: '03/06/2026', desc: 'PHONE', out: '10.50' },
    ]),
  ]];
}
