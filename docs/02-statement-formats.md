# Statement formats

## Supported

| Format | Notes |
|---|---|
| **HSBC UK PDF** (Basic, Advance, Premier, Bank Account) | Parsed by `src/domain/import/hsbc.ts`. Verified against real statements; every printed total and daily balance reconciles. Text-based PDFs only (scanned images need OCR, which is out of scope). |
| **Revolut PDF** (Statement / Custom Statement) | Parsed by `src/domain/import/revolut.ts`. Every row prints its balance, so every row is checked, plus the printed Total and the summary's opening and closing balances. Only the GBP current account is imported; other currencies are reported and left out; savings-pot interest tables are skipped. Moves to and from the savings pot are own-account transfers. |
| **Any other bank's PDF** | Read by `src/domain/import/generic.ts`: columns found from where amounts sit, then proved with the printed running balance. Unproved statements go to a "which column is which" screen whose answer is remembered per bank. See [06-pdf-statements.md](06-pdf-statements.md). |
| **CSV** | Columns are auto-detected (date, description, amount or debit/credit, balance); day/month order is inferred from the data (UK first). If the guess is wrong the user maps columns by hand. |
| **OFX / QFX** | SGML or XML flavour. |
| **QIF** | `D` date, `T` amount, `P` payee, `M` memo records. |

## HSBC layout facts the parser relies on

- A table header row carries `£ Paid out`, `£ Paid in`, `£ Balance`; amounts are right-aligned under them.
- Column 2 is the payment-type code (`VIS`, `)))` contactless, `BP`, `CR`, `TFR`, `ATM`, `DR`, `OBP`, `VRP`, `DD`, `SO`); column 3 holds one to four description lines.
- The date is printed only on the first transaction of each day and carries across pages.
- A foreign-currency card payment is followed by a separate `DR Non-Sterling Transaction Fee` row.
- Page 1 prints opening and closing balances and total payments in and out: the parser's self-check.
- Names are truncated to about 18 characters (`Jordan Quinn Exampl`), which matters for name matching.

## Adding another bank's PDF

Most banks need nothing: the generic reader handles them. Write a dedicated parser only when a bank's layout defeats it (for example, no balance column and no headings), and say why in the parser's header comment.

1. Add `src/domain/import/<bank>.ts` exporting `is<Bank>Statement(pages)` and `parse<Bank>(pages): ParsedStatement`.
2. Register it in `detect.ts` next to the HSBC check.
3. Build a **synthetic** fixture (as in `tests/fixtures/hsbcPages.ts`): invented names and numbers, same geometry. Never commit a real statement.
4. Include a self-check (totals or running balance) so a bad parse is visible rather than silently wrong.
