# Scope `mobile-design` — the web design system on the phone (grooming, plan only)

Tier: **STANDARD** (presentation only: no auth logic, no money math, no migration,
no API contract — `@budget/shared` grows a pure palette module, which is not a
contract change). Self-review via `/review-pr` per line; senior-lead diff gate on
every line; ONE simulator QA pass in both themes at the end.

What the user saw: web got the design system (`aea2d06`, `8f9f086`; `docs/web.md`
"Design system"; `apps/web/src/styles/tokens.css`), the phone caught up only on
functions. Goal: the same visual LANGUAGE on the phone — semantic tokens, dark
theme, Inter with tabular figures, money coloured by meaning — by substance, not
by letter (a phone has native headers, tab bars, sheets; it does not get a sidebar
or a `PageHeader`).

## Diagnosis (by code, 2026-09-06)

- `apps/mobile/src/components/theme.ts` — 11 STATIC colours (`bg card border text
  textMuted primary danger income expense swatchEmpty disabled`), `spacing`,
  `TOUCH_TARGET`. 51 files import it; ~500 `colors.*` reads, every one inside a
  module-level `StyleSheet.create` — evaluated once at import, so no value can
  follow a theme. This, not the palette, is the structural cost of the scope.
- 27 files also carry raw literals (`'#FFFFFF'` on filled controls, `#208AEF`
  blue in app.json splash); `StatusBar style="dark"` is hardcoded in `app/_layout.tsx`.
- No `expo-font`, no `@react-native-async-storage/async-storage` (SDK pin 2.2.0,
  bundled in Expo Go), no `@react-navigation/*` direct dep — expo-router 57 sits on
  `standard-navigation`, so navigator chrome is themed through `screenOptions`.
- Native `expo-font` loads TTF/OTF, not woff2: web's `public/fonts/*.woff2` cannot
  be the phone's files (see decision 3).
- Existing primitives: `FormButton` (primary/secondary/danger, pending),
  `LabeledInput` (label/hint/error, a11y name), `FieldError` (scroll anchor),
  `KeyboardAwareForm` (+footer), `KindSegmented`, `DateField`, `HexSwatch`,
  `AccountPicker`, `LogoutButton`, `confirm.ts` (native Alert). Chips:
  `features/transactions/FilterChip` + `ChipPicker`. No Card, Badge, EmptyState —
  every screen hand-rolls the card box (`borderRadius: 12, borderWidth: 1`) and
  its empty/error arms.

## Decisions (senior-lead)

### 1. Tokens: colour palette lives in `@budget/shared`; web pins its CSS to it by a drift test

`packages/shared/src/palette.ts` (pure TS, no deps) becomes the ONE place a
colour value is written: `LIGHT` and `DARK` raw palettes as `Record<PaletteKey,
string>` with exactly web's `--l-*` / `--d-*` keys and values (hex and `rgba()`
strings — RN accepts both), plus the semantic name list (`SEMANTIC_COLORS`:
`bg surface surfaceRaised surfaceMuted border borderStrong text textMuted
textSubtle accent accentHover accentFg accentSoft accentSoftFg danger dangerHover
dangerFg dangerSoft dangerSoftFg success successFg successSoft successSoftFg
warning warningFg warningSoft warningSoftFg expense income transfer overlay`).
Shadows stay web-only in `tokens.css` (CSS syntax, not a colour).

- **Web** keeps `tokens.css` hand-written and unchanged in structure; gains
  `apps/web/src/styles/tokens.test.ts` — parses the `--l-*`/`--d-*` declarations
  and asserts equality with the shared palettes, AND asserts every semantic name
  has a `--color-*` line in all three blocks (`:root`, `[data-theme='dark']`, the
  media query). The second assertion mechanises the "forgotten token shows up as a
  light patch" check `docs/web.md` currently does by eye. `docs/web.md` line
  "the ONE place with colour literals" gets a sentence: the values are pinned to
  `@budget/shared` palette by test.
- **Mobile** builds its theme objects from the same module: `src/theme/tokens.ts`
  (pure, imports only `@budget/shared`) → `{ light: ThemeColors, dark: ThemeColors }`.
- **Rejected — generator (shared → CSS)**: it would turn a closed, documented web
  file into a build artefact (its "identical by construction" prose becomes a
  template), needs a script + a "never edit by hand" rule + a regeneration step,
  and buys nothing the drift test does not: a divergence cannot survive
  `pnpm test` either way. Strictly the values then exist in two files — accepted,
  the same discipline as `openapi.json`/`schema.d.ts` and mcp-server's drift tests.
- **Rejected — parsing `tokens.css` at mobile build time**: Metro has no such
  step; a committed generated TS file is the drift-test option with more moving parts.
- Scales are NOT shared (rem vs pt, a phone's type scale is its own): mobile
  `spacing` keeps `xs 4 / sm 8 / md 12 / lg 16 / xl 24` (+ `xxl 32`); `radius sm 6
  / md 10 / lg 12 / full 999`; `type xs 12 / sm 13 / md 15 / lg 17 / xl 22 / xxl 28`
  (web's rem scale × 16, identical numbers); `TOUCH_TARGET 44` unchanged.
- One `palette.test.ts` in shared: every semantic text/surface pair from
  `.tasks/web-redesign/plan-web.md`'s contrast table ≥ 4.5 (border-strong ≥ 3) in
  BOTH palettes — the one invariant a "small colour tweak" can silently break.

### 2. Theme: device preference in AsyncStorage, explicit pick in "More", native chrome follows

- Preference `light | dark | system`, default `system`; key `budget.theme`, values
  identical to web's `theme/theme.ts`. Stored on the DEVICE, not the profile — same
  as web (localStorage): a theme belongs to a screen, not an account (phone dark,
  desktop light is a normal life), and a profile field is a contract + migration
  with four consumers for nothing. Not secure-store: keychain is for secrets.
- New dep `@react-native-async-storage/async-storage@2.2.0` (SDK pin, in Expo Go).
  `src/theme/preferenceStorage.ts` is the ONLY file importing it (the
  `secureStore.ts` pattern); `src/theme/themeStore.ts` is pure (read/validate/
  write over an injected `PreferenceStorage`, `resolveScheme(preference, system)`)
  and vitest-tested with an in-memory fake.
- Read under the SAME splash gate as `coordinator.ready` (`Promise.all`) — the
  phone's version of web's anti-flash script: the first frame is already in the
  right theme.
- `src/theme/ThemeProvider.tsx` — holds the preference, resolves
  `scheme = preference === 'system' ? useColorScheme() : preference`, exposes
  `useTheme()` → `{ scheme, colors, preference, setPreference }`. It ALSO calls
  `Appearance.setColorScheme(preference === 'system' ? null : preference)` in an
  effect, so native surfaces (Alert, DateTimePicker, keyboard, header) follow an
  explicit pick for free. Components NEVER call `useColorScheme` themselves (grep
  gate) — correctness does not depend on the native override; it is a bonus.
- Root `StatusBar` reads the provider: `style={scheme === 'dark' ? 'light' : 'dark'}`
  — not `"auto"`, because an explicit pick that differs from the OS must still get
  the right status-bar glyphs.
- Navigator chrome through `screenOptions` (expo-router 57 / standard-navigation):
  Stack `headerStyle`, `headerTintColor`, `headerTitleStyle`, `contentStyle`;
  Tabs `tabBarStyle`, `tabBarActiveTintColor = accent`, `tabBarInactiveTintColor =
  textMuted` (the tab-icons engineer's file: applied LAST, after that merge). If
  expo-router 57 exposes a `ThemeProvider`, use it in addition, not instead.
- Picker: `features/settings/ThemeSection.tsx` — the `LanguageSection` shape
  (segmented light/system/dark, `accessibilityRole="tab"`), placed under Language
  in "More". Dictionary: `theme.title / theme.light / theme.system / theme.dark`
  — the ONE dictionary addition of the scope (4 keys, both dicts; the rule "do not
  touch dictionaries" means no rewording of what exists).
- `app.json`: splash gets a `dark` variant (`backgroundColor` = palette bg); the
  Android adaptive-icon colour stays (an asset). Invisible in Expo Go (its own
  splash) — recorded for the future dev build, not a QA item.

### 3. Font: Inter, static TTF weights via `expo-font`, loaded behind the splash gate

- The SAME typeface and licence as web, a different container: native RN takes
  TTF/OTF, so the files are `@expo-google-fonts/inter` static weights
  `Inter_400Regular / 500Medium / 600SemiBold / 700Bold` (the four weights the
  code uses today; full Inter incl. Cyrillic, ~300 KB each — no subsetting on a
  phone, the bundle is local). Deviation from the brief's "from the same files":
  impossible by format; the woff2 stay web's. `LICENSE` note in `src/theme/fonts.ts`.
- `Font.loadAsync` in `src/theme/fonts.ts`, awaited in the SAME `Promise.all` as
  the token hydration and the theme preference — no first frame in the system
  font. On failure: log once, proceed with the system font (a missing family must
  not hold the splash).
- RN gotcha this scope has to design around: a loaded static family ignores
  `fontWeight` — the WEIGHT is the family name. So `src/theme/themedStyles.ts`
  (see 4) maps `fontWeight` → `fontFamily` for every style that has `fontSize` or
  `fontWeight`, via a PURE `applyTypeface(styles, fontsLoaded)` (vitest-tested).
  Authors keep writing `fontWeight: '600'`; no file outside `src/theme/` writes
  `fontFamily` (grep gate). Native header titles / tab labels get the family through
  `headerTitleStyle` / `tabBarLabelStyle`.
- Tabular figures: token `t.tnum = { fontVariant: ['tabular-nums'] }`; EVERY Text
  that renders a `formatMoney`/`formatAmount` result spreads it (grep gate: a
  file importing `formatMoney` contains `tnum`). Inter carries `tnum` on both
  platforms.

### 4. Primitives: the theme factory, three new components, four extended — nothing renamed

- `src/theme/themedStyles.ts`: `const useStyles = themedStyles((t) => ({ ... }))`,
  `const styles = useStyles()` in the component. `t` = `{ colors, spacing, radius,
  type, tnum, TOUCH_TARGET }`. Cached per `(scheme, fontsLoaded)` — at most two
  `StyleSheet.create` per module, zero per-render allocation; `memo` rows re-render
  on a switch because the hook subscribes to the provider. This is the mechanical
  rewrite every one of the 51 files gets: `StyleSheet.create({…})` → `themedStyles((t)
  => ({…}))`, `colors.x` → `t.colors.x`, `spacing.x` → `t.spacing.x`.
- Semantic renames applied during that rewrite (old → new): `card → surface`,
  `primary → accent`, `disabled → surfaceMuted (fill) + textSubtle (label)`,
  `swatchEmpty → surfaceMuted`, `'#FFFFFF' on a filled control → accentFg /
  dangerFg`, selected chip/segment → `accentSoft + accentSoftFg` (web's
  selected/active rule) — NOT a filled accent block; input border → `borderStrong`;
  placeholders/hints → `textSubtle`; skeleton → `surfaceMuted`; modal backdrop →
  `overlay`; sheets/native-window surfaces → `surfaceRaised`.
- Colour by meaning: `expense / income / transfer` only for money and only by
  kind; a neutral total stays `text`. GoalCard's `good`/`warn` become
  `success`/`warning` (a realism warning is not an expense); TemplateRow
  paused/ended → a `Badge`; "archived" → `Badge tone="neutral"`.
- New, in `src/components/`: `Card` (`padding 'none'|'sm'|'md' = 'md'`; surface +
  border + radius.lg — a LIST is one `Card padding="none"` with hairline-separated
  rows, never a card per row), `Badge` (`tone 'neutral'|'accent'|'success'|
  'danger'|'warning'`, soft fill + soft-fg), `EmptyState` (`title`, `description?`,
  `action?: ReactNode` — replaces the hand-rolled pending/error/empty arms where a
  screen has one; `StateShell` in TransactionList keeps its header rule).
- Extended: `FormButton` gains `variant 'ghost'` (row-level / toolbar text
  actions, replaces ad-hoc `color: colors.primary` texts where a Pressable already
  exists — restyle in place, do not restructure) and `size 'sm'|'md'`;
  `LabeledInput` gets `keyboardAppearance={scheme}` and `borderStrong`;
  `DateField` passes `themeVariant={scheme}` to the iOS picker; `KindSegmented`
  and `LanguageSection`/`ThemeSection` share the selected style above.
- Not ported, by substance: `PageHeader` (native headers own the title),
  `Toolbar` (a phone toolbar is one control), `ThemeToggle` icons (no icon set on
  this client — words, like `LanguageSection`).
- `src/components/theme.ts` keeps `spacing`/`TOUCH_TARGET` re-exported from
  `src/theme/tokens.ts` during the migration and LOSES `colors` at scope close —
  `tsc` then proves no static colour survives anywhere.

## Rules (binding for every line; grep gates listed in plan-mobile.md)

1. No colour literal outside `packages/shared/src/palette.ts`. Exceptions: `HexSwatch`
   renders the USER's hex (data, a variable); `app.json` (config, not code).
2. No `fontFamily` outside `src/theme/`; no `useColorScheme` outside
   `src/theme/ThemeProvider.tsx`; no `StyleSheet.create` holding a colour.
3. Money Text = `t.tnum` + colour by kind; totals neutral.
4. Logic, contract, query keys, dictionaries (beyond the 4 theme keys) untouched.
   A file's structure changes only where plan-mobile.md marks it `S`.
5. Tab icons are the other engineer's; `(tabs)/_layout.tsx` and
   `(tabs)/transactions.tsx` are touched LAST by their line, after that merge.

## Lines (parallel, disjoint files)

- **Line 0 — foundation** (must land first; ~25 agent-min writing):
  `packages/shared/src/palette.ts` + test + export; `apps/web/src/styles/tokens.test.ts`
  (+ one sentence in `docs/web.md`); `apps/mobile/src/theme/*` (tokens, themeStore
  + test, preferenceStorage, fonts, applyTypeface + test, themedStyles,
  ThemeProvider, useTheme); `app/_layout.tsx` (provider, gate, StatusBar);
  `app/(app)/_layout.tsx` screenOptions; `app.json`; deps; `lib/probes.ts` (one
  probe: `Appearance.getColorScheme()` + whether `setColorScheme` propagates in
  Expo Go); the three new primitive SHELLS (`Card`, `Badge`, `EmptyState`) so B/C
  can import them; `components/theme.ts` re-export shim.
- **Line A — primitives, shell, auth, More** (~20 min): `src/components/*`,
  `app/(auth)/*`, `(tabs)/more.tsx`, `features/settings/*` incl. new
  `ThemeSection`, dict keys, `LogoutButton`; `(tabs)/_layout.tsx` last.
- **Line B — money screens** (~30 min, the largest): `features/transactions/*`,
  `features/accounts/*`, `features/recurring/*`, `(tabs)/accounts.tsx`,
  `category-transactions.tsx`, `recurring.tsx`, the four forms
  (transaction/transfer/recurring/account); `(tabs)/transactions.tsx` last.
- **Line C — categories + goals** (~25 min): `features/categories/*`,
  `features/goals/**`, `(tabs)/categories.tsx`, `(tabs)/goals.tsx`, `goal-*.tsx`,
  `contribution-form.tsx`, `category-form.tsx`.
- **Close**: delete `colors` from `components/theme.ts`, run the grep gates,
  `docs/mobile.md` "Design system" section, ONE simulator pass both themes
  (`qa-mobile-checklist.md`), physical-iPhone list written, not executed.

Gates per line: `pnpm --filter @budget/mobile typecheck && lint && test`; line 0 also
`--filter @budget/shared` and `--filter @budget/web test`. pytest not involved.
Test runs serialise per PM policy (vitest only here — no shared DB, parallel is fine).

## Estimate (agent-minutes, PM policy 2026-08-19)

| line | writing | gates | verification |
|---|---|---|---|
| 0 | 25 | 8 | probe log read on simulator, 5 |
| A | 20 | 5 | in the final pass |
| B | 30 | 8 | in the final pass |
| C | 25 | 5 | in the final pass |
| close + QA | 10 | 5 | simulator both themes 45–60, plus one fix round (~30) if QA finds functional — expected: at least one (font loading or a modal flash) |

Wall-clock: 0 (35) → A‖B‖C (40) → close + QA (70) → fix round (30) ≈ 3 h.
Tokens: ~150–250k per line, ~100k QA.

## Risks

- R1 Hermes ≠ Node: everything under `src/theme/` that a test imports (`tokens`,
  `themeStore`, `applyTypeface`) imports only `@budget/shared`; RN enters in
  `themedStyles`/`ThemeProvider`/`preferenceStorage`/`fonts` only. The vitest
  `include` glob already keeps `app/**` out.
- R2 `useColorScheme` / `Appearance.setColorScheme` in Expo Go: `userInterfaceStyle:
  automatic` is set; the line-0 probe logs both; QA switches the simulator with
  `xcrun simctl ui <udid> appearance dark|light`. If `setColorScheme` does not
  propagate in Go, the app is still right (context resolves) and only native
  surfaces follow the OS — recorded degradation, not a blocker.
- R3 Fonts before first frame: gated with the splash; failure → system font +
  one log line. Bundle +~1.2 MB.
- R4 Modal presentation background in dark (a white sheet flash behind
  `presentation: 'modal'`) — `contentStyle` per modal screen; verify in QA.
- R5 `memo` rows must flip on a switch — a QA item, not an assumption.
- R6 The blocker fix on `(tabs)/transactions.tsx` and the icons on `_layout.tsx`
  are in flight: those two files are each line's LAST file; a slipped merge delays
  one file, not a line.
- R7 Old blue in native assets (icon, Expo Go splash) stays until a dev build —
  visible mismatch on the home screen, out of scope, said here so nobody files it.

## Senior-lead rulings, second session (2026-09-06) — these OVERRIDE the text above where they differ

Answers to `plan-mobile.md` §6 (PM-confirmed):
1. 60 files, not 51 — accepted; line A absorbs the nine `src/components/*`.
2. The four primitive EXTENSIONS (`FormButton` ghost/size, `LabeledInput`, `DateField`,
   plus `KindSegmented`'s selected style) ship in LINE 0 with the three shells, so B/C
   typecheck against the widened unions. Line 0 lands alone; A/B/C start after it.
3. `expo-font` + `@expo-google-fonts/inter` + `@react-native-async-storage/async-storage`
   are installed via `npx expo install`, lockfile + workspace entry in the same diff
   (precedent `a913cb6`). All three are in Expo Go; not "native modules" in the sense
   of the freeze rule.
4. Selected chip / segment = `accentSoft` fill + `accentSoftFg` text + **1pt
   `borderColor: accent`** (dark accentSoft/surfaceRaised is 1.04 — a border is the
   phone's hover). `KindSegmented` keeps a FILLED `accent` + `accentFg` — a missed kind
   is a wrong row. Exposed once as `t.selected.chip` / `t.selected.text` so the nine
   `chipSelected` sets and the two segment pickers cannot drift.
5. Warnings use the `warning` token everywhere (GoalCard, PlanSummary, PlanNodeRow,
   BaseCurrencySection) — never `expense`. The token already exists on web.
6. `app/(auth)/_layout.tsx` is on line A (needs `contentStyle: bg`). Navigator chrome
   is styled through `screenOptions` from ONE helper in `src/theme/` — no dependence
   on a router `ThemeProvider`; our own context is the theme.
7. `goal-plan.tsx` keeps its hand-rolled header (`S`); recoloured as is.

**Decision 1 REPLACED — one source, a generator, no drift test between hand-edited
files.** Two hand-edited files pinned by a test (the text above) is what the PM
rejected. Now: `packages/shared/src/palette.ts` is the ONLY place a colour value is
written (`LIGHT_PALETTE` / `DARK_PALETTE`, `PALETTE_KEYS`); `packages/shared/src/paletteCss.ts::renderPaletteCss()`
renders the raw `--l-*` / `--d-*` declarations; web consumes them as a Vite VIRTUAL
module (`virtual:palette.css`, a ~25-line plugin in `apps/web/vite.config.ts`) imported
from `main.tsx` before `tokens.css` — nothing generated is committed, nothing to
regenerate, nothing to drift. `tokens.css` LOSES its two raw colour palettes and keeps
only what is CSS syntax: the shadows (`--l/d-shadow-*`), the semantic `--color-*`
remaps, scales, ring, chart aliases. Its header changes accordingly. Web's test
(`apps/web/src/styles/tokens.test.ts`) pins the two things that CAN break: every
`var(--l-x)` / `var(--d-x)` referenced in `tokens.css` is declared by
`renderPaletteCss()` (a renamed key would otherwise resolve to nothing = transparent),
and every `PALETTE_KEY` has a `--color-*` line in all three theme blocks. Mobile
builds `{ light, dark }` from the same module. The contrast table
(`.tasks/web-redesign/plan-web.md`) is pinned in `packages/shared/src/palette.test.ts`
for both palettes.

Line 0 split (disjoint files, parallel): **frontend-engineer** — shared palette module
+ css renderer + contrast test + index exports, the Vite plugin, `main.tsx`,
`tokens.css` trim, `tokens.test.ts`, the one sentence in `docs/web.md`.
**mobile-engineer** — everything under `apps/mobile` listed for line 0 in "Lines",
coding `src/theme/tokens.ts` against the shared API below.

Shared API (both engineers code against exactly this):
```ts
// packages/shared/src/palette.ts  (pure data, no imports)
export const PALETTE_KEYS = ['bg','surface','surfaceRaised','surfaceMuted','border',
  'borderStrong','text','textMuted','textSubtle','accent','accentHover','accentFg',
  'accentSoft','accentSoftFg','danger','dangerHover','dangerFg','dangerSoft',
  'dangerSoftFg','success','successFg','successSoft','successSoftFg','warning',
  'warningFg','warningSoft','warningSoftFg','expense','income','transfer','overlay'] as const;
export type PaletteKey = (typeof PALETTE_KEYS)[number];
export type Palette = Readonly<Record<PaletteKey, string>>;   // hex or rgba() strings
export const LIGHT_PALETTE: Palette; export const DARK_PALETTE: Palette;
// packages/shared/src/paletteCss.ts
export function paletteCssName(key: PaletteKey): string;      // surfaceRaised -> surface-raised
export function renderPaletteCss(): string;                   // ":root {\n  --l-bg: …;\n … --d-overlay: …;\n}\n"
```
All six exported from `@budget/shared`'s barrel.

Mobile theme object `t` (from `themedStyles((t) => …)` and `useTheme()`):
`{ scheme, colors: ThemeColors (= Palette), spacing, radius, type, tnum, TOUCH_TARGET,
selected: { chip: ViewStyle, text: TextStyle } }`. Navigator chrome comes from
`src/theme/navigation.ts::useNavigationChrome()` → `{ stack: {...screenOptions},
tabs: {...screenOptions} }` — the ONLY consumer-facing place `fontFamily` is written for
headers/tab labels, used by the root/group/auth Stacks (line 0/A) and the Tabs (line A).
