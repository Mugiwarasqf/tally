# Tally

A local-first expense tracker, budget planner and debt planner. Your bank statements are read **in your browser**; nothing is uploaded, and there is no server and no account. It installs as an app (PWA) on phones and desktops and works offline.

## What it does

| | |
|---|---|
| **Import** | Drop in statements: HSBC UK PDFs, plus CSV, OFX or QIF from any bank. Duplicates are detected, and each HSBC statement is checked against its own printed totals ("reconciled"). |
| **Categorise** | Merchants are recognised automatically (UK dictionary), transfers between your accounts are netted out, and pay and rent are found by *pattern*. Correct one transaction and Tally learns it. |
| **Income first** | Weekly, fortnightly or monthly pay is detected by its rhythm. Everything you spend is shown as drawn from it, including a flow diagram and a "3-pay month" count. |
| **Budget to save** | Start from a savings goal. Tally works out what has to be cut, ranks the cuts that hurt least, and turns the ones you keep into a budget. |
| **Debt plan** | Cards, loans, buy-now-pay-later and money owed to people. Avalanche or snowball, a payment sized to what you can afford, or a pay-off date. Feeds the budget. |
| **Recurring and missed** | Subscriptions, bills, rent and pay are detected; missed or late payments are flagged (only for dates your statements cover), with per-payment alert rules. |
| **Your own numbers first** | A short profile step: what you take home, how often, and your rent. You tick which statement lines are your pay and your landlord; nothing is assumed, and every merchant can be re-labelled in one tap. |
| **Month-end report card** | Reconcile the month, then get a graded report against your plan and your own history. |
| **Notifications** | In-app and (optionally) system notifications, computed on your device. |

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
```

Open `/?demo` to explore with fictional sample data. Demo mode uses a separate database, so it never touches real data.

## Privacy and cost

Everything runs in the browser and is stored in IndexedDB. The app is a static site, so hosting is free (GitHub Pages, Cloudflare Pages, Netlify). The only network requests are for the app files themselves. Encrypted backups (AES-GCM, key from your passphrase via PBKDF2) are made on-device.

## Notifications: what is and isn't possible for free

True server push needs a backend that stores your schedule, which would break "local only". Instead Tally works out alerts on-device and shows them through the service worker. In an **installed Chrome or Edge app**, Periodic Background Sync lets it check while the app is closed. On iPhone and in Firefox, alerts appear when the app is opened.

## Project layout

```
src/
  domain/      pure logic, no browser or storage code (import, categorise, analytics, debt, alerts)
  data/        IndexedDB (Dexie): schema, import/commit, user actions, backup, demo data, notifications
  app/         router, data provider, navigation, PWA hooks
  ui/          components, charts, layout shell, icons
  pages/       one file per screen
  styles/      design tokens, base, layout, components, charts, pages
  lib/         money, dates, hashing
tests/         mirrors src/domain, plus synthetic fixtures (never real statements)
docs/          design decisions and how the algorithms work
public/        manifest, service worker, icons
scripts/       icon generator
```

## Real statements stay out of the repo

`samples/` and all `*.pdf` / `*.csv` files are git-ignored. To run the parser tests against your own HSBC PDFs:

```bash
TALLY_SAMPLES="/path/to/statements" npx vitest run tests/domain/import/hsbc.real.test.ts
```

Read more in [docs/](docs/).
