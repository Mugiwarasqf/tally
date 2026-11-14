# How the clever parts work

Plain-language notes on the algorithms, written so you can follow and change them. Each lives in `src/domain/` and has tests in `tests/domain/`.

## 1. Reading a statement (`import/hsbc.ts`)

A PDF is not a table; it is positioned pieces of text. The parser groups pieces with nearly the same `y` into **rows**, then decides each amount's column from its **right edge** (amounts are right-aligned under *Paid out*, *Paid in* and *Balance*). A transaction starts on a row with a payment-type code (`VIS`, `TFR`, `BP`…) and continues until the next one. Dates appear only on the first transaction of a day, so the current date is carried forward, even across page breaks.

**Trust, but verify:** page 1 prints the opening balance, closing balance and totals in and out. The parser re-adds everything it read and checks it against those figures and against every printed daily balance. All three of your real statements reconcile to the penny.

## 2. Categorising (`categorize/`)

Layers, strongest first: your rules, learned choices, then type rules (ATM, foreign-currency fee), own-account transfers (same name, or a transfer to another account number), the merchant dictionary, keyword heuristics, and finally "looks like a person". Every result carries a *confidence* and a human-readable *reason*; below 0.7 it goes to the review queue, grouped by merchant so one decision clears many rows.

After each import two **pattern passes** run over everything:
- **Pay** (`analytics/income.ts`): unexplained income that repeats weekly, fortnightly or monthly becomes salary.
- **Rent** (`analytics/rent.ts`): the *exact same amount* to the same payee by transfer, on a steady day, nothing else explaining it.

## 3. Recurring payments and missed ones (`analytics/recurring.ts`, `schedule.ts`)

A payment is *recurring* when its gaps cluster around 7, 14, 30 or 365 days and its amounts are similar. Each recurring payment becomes a **schedule of due dates**; every due date is matched to the nearest real payment inside a window and classed as paid, late, partial, missed or pending.

**The horizon rule:** a payment is only *missed* if your statements cover well past the due date. Missing from the data is not the same as not paid.

## 4. Income as the stem (`analytics/income.ts`, `flow.ts`)

**Declared beats detected.** The profile step (Home, then Settings → About you) asks for take-home pay per payslip, how often, and rent per month. The user ticks which statement lines are their pay and which payee is the landlord; each tick becomes a user rule (`Rule.profile`), so future imports follow it. With a declared pay, the budget plans on exactly that figure times the paydays in the cycle, and other money in is shown but never planned on. A declared rent lets `rent.ts` find the payment without needing three months of rhythm, and Home warns when a fully-covered month has no rent payment (usually: it was paid from an account that hasn't been imported).

Without a profile, income is split into **regular streams** (counted in full) and **irregular** income (counted at half). A fortnightly pay is 26 payments a year, so most months have 2 paydays and two have **3**; expected income for a cycle counts the actual pay dates that fall inside it. With no budget set, the daily allowance comes straight from income minus savings, debt and fixed bills.

**One-offs.** Categories in `ONE_OFF` (government & legal: visa fees, fines) count in what was spent but never in "usual" spending, budget suggestions or the history comparison. "Usual" per category is the median month once there are three, so one strange month doesn't set the level.

## 5. Budget to save (`analytics/cuts.ts`)

Reverse budgeting: `spendable = income − savings goal − debt payments`. If what you usually spend is more than that, the difference is what to cut. Cuts are chosen so they hurt least:

1. Needs are protected, wants are trimmed; each category has a maximum cut (`LIMIT`).
2. A level you have **already achieved** (your best recent month) beats an arbitrary percentage.
3. Easiest first (effort = size of the cut relative to the category); stop when the gap is closed.

Extras: a subscriptions audit, avoidable fees, and "small purchases add up" (shown, never counted, because it overlaps the category cuts).

## 6. Trend against your history (`analytics/trend.ts`)

Each month is compared **only with the months before it** (an expanding baseline). You get the baseline (mean), a normal range (±1 standard deviation), a z-score, a rank ("4th highest of 5"), and a least-squares trend with an honest confidence label. An unfinished month is projected using *your own* pattern of how much of a month is usually spent by this day, so rent on the 1st does not make the month look three times too expensive.

## 7. The report card (`analytics/report.ts`)

Each dimension turns a deviation into 0–100 by **interpolating between control points** (so 4.9% over and 5.1% over score almost the same). The overall score is the weighted average of the dimensions that apply:

| Dimension | Weight | What it measures |
|---|---|---|
| Spending discipline | 25 | total spent vs planned |
| Versus your history | 20 | this month vs your usual (inside your normal range is not penalised) |
| Category accuracy | 20 | share of budget lines that stayed on plan |
| Savings goal | 15 | saved vs target |
| Debt plan | 10 | paid vs planned, minus a penalty per missed payment |
| Bills on time | 10 | late and missed bills |

If the statements do not cover the whole month the report is **provisional** and budgets are scaled to the days covered.

## 8. The debt plan (`debt/plan.ts`)

Interest accrues monthly at APR ÷ 12, then payments are applied: every debt gets its minimum and the rest goes to one debt first (avalanche = highest APR, snowball = smallest balance); cleared debts roll their minimum onward. "Reasonable" means covering the minimums, never spending the whole surplus (10% of income is kept back), with *balanced* using half of the usable surplus and *fast* 80%. A pay-by date turns "pay what you can" into a concrete monthly amount.
