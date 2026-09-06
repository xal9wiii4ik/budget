# Implementation Plan (mobile): the web design system on the phone

Binding input: `.tasks/mobile-design/task.md`. This file adds only the inventory, the
mechanical recipe, the module/primitive contracts and the gates; disagreements are in
§6, explicit, not acted on.

## 1. Screen / file inventory

`grep -rl "components/theme" src app` returns **51**; it misses the 9 `src/components/*`
files that import `'./theme'`, so the real count reading `colors` is **60** — all below,
plus the three layouts and `app.json`. **R** = recolour via `themedStyles` + semantic
renames. **R+** = R plus a hand-rolled box/tag/empty arm swapped for a primitive.
**S** = structure differs from web and stays (reason in ≤5 words). `c` = `colors.*` reads;
`KB` = keyboardAppearance, `TV` = themeVariant, `W` = raw `'#FFFFFF'` to remove.

| file | ln | c | class | notes |
|---|---|---|---|---|
| `app/_layout.tsx` | 0 | 0 | S | provider + font/pref gate in `Promise.all`; `StatusBar style` from scheme; root Stack `contentStyle` |
| `app/(app)/_layout.tsx` | 0 | 0 | S | guard untouched; add `contentStyle` to the group AND to each of the 7 `presentation:'modal'` screens (R4) |
| `app/(auth)/_layout.tsx` | A | 0 | S | `headerShown:false` — needs `contentStyle: bg` or auth is white in dark |
| `app.json` | 0 | 0 | S | splash `dark.backgroundColor` = `DARK.bg`; `#208AEF` light bg → `LIGHT.bg`; adaptive-icon stays (asset) |
| `src/components/theme.ts` | 0 | — | S | shim: re-export `spacing`/`TOUCH_TARGET` from `src/theme/tokens`; `colors` deleted at close |
| `src/components/FormButton.tsx` | 0 | 8 | R+ | +`variant 'ghost'`, +`size`; W×2 (label + `ActivityIndicator`) → `accentFg`/`dangerFg`/`accent`; `disabled` → `surfaceMuted`+`textSubtle` |
| `src/components/LabeledInput.tsx` | 0 | 7 | R | `KB`; border → `borderStrong`; `placeholderTextColor` → `textSubtle` |
| `src/components/DateField.tsx` | 0 | 8 | R | `TV` on the iOS picker |
| `src/components/AccountPicker.tsx` | A | 9 | R+ | W; chips → accentSoft rule (§6.4); `stateBox` error arm → `EmptyState` |
| `src/components/KindSegmented.tsx` | A | 4 | R | W; selected segment (§6.4) |
| `src/components/FieldError.tsx` | A | 1 | R | `danger` |
| `src/components/HexSwatch.tsx` | A | 2 | S | renders the USER's hex — the one allowed variable colour; `swatchEmpty` → `surfaceMuted` |
| `src/components/KeyboardAwareForm.tsx` | A | 3 | R | scroll-to-error untouched |
| `src/components/LogoutButton.tsx` | A | 3 | R+ | header text action → `FormButton variant="ghost" size="sm"` in place |
| `app/(auth)/login.tsx` | A | 6 | R+ | `banner` `#E7F1FD` → `accentSoft`+`accentSoftFg`; `link` → `accent` |
| `app/(auth)/register.tsx` | A | 5 | R | `link` → `accent` |
| `app/(app)/(tabs)/more.tsx` | A | 8 | R+ | `stateBox`+`error` → `EmptyState`; nav rows → one `Card padding="none"` (list rule) |
| `features/settings/LanguageSection.tsx` | A | 8 | R+ | W; `optionSelected` = the shared segment style (§6.4) |
| `features/settings/BaseCurrencySection.tsx` | A | 12 | R+ | W; `warning` currently `colors.expense` → `warning`; chips |
| `features/settings/MonthlyIncomeSection.tsx` | A | 6 | R | `tnum` on the converted-income sentence |
| `features/settings/ThemeSection.tsx` (new) | A | — | S | `LanguageSection` shape; 4 dict keys, both dicts |
| `app/(app)/(tabs)/_layout.tsx` | A last | 2 | R | `tabBarStyle`/`tabBarLabelStyle`/`headerStyle` from `useTheme()`; AFTER the tab-icons merge |
| `features/transactions/FilterChip.tsx` | B | 5 | R | W; the §2 recipe file; `memo` kept |
| `features/transactions/ChipPicker.tsx` | B | 6 | R | `KB`; placeholder → `textSubtle` |
| `features/transactions/CountryField.tsx` | B | 13 | R | W; `KB`; 30-chip cap untouched |
| `features/transactions/SpendCurrencyPicker.tsx` | B | 9 | R | W; `KB` |
| `features/transactions/TxSearchField.tsx` | B | 5 | R | `KB`; clear glyph → `textSubtle` |
| `features/transactions/MonthPicker.tsx` | B | 2 | R | `memo`; chevrons → `accent` |
| `features/transactions/TxFilterChips.tsx` | B | 3 | R | per-chip clear stays |
| `features/transactions/TxFiltersSheet.tsx` | B | 10 | S | RN `Modal` = own window: owns `useSafeAreaInsets` (D-1) — stays; add `surfaceRaised` bg, `TV`, `KB` |
| `features/transactions/TransactionList.tsx` | B | 8 | S | `StateShell` repeats the widget header above every arm — stays; arms' INNER content → `EmptyState`; `ActivityIndicator color` |
| `features/transactions/TransactionRow.tsx` | B | 6 | R | `memo`; `tnum` on both amounts; income/expense by KIND |
| `features/transactions/TransferRow.tsx` | B | 6 | R | `memo`; `tnum`; `transfer` token for the neutral leg |
| `features/transactions/SummaryHeader.tsx` | B | 14 | R+ | box → `Card`; `tnum` on 3 totals + every breakdown row; neutral total = `text` |
| `features/transactions/GoalItemPicker.tsx` | B | 10 | R | W; chips |
| `features/transactions/AttachPhotoField.tsx` | B | 9 | R+ | `errorBox` → `EmptyState`? no — inline; `action` texts → `ghost` |
| `features/accounts/AccountFilter.tsx` | B | 5 | R | W; chips |
| `features/accounts/AccountList.tsx` | B | 3 | R+ | one `Card padding="none"` + hairline `separator` |
| `features/accounts/AccountRow.tsx` | B | 6 | R | `memo`; `tnum`; `negative` → `expense` only if it is money by kind, else `text` |
| `features/recurring/TemplateRow.tsx` | B | 9 | R+ | `#8A5A00`/`#FDF0D5` `badgePaused`/`badgeEnded` → `Badge tone="warning"/"neutral"`; `tnum` |
| `features/recurring/UpcomingCharges.tsx` | B | 13 | R+ | `card` → `Card`; `#F0F6FF`/`#E7F1FD` → `accentSoft`; `todayBadge` → `Badge tone="accent"`; `errorBox`/`emptyBox` → `EmptyState`; `tnum` |
| `app/(app)/(tabs)/accounts.tsx` | B | 6 | R+ | W; `stateBox`/`error`/`emptyText` → `EmptyState` |
| `app/(app)/recurring.tsx` | B | 8 | R+ | `stateBox` arms → `EmptyState`; header `+` → `ghost` |
| `app/(app)/category-transactions.tsx` | B | 15 | R+ | headline box → `Card`; `TV`; `tnum` on headline; `unconverted` → `warning` |
| `app/(app)/transaction-form.tsx` | B | 17 | S | own `header/title/cancel` (Stack `headerShown:false`) — stays; W; `TV`; `tnum` on the fx-preview text; chips |
| `app/(app)/transfer-form.tsx` | B | 13 | S | same own header; `TV`; `rate` verbatim string gets `tnum` |
| `app/(app)/recurring-form.tsx` | B | 16 | S | same own header; W; chips + `chipCompact` |
| `app/(app)/account-form.tsx` | B | 15 | S | same own header; W; chips |
| `app/(app)/(tabs)/transactions.tsx` | B last | 12 | R+ | W×2; `filtersActive` = selected rule; toolbar buttons recoloured in place; AFTER the blocker-fix merge |
| `features/categories/CategoryList.tsx` | C | 3 | R+ | one `Card padding="none"` + hairline |
| `features/categories/CategoryRow.tsx` | C | 8 | R+ | `memo`; `tags/tag` ("archived") → `Badge tone="neutral"`; `drillText` → `accent` |
| `features/goals/GoalCard.tsx` | C | 13 | S | goals list is genuinely a card per goal (web too) — stays; `good`→`success`, `warn`→`warning`, `tag/tagGood`→`Badge`; `tnum`; `memo` |
| `features/goals/FreeBalanceSummary.tsx` | C | 6 | R+ | `box` → `Card`; `tnum`; exhaustive switch untouched |
| `features/goals/GoalDeadlines.tsx` | C | 10 | R+ | `card`→`Card`; `errorBox`/`empty`→`EmptyState`; `tnum` |
| `features/goals/plan/PlanSummary.tsx` | C | 8 | R+ | `card`→`Card`; `warn` is `colors.expense` on a NON-money warning → `warning`; `tnum` |
| `features/goals/plan/PlanNodeRow.tsx` | C | 15 | R+ | `memo`; same `warn` fix; row actions → `ghost`; `tnum` on `own`/`paid` |
| `features/goals/plan/ItemMoveSheet.tsx` | C | 11 | S | RN `Modal`, not a route (a choice about the row underneath) — stays; `surfaceRaised` bg + insets |
| `features/goals/plan/ItemPhotos.tsx` | C | 10 | R+ | `placeholder` → `surfaceMuted`; `errorBox` inline; `action` texts → `ghost` |
| `app/(app)/(tabs)/goals.tsx` | C | 8 | R+ | W; `stateBox`+`emptyTitle`+`emptyBody`+action → `EmptyState`; error arm → `EmptyState` + retry |
| `app/(app)/(tabs)/categories.tsx` | C | 11 | R+ | W; `KB` on the search box; `stateBox` arms → `EmptyState` |
| `app/(app)/goal-plan.tsx` | C | 19 | S | hand-rolled `screenHeader/back` under `headerShown:false` + ONE FlatList over two datasets behind a segment — both stay; W; `tnum`; `contribution`/`withdrawal` by kind |
| `app/(app)/goal-form.tsx` | C | 15 | S | own header; W; chips |
| `app/(app)/goal-item-form.tsx` | C | 15 | S | own header; W; chips; `linkRemove` → `ghost` |
| `app/(app)/goal-cost-form.tsx` | C | 8 | R | `tnum` on the planned-total sentence |
| `app/(app)/contribution-form.tsx` | C | 13 | S | own header; W; chips |
| `app/(app)/category-form.tsx` | C | 8 | R | `colorInput` + `HexSwatch` (user hex); `notice`/`unavailable` stay inline |

Counts: **R 22 · R+ 24 · S 18** (64 rows).

## 2. Migration recipe — `features/transactions/FilterChip.tsx`

Before (imports + the styles it owns):

```tsx
import { colors, spacing, TOUCH_TARGET } from '../../components/theme';
…
const styles = StyleSheet.create({
  chip: { minHeight: TOUCH_TARGET - 8, paddingHorizontal: spacing.md,
    borderRadius: 18, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.card, justifyContent: 'center' },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 14, color: colors.text },
  chipTextSelected: { color: '#FFFFFF', fontWeight: '600' },
});
export const FilterChip = memo(FilterChipImpl);
```

After:

```tsx
import { themedStyles } from '../../theme/themedStyles';
…
function FilterChipImpl(props: FilterChipProps) {
  const styles = useStyles();          // first line of the component body
  …same JSX, untouched…
}
const useStyles = themedStyles((t) => ({
  chip: { minHeight: t.TOUCH_TARGET - 8, paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.full, borderWidth: 1, borderColor: t.colors.border,
    backgroundColor: t.colors.surface, justifyContent: 'center' },
  chipSelected: { backgroundColor: t.colors.accentSoft, borderColor: t.colors.accent },
  chipText: { fontSize: t.type.sm, color: t.colors.text },
  chipTextSelected: { color: t.colors.accentSoftFg, fontWeight: '600' },
}));
export const FilterChip = memo(FilterChipImpl);
```

Mechanics: rename the const to `useStyles`; `colors.x`→`t.colors.x`, `spacing.x`→
`t.spacing.x`, `TOUCH_TARGET`→`t.TOUCH_TARGET`, numeric `fontSize`→`t.type.*`,
`borderRadius 8|10|12|18`→`t.radius.*`. JSX untouched for an **R** file. A `memo` row
gets the hook identically: `memo` blocks only re-renders from unchanged PROPS, and the
hook subscribes to the theme context, so a scheme flip re-renders every memoised row (R5
stays a QA item). `useStyles` is module-scope, called once per component body, never in
a callback or a `.map`.

`applyTypeface(styles, fontsLoaded)` contract — pure, no RN import, input and output are
plain objects (`StyleSheet.create` runs after it, inside `themedStyles`):
- an entry with neither `fontSize` nor `fontWeight` → returned by identity;
- otherwise `fontWeight ?? '400'` is mapped `400→Inter_400Regular, 500→Inter_500Medium,
  600→Inter_600SemiBold, 700/'bold'→Inter_700Bold` (unsupported numeric weights snap to
  the nearest of the four), `fontFamily` is SET and `fontWeight` is **deleted** — a
  loaded static family plus a weight double-bolds on Android and is ignored on iOS;
- `fontsLoaded === false` → the whole object is returned unchanged, so the system font
  keeps honouring the author's `fontWeight` (the failure arm of decision 3).

## 3. `src/theme/` modules

| module | responsibility | env |
|---|---|---|
| `tokens.ts` | `{light,dark}: ThemeColors` from `@budget/shared` palettes + `spacing/radius/type/tnum/TOUCH_TARGET` | Node-safe |
| `themeStore.ts` | `resolveScheme(pref, system)`, read/validate/write over an injected `PreferenceStorage` | Node-safe |
| `applyTypeface.ts` | weight → family map, per §2 | Node-safe |
| `preferenceStorage.ts` | the ONLY `@react-native-async-storage/async-storage` import (the `secureStore.ts` pattern) | RN |
| `fonts.ts` | `loadFonts(): Promise<boolean>` over `expo-font` + `@expo-google-fonts/inter`; logs once and resolves `false` on failure; SIL OFL note | RN |
| `themedStyles.ts` | the factory hook; cache keyed `` `${scheme}:${fontsLoaded}` `` → at most 2 `StyleSheet.create` per module | RN |
| `ThemeProvider.tsx` | holds preference, resolves scheme (the ONLY `useColorScheme`), `Appearance.setColorScheme`, exposes context | RN |
| `useTheme.ts` | context hook, separate file so `themedStyles` does not cycle through the provider | RN |

Tests (only behaviour that can break): `themeStore.test.ts` — the `resolveScheme`
matrix, and a corrupt/unknown stored value → `'system'` (not a throw, not `'light'`);
`applyTypeface.test.ts` — the four-weight map with `fontWeight` removed, the
`fontsLoaded:false` arm returning the input untouched, and a colour-only style passing
through; `packages/shared/src/palette.test.ts` — the contrast table from
`.tasks/web-redesign/plan-web.md` in BOTH palettes; `apps/web/src/styles/tokens.test.ts`
— drift + every semantic name present in all three blocks. No test for `tokens.ts` (a
data object `tsc` already types) and none for `themedStyles`/`ThemeProvider` (RN, and
the vitest constraint forbids RN in the graph).

## 4. Primitive API (B and C code against these before line 0/A land)

- `Card` — `padding?: 'none'|'sm'|'md' = 'md'`, `style?: StyleProp<ViewStyle>`, `children`.
- `Badge` — `label: string`, `tone?: 'neutral'|'accent'|'success'|'danger'|'warning' = 'neutral'`, `style?`.
- `EmptyState` — `title: string`, `description?: string`, `action?: ReactNode`, `role?: 'alert'` (sets `accessibilityRole` for the error arm), `style?`.
- `FormButton` — `label`, `onPress`, `variant?: 'primary'|'secondary'|'danger'|'ghost' = 'primary'`, `size?: 'sm'|'md' = 'md'` (md ≥44pt, sm ≥36pt with ≥44pt `hitSlop`), `disabled?`, `pending?`, `style?`.
- `LabeledInput` — unchanged props + internal `keyboardAppearance={scheme}`, `borderStrong` border, `textSubtle` placeholder.
- `DateField` — unchanged props + internal `themeVariant={scheme}` on the iOS picker.
- `ThemeSection` — no props; `LanguageSection` shape, `accessibilityRole="tab"` per option.

## 5. Grep gates (run at close; from the repo root)

```sh
# 1. no colour literal in mobile code (app.json is config, HexSwatch takes a prop)
grep -rEn "#[0-9a-fA-F]{3,8}'|rgba?\(" apps/mobile/src apps/mobile/app          # expect: empty
# 2. no fontFamily outside src/theme
grep -rn "fontFamily" apps/mobile/src apps/mobile/app | grep -v "src/theme/"     # expect: empty
# 3. no useColorScheme outside the provider
grep -rn "useColorScheme" apps/mobile/src apps/mobile/app \
  | grep -v "src/theme/ThemeProvider.tsx"                                        # expect: empty
# 4. every money file spreads tnum
for f in $(grep -rl "formatMoney\|formatAmount" apps/mobile/src apps/mobile/app); do
  grep -q "tnum" "$f" || echo "MISSING tnum: $f"; done   # allowed: src/i18n/context.ts (a comment)
# 5. no StyleSheet.create holding a colour
for f in $(grep -rl "StyleSheet.create" apps/mobile/src apps/mobile/app); do
  awk '/StyleSheet\.create\(/,0' "$f" | grep -qi "olor" && echo "COLOUR: $f"; done # expect: empty
# 6. the shim lost its colours
grep -n "colors" apps/mobile/src/components/theme.ts                             # expect: empty
```

Gate 5 still ALLOWS a colourless `StyleSheet.create` (`KeyboardAwareForm`'s
`flex/content/footer`) — converting pure-layout sheets costs a subscription for nothing.

## 6. Open questions for senior-lead (disagreements stated, not acted on)

1. **"51 files" undercounts by 9** — the nine `src/components/*.tsx` import `'./theme'`,
   which the grep misses; the real number is **60**, and line A grows by those 9.
2. **The four primitive EXTENSIONS must move from line A to line 0.** Lines B and C are
   told to use `FormButton variant="ghost"`/`size` and the themed `LabeledInput`/
   `DateField`, but their gate is `pnpm --filter @budget/mobile typecheck` — which fails
   until A has widened the union. Either line 0 ships `FormButton`/`LabeledInput`/
   `DateField` next to the three new shells (my recommendation, +5 min on line 0, table
   above already assigns them to 0), or B/C must not use `ghost` at all this scope.
3. **`expo-font` is not a listed dependency** — `apps/mobile/package.json` has no entry
   and decision 3 names only `@expo-google-fonts/inter`; `Font.loadAsync` needs it too.
   A native module by the letter of the rule, so I confirm rather than assume.
4. **`accentSoft` as the selected chip/segment fill is invisible here.** Measured on the
   shipped palette: accentSoft/surface 1.13 light, 1.14 dark; accentSoft/**surfaceRaised**
   **1.04** dark — the selected chip inside `TxFiltersSheet` and `ItemMoveSheet` (both
   `surfaceRaised`) has no visible fill at all. Web survives this on hover + focus ring;
   a finger has neither. The `-soft-fg` text is fine (6.96 / 7.98), but in dark
   `accentSoftFg #aeb6ff` vs `textMuted #a3acbb` is a hue shift at equal lightness.
   **Proposal:** selected = `accentSoft` fill + `accentSoftFg` text + `borderColor:
   accent` (a 1pt border is the phone's substitute for hover/focus), for `FilterChip`,
   the 9 `chipSelected` sets, `KindSegmented`, `LanguageSection`/`ThemeSection`,
   `filtersActive`. Without the border I would keep a filled `accent` on `KindSegmented`
   specifically — a missed kind selection is a wrong row.
5. **`warn: { color: colors.expense }` is not only GoalCard's** — `PlanSummary`,
   `PlanNodeRow` and `BaseCurrencySection` paint a ceiling-exceeded / unconverted notice
   with the EXPENSE money colour. Task.md names only GoalCard; I read "colour by meaning"
   as covering all four and marked them so. Confirm.
6. **expo-router 57 exposes no `ThemeProvider` we can depend on** — `@react-navigation/*`
   is not a direct dep, so `screenOptions` is the WHOLE mechanism, not a fallback.
   Related: `(app)/_layout.tsx` sets `headerShown:false` and three pushed screens
   re-enable it locally; per-screen options MERGE over `screenOptions`, so group-level
   `headerStyle`/`headerTintColor` reaches them. But `app/(auth)/_layout.tsx` has its own
   Stack and is absent from task.md's line list — without `contentStyle` there,
   login/register is white in dark. I put it on line A.
7. **`goal-plan.tsx` hand-rolls a header** while the group Stack hides the native one,
   so "native headers own the title" does not hold there. I keep it (marked `S`) under
   rule 4; flipping it to a native header is a behaviour change, not a recolour.

## 7. Estimate (agent-minutes, mine vs task.md)

| line | writing (mine / task) | gates (mine / task) | why the difference |
|---|---|---|---|
| 0 | **40** / 25 | **10** / 8 | 30-key palette ×2 + a CSS parser test + 9 theme modules + 3 shells + the 4 extensions moved in (§6.2) |
| A | **25** / 20 | **8** / 5 | +9 `src/components/*` files (§6.1) + `(auth)/_layout` + new `ThemeSection` |
| B | **45** / 30 | **10** / 8 | 20 files, ~5 400 lines, 4 forms with own headers, 13 `tnum` sites |
| C | **35** / 25 | **8** / 5 | 13 files, ~3 700 lines, the goals `warn` fix (§6.5) |
| close + QA | **15** / 10 | **8** / 5 | 6 gates + `docs/mobile.md` "Design system" |

Wall-clock unchanged in shape: 0 (50) → A‖B‖C (55) → close + QA (75) → one fix round
(30) ≈ 3 h 30. The extra ~30 min over task.md is §6.1 + §6.2 — work that exists either
way, just not counted.
