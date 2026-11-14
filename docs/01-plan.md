# Plan

## Goal

Replace manual expense entry with statements. Attach as many months and accounts as you like and get a full picture of cash flow, a budget that is actually about saving money, and a plan to clear debt, all **locally and at zero cost**.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Where does data live? | IndexedDB in the browser (Dexie) | Statements are sensitive; a backend costs money and holds your data |
| Sync? | None. Encrypted backup/restore instead | Cloud sync would put financial data on a third party's servers |
| Hosting | Static site (GitHub Pages / Cloudflare Pages) | Free |
| Charts / styling | Hand-written SVG and CSS tokens | Fewer dependencies; full control over the dataviz rules |
| PDF | pdf.js, loaded only when a PDF is dropped | Keeps the first load small |
| Notifications | Computed on-device; system notifications through the service worker; background checks where the browser allows | True server push needs a backend |
| Other banks' PDFs | Not parsed; CSV/OFX/QIF instead | Layouts differ per bank and cannot be tested without samples |

## Built

1. Import engine (HSBC PDF, CSV, OFX, QIF), deduplication, reconciliation
2. Categorisation, learning, review queue, pattern detection for pay and rent
3. Income streams, recurring payments, missed and late detection
4. Budgets built from a savings goal and a cut list; a profile step (pay, frequency, rent) that detection defers to
5. Debt plan (including money owed to people) feeding the budget
6. Cash flow, insights, trend against history
7. Month-end reconciliation and report card
8. PWA: install, offline, notifications, encrypted backup, demo mode

## Out of scope (for now)

OCR for scanned PDFs; PDFs from other banks; Open Banking connections (they need a paid or regulated provider); multi-currency; shared budgets.
