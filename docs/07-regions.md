# Regions: UK, Nigeria, US

Tally started as a UK, pounds-only app. This note records how it now works for people banking in Nigeria (naira) or the US (dollars), and what was learned from real Nigerian statements.

## Case study

| Who | How they handle currency and country | Lesson for Tally |
|---|---|---|
| **YNAB** | Currency, number format and date format are chosen once per plan, at creation, and can be changed in plan settings. Amounts are never converted. | One currency per budget, picked up front, editable later. |
| **Actual Budget** | A per-budget currency and number/date format setting. Multi-currency is not supported; people keep one budget per currency. | Mixing currencies in one set of totals is the thing to avoid. Refuse it rather than convert. |
| **Wallet (BudgetBakers), Spendee** | Ask for a base currency on first run, guessed from the device. | Ask on first run, with a sensible pre-selection. |
| **Nigerian banking apps** (OPay, ALAT, Kuda, GTBank) | Statements are PDFs, often with bank charges (COMM, VAT, stamp duty, SMS alerts) as separate rows, and transfers named "NIP transfer to … from …". | Charges and transfer narrations need their own reading, or every transfer looks like an unknown merchant. |

**Decision.** One region per device: **UK (£)**, **Nigeria (₦)** or **US ($)**, chosen on the first screen (pre-selected from the device's time zone, read locally) and changeable in Settings. The region sets:

- the currency sign everywhere (`fmt`, charts, inputs);
- how an ambiguous date such as 03/04 is read (US: March 4; UK and Nigeria: 3 April);
- the size of "everyday" amounts used by heuristics (`everyday()` in `src/lib/region.ts`): a "small purchase" is under £5, $5 or ₦5,000; budgets round to £5, $5 or ₦5,000;
- which merchant pack is checked first (`REGION_DICTIONARY`), and, in Nigeria, the narration reader below.

Amounts are never converted. A statement whose own text is in another currency is stopped at import, with a button to switch region.

## Nigerian statements: what the generic PDF reader had to learn

From one ALAT (Wema) and one OPay statement, read on the maintainer's machine only. Each is handled generally, not as a per-bank parser:

| Seen | Handled by |
|---|---|
| `02 Nov 2026 11:04:01` (date and time), then a value date | The time is kept on the transaction; the second date is skipped. |
| `03-Aug-` with `2026` on the line below | Dates split over two lines are joined. |
| Description wrapped above **and** below the row with the amounts | "Blocks": when row gaps split into "inside a transaction" and "between transactions", and no block holds two amounts, each block is one transaction. Rare gap sizes are ignored when finding the split. |
| `--` in empty money cells; Channel and Reference columns | Blank cells are dropped; only text under the Description heading is the description; the reference column becomes the transaction's `ref`. |
| Summary boxes with labels above values (Opening Balance / Total Debit / Debit Count) | Values are read from the row below, lined up under each label. Those rows are kept out of the table. |
| Printed totals and counts | A second proof next to the running balance ("Printed totals agree"). |
| Rows from the same minute printed in the wrong order (a payment before the top-up that funded it) | When a balance doesn't follow but one of the next few same-day rows' does, that row is moved first. Only an exact balance match moves anything. |
| A printed opening balance that is really the balance after the first row | If starting from the first row makes every later balance and the closing balance agree, the rows are trusted and a warning says so. |
| Wallet and savings accounts in one PDF | Each "summary box with an opening balance" after transactions starts a new account; each gets its own card on the Import page and its own account. |
| Bank named only in a footer web address (`alat.ng`), or not at all (OPay, identified by its "OWealth" product) | Web-address keys match anywhere; product names are a last resort. |

Result on those statements: ALAT 55 transactions, OPay 237 (wallet) + 130 (savings), every one proved by the running balance, the closing balance and the printed totals and counts.

Later, one GTBank and one Zenith statement (unlocked) added two more layouts:

| Seen | Handled by |
|---|---|
| GTBank: the Remarks column sits right of Balance and Originating Branch, wraps over up to four lines, and the dates and amounts are centred in the cell, half a line from the remark lines | Block cuts now also try gentler gap jumps (1.4× and up), but only when at least half the rows are tall cells, and prefer the cut that leaves the fewest text lines without an amount. A one-line-per-row table (Halifax) is unaffected. |
| Zenith: a credit amount and its value date come out of the PDF as one piece of text ("6.18 01/10/2026") | An amount and a date in one item are split back into two cells. |

GTBank (5) and Zenith (3) are both proved by the running balance.

## Nigerian narrations (`src/domain/categorize/narration.ts`)

Only used in the Nigeria region. It turns the wording into the payment types the categoriser already knows:

- **Charges**: COMM, VAT, stamp duty, EMTL, SMS alerts, card and account maintenance → *Fees & charges*, each a clearly named merchant. A charge is linked to the payment it was taken on (same bank reference, or a same-day payment whose description it repeats), shown as "On …" in its details.
- **Interest** (`Int.Pd`, "Interest Earned", "Capitalized interest") and registrar **dividends** (`DIV PYT`) → *Interest*; **withholding tax** (`WTax.Pd`, also Zenith's spelling "WITHOLDING") → *Fees & charges*. GTBank's "VALUE ADDED TAX SMS ALERT CHARGE" is the SMS charge; "VALUE ADDED TAX VAT CHARGES" is the VAT on it.
- **Transfers** (`NIP TRANSFER TO X FROM Y`, `NIP:NAME-note`, `Transfer to NAME | Bank | account`): the other person's name becomes the payee, so your own accounts are recognised and payments to people go to the review queue once.
- **Savings pots** (OWealth, CashBox, auto-save) → own-account transfers.
- **Airtime, data, betting, electricity** bill payments are named by network or provider.
- **POS agents** ("Transfer to POS Transfer - NAME"): cash or a shop? Always asked once.
- **Reversals**: the money that came back takes the category of the payment it reverses, so the two cancel out.

## Locked PDFs and Excel statements

- **Password-protected PDFs** (GTBank and Zenith email them locked). pdf.js opens them itself when given the password, so no new code reads the encryption. The Import card asks for the password, says plainly when it is wrong, and passes it to pdf.js for that one read. It is never saved, logged or sent. Tested with an invented locked fixture (`tests/fixtures/locked.pdf`, password `open-sesame`).
- **Excel** (`src/domain/import/sheet.ts`, no library). Banks' "Excel" downloads come in three shapes, and each becomes rows of text that go through the same column detection as CSV:
  - `.xlsx`: a zip of XML, unzipped with the browser's own `DecompressionStream`. Shared strings, inline strings and date-formatted cells (turned back from Excel day numbers) are handled, and float noise such as `8495.470000000001` is rounded to pence.
  - `.xls` that is really an HTML table, or an XML Spreadsheet 2003 file: read as text.
  - Genuine old binary `.xls`: the user is asked to save it as `.xlsx` or CSV. A BIFF parser would add a large dependency for a format banks have mostly dropped.
- CSV and Excel header detection now looks through the first 40 rows (exports often start with an account summary) and knows "Trans Date", "Narration" and "Remarks". A spreadsheet's currency is detected from its text, like a PDF's.

## Limits

- GTBank and Zenith were checked on one short statement each (few transactions, mostly charges and interest). Transfers and card payments in those layouts are read by the general rules but not yet seen in a real file.
- One currency per device; a dollar account held by a Nigerian user is not supported.
