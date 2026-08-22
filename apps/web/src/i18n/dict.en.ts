// The ENGLISH dictionary — the source of truth for the key set.
//
// `keyof typeof en` is the `MessageKey` type (t.ts), and dict.ru.ts is annotated
// with a mapped type over this object: a key added here and forgotten in ru, or a
// plural entry written as a plain string, fails `pnpm typecheck` rather than
// silently rendering a raw key in production. That type safety is the whole
// reason this layer is hand-written instead of pulling in i18next (plan-web S5).
//
// Keys are dotted namespaces by SCREEN/AREA, and values interpolate `{name}`
// placeholders. Copy for error CODES does not live here — it is shared with
// mobile (`ERROR_MESSAGES` in @budget/shared) and reached through lib/errors.ts.
//
// Phase 1 seeds only what phase 1 renders (the settings language section) plus
// the one plural entry the counting screens need. The full screen sweep is
// phase 2.
import type { PluralForms } from './types';

export const en = {
  'settings.language.title': 'Language',
  'settings.language.lede':
    'Sets the language of the interface, and the way dates and numbers are ' +
    'written. It is saved to your profile, so the mobile app follows the same ' +
    'choice.',
  'settings.language.label': 'Interface language',
  'settings.language.saving': 'Saving…',
  'settings.language.saveFailed':
    "Couldn't save this to your profile — it still applies on this device.",

  // Used by the top-merchants list and the unconverted notices (phase 2). It is
  // seeded now because the Russian forms are the part a hand-rolled dictionary
  // gets wrong, and t.test.ts pins them.
  transactionCount: {
    one: '{count} transaction',
    other: '{count} transactions',
  } satisfies PluralForms,
};
