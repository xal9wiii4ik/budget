// The plan screen's two GOAL-level money fields (mobile-catchup-3, line C) — the
// same decisions as web's features/goals/plan/goalCostFormSchema.ts, written
// against THIS client's dictionary (the messages are dictionary keys, and the two
// key sets are disjoint). The parsing itself is shared (`parseMoney` — exponents
// are never re-implemented).
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
  malformed: 'goalItemForm.amountMalformed',
  negative: 'goalItemForm.amountNegative',
  'too-many-decimals': 'goalItemForm.amountDecimals',
  overflow: 'goalItemForm.amountOverflow',
  // Unreachable: an empty field short-circuits to `null` below. Mapped anyway so
  // the record stays total over MoneyParseError.
  empty: 'goalItemForm.amountMalformed',
} as const satisfies Record<MoneyParseError, string>;

function optionalAmount(currency: string, t: Translate) {
  return z.string().transform((raw, ctx): number | null => {
    const trimmed = raw.trim();
    if (trimmed === '') return null;

    const parsed = parseMoney(trimmed, currency);
    if (!parsed.ok) {
      ctx.addIssue({ code: 'custom', message: t(MESSAGE_KEY[parsed.error], { currency }) });
      return z.NEVER;
    }
    if (parsed.minor < 1) {
      // Mirrors the server's `gt=0` on both columns: telling the user in the
      // field beats a generic 422.
      ctx.addIssue({ code: 'custom', message: t('goalItemForm.amountPositive') });
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
