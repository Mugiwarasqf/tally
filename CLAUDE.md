# Tally

Local-first expense tracker, budget planner and debt planner (PWA). Vite + React 19 + TypeScript 7 + Dexie (IndexedDB). UK, GBP; PDF readers for HSBC UK and Revolut. See [README.md](README.md) for features.

## Hard constraints (from the user)

- **Local only, zero cost.** No backend, no accounts, no analytics, no cloud sync. Never add anything that sends financial data off the device or needs a paid service.
- **Professional, distinctive UI** that works as an installable PWA. Not generic.
- **Do a case study before any design decision** (research what leading products do, then test candidates). Typeface and palette were chosen this way, see `docs/03-design-system.md`.
- Keep the repo root to files tools require. Everything else lives in a named folder.
- Real bank statements and personal data never go in the repo or in tests; tests use invented fixtures (`tests/fixtures/`).
- **Built to be shared.** Detection must work for anyone: no user's name, employer, account numbers or local shops in code, comments or the merchant dictionary. Add national chains and services only; everything personal is learned from each user's own choices at runtime.

## Layout rules

- `src/domain/**` is pure: no React, no Dexie, no `window`. Everything is a function of its inputs, which is why it is unit-tested.
- `src/data/**` owns storage. `src/app/data.tsx` loads everything once and derives shared state (recurring, income, schedules, debt plan, alerts) so every page agrees.
- Pages read from `useApp()`; they do not query the database directly except for writes.
- Money is **integer pence**. Dates are `YYYY-MM-DD` strings. Never use floats for money.
- Budget "months" are *cycles* (`monthStartDay`), not calendar months.

## Design system

- One typeface: **Plus Jakarta Sans** (self-hosted via `@fontsource-variable`). Proportional figures for large numbers, `.num` (tabular) for columns.
- Palette "Forest & Mint on warm paper"; chart hues are the validated 8-slot categorical palette in `src/styles/tokens.css`. Status colours (good/warn/serious/critical) are reserved for status and always paired with an icon and a label.
- Icons: Phosphor (MIT), duotone. Category icons are stored as icon *names* (`src/ui/icons.tsx`), never emoji.
- Charts are hand-written SVG in `src/ui/charts/` and follow the dataviz rules: thin marks, solid hairline grid, a tooltip that also works on keyboard focus, a legend, and a table view.
- Form fields are at least 16px so phones do not zoom on focus. Never disable pinch-zoom.

## Commands

```bash
npm run dev | build | preview | test | typecheck | icons
TALLY_SAMPLES=<dir> npx vitest run tests/domain/import/hsbc.real.test.ts   # real-statement parser check
```

Open `/?demo` for fictional sample data (separate database).

## Gotchas learned the hard way

- A transaction is only "missed" if the imported statements cover its due date (`schedule.ts` horizon rule). Otherwise everything since the last import would be flagged.
- Month-over-history comparisons use an *expanding* baseline (only earlier months), so old reports never change when new statements arrive.
- ATM rows mention shops ("CASH TESCO"), so type rules run before the merchant dictionary.
- Overlapping alert syncs race on insert; `syncAlerts` checks-then-adds inside one transaction.
- In Git Bash, an argument of `/` is rewritten to a Windows path; use `MSYS_NO_PATHCONV=1` when scripting.
- Editing files with inline `node -e` through the shell mangles `${}`; use a quoted heredoc (`<<'EOF'`) or the edit tool.
- Never write `useEffect(() => someCall(), deps)` as a one-liner: `window.scrollTo` (and other DOM calls) can return a Promise in Chromium, React takes the return value as the cleanup, and the next run throws "destroy is not a function". Always use a block body. `PageBoundary` keeps a page error from blanking the shell.
