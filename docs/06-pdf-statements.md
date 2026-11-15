# PDF statements from any bank

Tally had dedicated readers for HSBC UK and Revolut and turned every other PDF away. This note records the case study behind the generic reader (`src/domain/import/generic.ts`) and how it decides it has read a statement correctly.

## Case study

| Who | What they do with PDFs | Lesson for Tally |
|---|---|---|
| **Actual Budget** | No PDF import. CSV, QIF, OFX, QFX and CAMT only; community tools convert specific banks' PDFs to OFX. ([docs](https://actualbudget.org/docs/transactions/importing)) | Open-source finance apps avoid PDFs because layouts vary. Leaving PDFs out is a real option, but it sends people off to find a converter. |
| **YNAB, Firefly III** | No PDF import either; third-party, usually bank-specific converters fill the gap. One author notes regex-per-bank breaks whenever a bank changes its layout. | Per-bank parsers don't scale and break silently. That is the approach Tally was using. |
| **Tabula / Camelot** (table extractors) | Two modes: *lattice* for tables with ruling lines, *stream* for tables without, which finds columns from the whitespace between text. Tabula also lets the user draw the table area and columns by hand. ([Camelot](https://camelot-py.readthedocs.io/en/latest/user/how-it-works.html), [tabula-py](https://tabula-py.readthedocs.io/en/latest/tabula.html)) | Bank statements are "stream" tables: columns come from where the text sits. When detection fails, the user pointing at the columns is an accepted fallback. |
| **DocuClipper and similar** (paid converters) | Claim template-free extraction with OCR plus "reconciliation". The method isn't published and the accuracy figures are self-reported. | Commercial tools lean on the running balance to catch misreads. Their OCR and cloud upload break Tally's local-only rule. |
| **Published approaches** | Group text into rows by `y`, find columns by clustering `x`, and validate with *previous balance ± amount = new balance*, sending anything that fails to a human. | The balance check is the standard way to make extraction trustworthy. |

**Decision.** Use a stream-style generic reader that proves itself with the running balance, and fall back to a one-time "which column is which" screen whose answer is remembered on the device. No OCR (slow, error-prone with money, and scanned statements are rare now), no upload, no new dependency.

## How it reads a statement

1. **Rows.** pdf.js gives positioned text; pieces on the same baseline form a row. Pieces that touch (a `£` split from its number) are joined.
2. **Table area.** It starts at a heading row (one naming at least two of Date / Description / Paid out / Money in / Amount / Balance / Fees), or at a row that begins with a date and has amounts on it or just below. It then extends over tightly spaced rows. Rows carried over from the previous page above the first date are included; summary boxes and footers, separated by bigger gaps, are not.
3. **Money columns.** Every amount in the table area (two decimal places, optional `£`, sign, brackets, `CR`/`DR`) is clustered by its right edge, its left edge and its centre. Whichever alignment gives the fewest clean columns wins.
4. **Headings.** Each heading is put over the nearest column. For right-aligned amounts, a heading must start at or before the column's edge, and one heading names one column. "Money in/out" means a signed amount.
5. **Which column is which.** Every valid assignment (money out, money in, signed amount, fee, balance, ignore) is tried and scored:
   - +2 for each printed balance that agrees with the running total, −4 for each that doesn't;
   - ±3 for the closing balance;
   - ±1 for agreeing or disagreeing with a heading;
   - −2 for calling a column with minus signs in it "money out", "money in" or "fee".

   Columns that only ever print `0.00` are left out. When two different readings score the same, the statement is not called verified.
6. **Dates.** ISO, `14 Nov 2026`, `14 Nov`, `Nov 14, 2026`, `14/11/26`. Day/month order is inferred (UK first). When no year is printed on the rows, it comes from the statement text and rolls over at New Year. Newest-first statements are put back into date order.
7. **Descriptions.** If dated rows usually carry their amount, extra text lines continue the transaction above. Otherwise (HSBC style), lines collect until the amount arrives.
8. **Fees** (e.g. Revolut's Fees column) become their own transaction, after the payment they belong to.

## When it is "verified"

Only when a balance column exists, every printed balance agrees, at least two are confirmed, the closing balance agrees where printed, and no other reading fits equally well. A verified statement imports like an HSBC one. Anything else opens the column screen with the best guess filled in, a live preview and the checks. The user's answer can be remembered as a **layout** (bank name, alignment, column positions and roles) under `kv.pdfLayouts`. A layout holds no transactions, names or numbers.

The first row is never counted as proof when there is no printed opening balance, because its balance is what the opening is worked out from.

A statement with **no balance column** (common in the US) is verified another way: the printed opening balance plus every transaction must come to the printed closing balance exactly. Printed totals and counts, where shown, are a further check on any statement.

## Evidence

- Invented fixtures in `tests/fixtures/genericPages.ts`: headed and unheaded tables, signed and unsigned amounts, no year, newest-first, fees, no balance column.
- On the maintainer's own statements (never committed; `tests/domain/import/generic.real.test.ts`), with the dedicated parsers switched off, the generic reader matched every transaction and verified each file:
  - three HSBC statements (195, 240 and 220 transactions);
  - one Revolut statement (902 transactions, found as signed amount + balance + fee).

- On friends' Monzo and Lloyds statements (never committed): Monzo's current account and savings pot are split apart and each verified; the Lloyds statement verifies once its invisible accessibility text is ignored.
- On a public collection of sample statements from about 120 banks (financefileconverter.com, used locally only and never committed, since no licence is stated), 45 of 128 accounts are fully proved. Most of the rest are scanned images, European number formats, statements with no balance and no printed opening/closing, or samples whose own numbers don't add up (the Zenith sample is 3 pages of a 10-page statement, with arithmetic slips). Those are correctly left unproved.

## Layouts learned from other banks

| Seen | Handled by |
|---|---|
| Invisible accessibility text in a microscopic font: column names on every row, "blank." in empty cells, a "." after every value (Lloyds) | Text far narrower than real characters is dropped. |
| A key to the payment codes that looks like a table heading (Lloyds) | A "table" with no amounts in it is ignored. |
| A Type column (FPI, FPO, DEB, BGC…) | Mapped to the payment types the categoriser knows, so card spending and payments to people are recognised. |
| Several accounts with their own titles (Monzo "Personal Account statement", then "Pot statement") | A statement title not seen before starts a new account; a title repeated on every page does not. The pot's printed name labels it. |
| Summary values printed above their labels (Monzo) | The nearer of the value above and the value below is taken. |
| The statement period ("01/10/2026 - 15/11/2026") | A date range is never a transaction. |
| A summary box repeated at the top of every page (Zenith) | The same opening balance again doesn't start a new account. |
| A heading centred over a column whose text starts further left (Zenith) | The column starts where its text does. |
| Pages printed a few points apart (Barclays) | A page repeating the first heading at an offset is moved back into line. |
| Continuation lines starting with a date ("On / 07 Sep"), or repeating the balance (Barclays) | A date inside the description column is description; the text of a balance-only line stays with its payment. |
| Date printed under the amounts (Wise) | A date with its amounts just above starts the table; blocks prefer the grouping that keeps each date with its amount. |
| "+ $182.00" with a space after the sign (GO2bank) | Read as money. |
| Payment codes printed at the start of each description ("))) SHOP", "BP NAME", "CR NAME": HSBC, First Direct) | When most descriptions start with a known code, it becomes the payment type and is taken off the description. |
| A Category column in words ("Merchant", "Top up": Revolut) | Treated as a Type column: Merchant is a card payment, Top up is money in. |
| "Payment from / Transfer to / To NAME", "To GBP Savings", "Transfer to Pot" | The name becomes the payee and the kind of payment is set; moves to the account's own savings are pot transfers. Not used in the Nigeria region, where the narration reader handles the fuller wording. |
| A long name wrapped onto the next line (Revolut, Barclays, NatWest) | A line is joined to the one above when its first word would not have fitted there; separate lines (a town, a reference) stay separate. |

With these, the generic reader gives exactly what the dedicated HSBC and Revolut parsers give on the maintainer's real statements: 1,557 transactions with the same dates, amounts, payment types and description lines. The dedicated parsers are still used first for those two banks until that has held for a while.

## Limits

- Scanned (image-only) PDFs have no text to read; the user is pointed to a downloaded PDF or CSV.
- One currency per device. A statement in another currency than the region's is stopped at import (see `07-regions.md`, which also covers the layouts learned from Nigerian statements).
- Statements with no balance column and no printed opening and closing balance can be imported, but only after the user confirms the columns, and they show as not reconciled.
- Comma-decimal (European) amounts and currencies outside the three regions are not read.
