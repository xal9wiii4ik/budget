// The plan screen's two GOAL-level money fields (goal-planner W1).
//
// Web-local for the `incomeFormSchema` reason: the shared schemas exist because
// two clients validate the same form, and the mobile client is frozen and has no
// plan screen. The parsing itself is still shared (`parseMoney` — per-currency
// exponents are never re-implemented).
//
// Both fields are OPTIONAL and clearable, so an empty field is not an error but
// `null`, which is exactly what the PATCH sends to clear the column:
//   final_cost_override — "the goal costs this much, whatever the items add up
//                         to"; cleared = go back to the bottom-up sum;
//   initial_budget      — "I am putting this much aside for it"; cleared = none.
// Neither is create-time: `GoalCreate` carries no such field on the contract.
import { parseMoney, type MoneyParseError } from '@budget/shared';
import { z } from 'zod';

import type { Translate } from '../../../i18n/t';

const MESSAGE_KEY = {
  malformed: 'goalItemForm.error.amountMalformed',
  negative: 'goalItemForm.error.amountNegative',
  'too-many-decimals': 'goalItemForm.error.amountDecimals',
  overflow: 'goalItemForm.error.amountOverflow',
  // Unreachable: an empty field short-circuits to `null` below. Mapped anyway so
  // the record stays total over MoneyParseError.
  empty: 'goalItemForm.error.amountMalformed',
} as const satisfies Record<MoneyParseError, string>;

function optionalAmount(currency: string, t: Translate) {
  return z.string().transform((raw, ctx): number | null => {
    const trimmed = raw.trim();
    if (trimmed === '') return null;

    const parsed = parseMoney(trimmed, currency);
    if (!parsed.ok) {
      ctx.addIssue({
        code: 'custom',
        params: { reason: parsed.error },
        message: t(MESSAGE_KEY[parsed.error], { currency }),
      });
      return z.NEVER;
    }
    if (parsed.minor < 1) {
      // Mirrors the server's `gt=0` on both columns: telling the user in the
      // field beats a generic 422.
      ctx.addIssue({ code: 'custom', message: t('goalItemForm.error.amountPositive') });
      return z.NEVER;
    }
    return parsed.minor;
  });
}

export function goalCostFormSchema(currency: string, t: Translate) {
  return z.object({
    final_cost: optionalAmount(currency, t),
    initial_budget: optionalAmount(currency, t),
  });
}

export type GoalCostFormInput = z.input<ReturnType<typeof goalCostFormSchema>>;
export type GoalCostFormValues = z.output<ReturnType<typeof goalCostFormSchema>>;
