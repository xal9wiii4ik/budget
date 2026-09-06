// The declared-monthly-income form (catch-up 3, line B).
//
// COPY of apps/web/src/features/settings/incomeFormSchema.ts rather than a move
// into `@budget/shared`: promoting it is a cross-package change, and this line's
// scope ends at apps/mobile. If a third consumer ever appears, THAT is the moment
// to move it (and to take web's test with it).
//
// It is a factory over BOTH the currency (the exponent that decides how many
// decimals are legal is bound at construction) and `t` (the messages are
// user-facing copy and must follow the chosen language).
//
// The ONE thing this form does that the other money forms do not: an EMPTY field
// is not an error, it is `null` — "I am not declaring an income", which is what
// the server stores to clear it. So `empty` never reaches the message map.
import { parseMoney, type MoneyParseError } from '@budget/shared';
import { z } from 'zod';

import type { Translate } from '../../i18n/t';

const MESSAGE_KEY = {
  malformed: 'settings.income.error.malformed',
  negative: 'settings.income.error.negative',
  'too-many-decimals': 'settings.income.error.tooManyDecimals',
  overflow: 'settings.income.error.overflow',
  // Unreachable: an empty field short-circuits to `null` above. Mapped anyway so
  // the record is total over MoneyParseError and a new code fails typecheck.
  empty: 'settings.income.error.malformed',
} as const satisfies Record<MoneyParseError, string>;

export function incomeFormSchema(currency: string, t: Translate) {
  return z.object({
    income: z.string().transform((raw, ctx): number | null => {
      const trimmed = raw.trim();
      if (trimmed === '') return null;

      const result = parseMoney(trimmed, currency);
      if (!result.ok) {
        ctx.addIssue({
          code: 'custom',
          params: { reason: result.error },
          message: t(MESSAGE_KEY[result.error], { currency }),
        });
        return z.NEVER;
      }
      return result.minor;
    }),
  });
}

export type IncomeFormInput = z.input<ReturnType<typeof incomeFormSchema>>;
export type IncomeFormValues = z.output<ReturnType<typeof incomeFormSchema>>;
