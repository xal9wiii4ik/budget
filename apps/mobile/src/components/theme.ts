// MIGRATION SHIM (mobile-design line 0). The single source of design tokens is
// now `src/theme/` — `spacing` and `TOUCH_TARGET` are re-exported from
// `src/theme/tokens.ts` so the ~60 files that import them here keep working
// while the recolour lands line by line.
//
// The old static `colors` palette that used to live here is gone: every screen
// reads the theme through `themedStyles`, and `tsc` is what proves it.
export { spacing, TOUCH_TARGET } from '../theme/tokens';
