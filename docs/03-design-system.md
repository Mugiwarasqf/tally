# Design system

## Case study (how these choices were made)

Reading about design is not enough, so the main decisions were **tested**:

- **Typeface.** Ten free candidates (Inter, Plus Jakarta Sans, Manrope, DM Sans, Hanken Grotesk, Instrument Sans, Figtree, Onest, Geist, Schibsted Grotesk) were rendered with identical content, and tabular figures were measured in the browser. Findings: **DM Sans has no tabular figures**, which would misalign every money column; **Hanken Grotesk's digits are always fixed-width**, so large figures like "£1,111" look loose; Inter is the generic default the leading fintechs avoid (Revolut uses Aeonik, Stripe uses Söhne, Wise made its own face). **Plus Jakarta Sans** was chosen: confident geometric numerals at display sizes, and proper proportional and tabular figures.
- **Palette.** Three directions were mocked on the same hero card: Ink and Lime, Deep Navy and Azure, Forest and Mint on warm paper. Navy is the generic "finance blue" the Wise rebrand deliberately abandoned; lime imitates a success status. **Forest and Mint on warm paper** reads calm and premium.
- **Contrast.** Every text token was checked against WCAG (all AA or better, the key pairs AAA), and the chart palette was re-validated against the exact warm and dark-green surfaces it renders on.

## Tokens

`src/styles/tokens.css` is the single source of truth.

- **Type scale:** 11 / 12 / 13 / 15 / 16 / 18 / 22 / 28 / 36 px, hero fluid 44–68 px. Weights 450 / 550 / 650 / 750. Large numbers use proportional figures and tight tracking.
- **Space:** a 4px grid. **Radius:** 8 / 12 / 16 / 22 / 28 px and pills.
- **Light and dark** are declared under both a `prefers-color-scheme` media query and a `data-theme` attribute, so the in-app toggle wins both ways.
- **Chart hues:** eight fixed categorical slots (blue, orange, aqua, yellow, magenta, green, violet, red), assigned per category and never reshuffled. Beyond eight, categories are neutral grey and told apart by icon and name.
- **Status colours** (good, warning, serious, critical) are reserved for status and always paired with an icon and a label.

## Chart rules

Thin marks (bars at most 24px with a 4px rounded end and a square base, 2px lines), solid hairline gridlines, direct labels used sparingly, a legend whenever there are two or more series, one tooltip listing every series that also works on keyboard focus, and a **table view** twin for every chart. No dual axes.

## Layout

Mobile first. Phone: floating tab bar with a centre Import button. Tablet: icon rail. Desktop: full rail. The dashboard is a 12-column bento grid.
