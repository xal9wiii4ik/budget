import { parseMoney, type MoneyParseError } from '@budget/shared';
import { z } from 'zod';

import type { Translate } from '../../i18n/t';

/**
 * The declared-monthly-income form (D2).
 *
 * It lives beside the feature rather than in `@budget/shared` for the
 * `tokenFormSchema` reason (senior-lead ruling): the shared schemas exist because
 * two clients validate the same form, and there is no second consumer — the
 * mobile client is frozen and has no settings screen.
 *
 * It is a factory over BOTH the currency (the `categoryLimitFormSchema`
 * precedent: the exponent that decides how many decimals are legal is bound at
 * construction) and `t` (the messages are user-facing copy and must follow the
 * chosen language).
 *
 * The ONE thing this form does that the other money forms do not: an EMPTY field
 * is not an error, it is `null` — "I am not declaring an income", which is what
 * the server stores to clear it (D2). So `empty` never reaches the message map.
 */
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
