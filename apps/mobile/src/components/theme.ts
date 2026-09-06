// MIGRATION SHIM (mobile-design line 0). The single source of design tokens is
// now `src/theme/` — `spacing` and `TOUCH_TARGET` are re-exported from
// `src/theme/tokens.ts` so the ~60 files that import them here keep working
// while the recolour lands line by line.
//
// `colors` below is the OLD static palette and is DEAD by design: it cannot
// follow a theme (a module-level StyleSheet.create is evaluated once at import).
// It survives only until lines A/B/C have moved their last screen onto
// `themedStyles`, and is DELETED at scope close — at which point `tsc` proves
// no static colour is left anywhere in the app.
export { spacing, TOUCH_TARGET } from '../theme/tokens';

export const colors = {
  bg: '#F5F6F8',
  card: '#FFFFFF',
  border: '#E2E5EA',
  text: '#1A1D21',
  textMuted: '#6B7280',
  primary: '#208AEF',
  danger: '#D14343',
  income: '#1F8A4C',
  expense: '#C43E3E',
  swatchEmpty: '#D1D5DB',
  disabled: '#A9BCD0',
} as const;
