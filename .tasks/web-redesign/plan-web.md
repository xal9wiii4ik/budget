# Implementation Plan (web): web-redesign phase 1 — design system, shell, auth

## Approach
Semantic tokens in `src/styles/tokens.css` are the ONLY place a colour literal
exists. Two raw palettes (`--l-*`, `--d-*`) hold the values once; the theme blocks
only remap `--color-*` onto one of them, so a colour is never written twice. Dark
is applied by `[data-theme='dark']` (explicit pick) and by
`@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) }` (system
default); both set `color-scheme`, so native selects, date pickers and scrollbars
follow. The anti-flash script in `index.html` sets the attribute before first paint.

Layer 2 components are thin: a class-map over tokens plus `...rest`, typed with
`ComponentProps<'x'>` (NOT `…WithoutRef` — `register()` from react-hook-form hands
in a `ref`, which is an ordinary prop in React 19 and must pass through).

## Files
- `src/styles/{tokens,fonts,global}.css`, imported in that order in `main.tsx`.
- `public/fonts/inter-{latin,latin-ext,cyrillic,cyrillic-ext}-wght-normal.woff2`
  + `LICENSE-Inter.txt` (OFL). No runtime external requests; latin + cyrillic preloaded.
- `src/theme/{theme.ts,useTheme.ts,ThemeToggle.tsx}` — key `budget.theme`,
  values `light|dark|system`, `system` = attribute removed, cross-tab via `storage`.
- `src/components/{Button,Field,Card,Badge,PageHeader,EmptyState,Toolbar}.{tsx,module.css}`;
  Modal / ConfirmDialog / CurrencySelect / QueryStateNotice moved onto tokens.
- `src/routes/{ProtectedLayout,NavIcon}.tsx`, `src/auth/AuthLayout.tsx`,
  `routes/{Login,Register}Page.tsx`.

## Tokens
Colour (each has a light and a dark value; use the semantic name, never a raw one):
`--color-bg` page · `--color-surface` cards/rows/inputs · `--color-surface-raised`
modals+popovers · `--color-surface-muted` skeletons, hover, disabled fills ·
`--color-border` hairlines · `--color-border-strong` input borders (>=3:1) ·
`--color-text` · `--color-text-muted` labels/secondary · `--color-text-subtle`
hints/placeholders · `--color-accent` (links, active nav, primary fill) ·
`--color-accent-hover` · `--color-accent-fg` (text ON accent) · `--color-accent-soft`
+ `--color-accent-soft-fg` (chips, banners, active nav background) · same
`-`/`-hover`/`-fg`/`-soft`/`-soft-fg` sets for `danger`, `success`, `warning`
(success/warning have no `-hover`) · money: `--color-expense`, `--color-income`,
`--color-transfer` · `--color-overlay` modal/drawer backdrop.
Scales: `--space-1..8` (0.25rem step) · `--radius-sm|md|lg|full` ·
`--text-xs|sm|md|lg|xl|2xl` (md = body) · `--leading-tight|normal` ·
`--shadow-sm|md` (only for things that FLOAT) · `--ring` + `--ring-width`/`--ring-offset`
(used as `outline: var(--ring); outline-offset: var(--ring-offset)`) ·
`--z-popover` 40 / `--z-modal` 50 · `--font-sans` (Inter Variable + system fallback).

## Contrast (WCAG 2.1, computed; script in scratchpad, values re-checkable)
| pair | light | dark |
|---|---|---|
| text / bg | 16.60 | 15.67 |
| text / surface | 17.79 | 14.46 |
| text-muted / surface | 6.06 | 7.61 |
| text-subtle / surface | 4.93 | 5.07 |
| accent / surface (link) | 5.96 | 5.47 |
| accent-fg / accent | 5.96 | 5.87 |
| accent-soft-fg / accent-soft | 6.96 | 7.98 |
| danger-fg / danger | 5.72 | 6.23 |
| danger-soft-fg / danger-soft | 6.52 | 7.91 |
| success-soft-fg / success-soft | 6.75 | 8.85 |
| warning-soft-fg / warning-soft | 5.51 | 8.18 |
| expense / surface | 6.18 | 6.85 |
| income / surface | 6.10 | 8.35 |
| transfer / surface | 6.98 | 7.07 |
| border-strong / surface (UI, >=3) | 3.10 | 3.12 |

## Component API (props in one line each)
- `Button` — `variant 'primary'|'secondary'|'ghost'|'danger' = 'secondary'`, `size 'sm'|'md' = 'md'`, `loading?` (disabled + `aria-busy`; the LABEL stays the caller's), `type = 'button'`, + all button attrs. md >=40px, sm >=32px (>=40px under 600px).
- `Field` — `label`, `htmlFor` (required), `hint?`, `hintId?`, `error?` (renders `<p role="alert">`), `children` = the control, `className?`. Order: label → control → hint → error.
- `Input` / `Select` / `Textarea` — styled natives, every attribute + `ref` passes through, so `{...register('x')}` spreads unchanged; `aria-invalid="true"` paints the danger border. Always give the control an `id` matching `Field.htmlFor`.
- `Card` — `size 'none'|'sm'|'md'|'lg' = 'md'` + div attrs.
- `Badge` — `tone 'neutral'|'accent'|'success'|'danger'|'warning' = 'neutral'` + span attrs.
- `PageHeader` — `title`, `description?`, `actions?` (wrap under the title when narrow), `className?`. Renders the screen's single `<h1>`.
- `EmptyState` — `title`, `description?` (say what to do next), `actions?`, `icon?`, `className?`.
- `Toolbar` — `justify 'start'|'between'|'end' = 'start'` + div attrs; wraps, never scrolls sideways.
- `ThemeToggle` — `className?`; segmented light/system/dark, `aria-pressed` per option.
- `NavIcon` — `name` (shell icon set); 18px, `currentColor`, always `aria-hidden`.

## Usage rules (binding for the parallel /transactions work)
- **Card vs bare surface**: `Card` = a block the user perceives as one object
  (a widget, a summary, a form panel). A LIST is one `Card size="none"` whose rows
  are separated by `1px solid var(--color-border)` — never a card per row.
- **Money**: every amount gets `className="tnum"` (global, `font-variant-numeric:
  tabular-nums`) and is right-aligned in tables/rows. Colour by SEMANTICS, not by
  sign: expense → `--color-expense`, income → `--color-income`, transfer →
  `--color-transfer`; a neutral total stays `--color-text`. Formatting still goes
  through `formatMoney` from `@budget/shared` with `{ locale }` — unchanged.
- **Hover/active**: hover = `--color-surface-muted` background (never a shadow,
  never a colour shift on text alone); selected/active = `--color-accent-soft`
  background + `--color-accent-soft-fg` text; pressed = the `-hover` colour token.
  Focus is NEVER styled locally — the global `:focus-visible` ring covers it.
- **Depth**: borders and surface tone, not shadows. `--shadow-md` is for modals and
  the mobile drawer only; `--shadow-sm` for a control that genuinely lifts.
- **Spacing**: only `--space-*`. Row padding `--space-3`, card padding `--space-4`,
  gap between page sections `--space-6`.
- **Text**: labels `--text-sm` + `--color-text-muted`; hints/meta `--text-xs` +
  `--color-text-subtle`; body `--text-md`.
- **Buttons**: exactly one `primary` per surface; `secondary` for cancel/close;
  `ghost` for row-level and toolbar actions; `danger` only for destructive confirms.
- No hex anywhere outside `tokens.css`; no `px` font sizes; no new icon or CSS deps.

## Deviations from the brief
- The dark set could not be a single selector list (a media query cannot be part of
  one). Values are written ONCE in the `--d-*` palette and the two theme blocks only
  remap `--color-*`, which is the no-duplication the brief asked for.
- `--ring` is an OUTLINE, not a two-layer box-shadow: it is never clipped by an
  ancestor's `overflow` and makes no assumption about the surface underneath.
- `nav.group.settings` reads "Account"/"Аккаунт": a group header identical to its
  single item ("Settings/Настройки") is noise. Say the word and it flips back.

## Risks
- The drawer's open state is DERIVED from `location.key` (open only for the route it
  was opened on) — an effect calling `setState` is a lint error in this repo. Worth a
  QA pass on: burger → navigate → drawer closed; Esc; backdrop; resize past 900px.
- `border-strong` is a visible medium grey (3:1). If it reads heavy on the
  /transactions inputs, lightening it is a one-line change with an a11y cost.
- Phase-2 screens still ship their own hex; they now sit on the tokenised body
  background and will look slightly off in dark mode until phase 2. Known, accepted.
