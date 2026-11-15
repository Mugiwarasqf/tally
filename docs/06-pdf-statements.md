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

## Evidence

- Invented fixtures in `tests/fixtures/genericPages.ts`: headed and unheaded tables, signed and unsigned amounts, no year, newest-first, fees, no balance column.
- On the maintainer's own statements (never committed; `tests/domain/import/generic.real.test.ts`), with the dedicated parsers switched off, the generic reader matched every transaction and verified each file:
  - three HSBC statements (195, 240 and 220 transactions);
  - one Revolut statement (902 transactions, found as signed amount + balance + fee).

## Limits

- Scanned (image-only) PDFs have no text to read; the user is pointed to a downloaded PDF or CSV.
- One currency per import: amounts in `$`/`€` are not read as pounds.
- Statements with no balance column can be imported, but only after the user confirms the columns, and they show as not reconciled.
