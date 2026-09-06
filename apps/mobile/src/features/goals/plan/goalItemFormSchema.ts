// The plan-item form's schema (mobile-catchup-3, line C) — the same DECISIONS as
// web's features/goals/plan/goalItemFormSchema.ts, written against THIS client's
// dictionary.
//
// It is not shared code: every message it produces is a dictionary KEY, and the
// two dictionaries are disjoint key sets by design (mobile has ~90 keys, web ~700).
// What IS shared is the money parsing (`parseMoney` — per-currency exponents are
// never re-implemented) and the resulting PATCH diff (`buildGoalItemPatch`, moved
// into @budget/api-client by this scope).
//
// A factory over BOTH currencies and `t`:
//   * the ITEM's currency is a form FIELD, so the amount's exponent is only known
//     per submitted value — an object-level transform, like the multi-currency
//     transaction form;
//   * the GOAL's currency decodes the second amount, and decides whether that
//     second amount may exist at all.
//
// The rules that mirror the server so a correct form can never collect a 422:
//   * an item's own amount is OPTIONAL (a grouping node has none) — "" is null,
//     not an error;
//   * a second amount is only meaningful when the currencies DIFFER and there is
//     an amount to convert; otherwise it is dropped;
//   * the reminder is EXACTLY ONE of the two intents, or none.
//
// Deliberately unlike web: `links` is an ARRAY of strings here, not one textarea
// split on newlines — a phone keyboard has no comfortable multi-line paste, so
// the form renders one input per link and the schema receives them as they are.
import type { GoalItemFormValues } from '@budget/api-client';
import { parseMoney, type MoneyParseError } from '@budget/shared';
import { z } from 'zod';

import type { Translate } from '../../../i18n/t';
import type { RemindMode } from './remindPreview';

const NAME_MAX = 100;
const DESCRIPTION_MAX = 2000;
export const LINKS_MAX = 10;
const LINK_MAX_LENGTH = 2048;
const REMIND_DAYS_MAX = 365;
const API_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WHOLE_NUMBER_PATTERN = /^\d+$/;

const MONEY_MESSAGE_KEY = {
  empty: 'goalItemForm.amountMalformed',
  malformed: 'goalItemForm.amountMalformed',
  negative: 'goalItemForm.amountNegative',
  'too-many-decimals': 'goalItemForm.amountDecimals',
  overflow: 'goalItemForm.amountOverflow',
} as const satisfies Record<MoneyParseError, string>;

/**
 * @param goalCurrency the goal's own currency, echoed by `GoalItemList`
 *   (`goal_currency`) — the currency the second amount is denominated in.
 */
export function goalItemFormSchema(goalCurrency: string, t: Translate) {
  return z
    .object({
      name: z.string(),
      description: z.string(),
      links: z.array(z.string()),
      amount: z.string(),
      currency: z.string(),
      converted: z.string(),
      deadline: z.string(),
      remind_mode: z.enum(['none', 'on', 'days']),
      remind_on: z.string(),
      remind_days_before: z.string(),
    })
    .transform((values, ctx): GoalItemFormValues => {
      let ok = true;

      const name = values.name.trim();
      if (name === '') {
        ok = false;
        ctx.addIssue({ code: 'custom', path: ['name'], message: t('goalItemForm.nameRequired') });
      } else if (name.length > NAME_MAX) {
        ok = false;
        ctx.addIssue({
          code: 'custom',
          path: ['name'],
          message: t('goalItemForm.nameTooLong', { max: NAME_MAX }),
        });
      }

      const description = values.description.trim();
      if (description.length > DESCRIPTION_MAX) {
        ok = false;
        ctx.addIssue({
          code: 'custom',
          path: ['description'],
          message: t('goalItemForm.descriptionTooLong', { max: DESCRIPTION_MAX }),
        });
      }

      // Blank entries are dropped, exactly as the server's `clean_links` does; the
      // FORMAT is deliberately not validated (its rule: a deep link or an
      // intranet address is not a mistake).
      const links = values.links.map((link) => link.trim()).filter((link) => link !== '');
      if (links.length > LINKS_MAX) {
        ok = false;
        ctx.addIssue({
          code: 'custom',
          path: ['links'],
          message: t('goalItemForm.tooManyLinks', { max: LINKS_MAX }),
        });
      }
      if (links.some((link) => link.length > LINK_MAX_LENGTH)) {
        ok = false;
        ctx.addIssue({
          code: 'custom',
          path: ['links'],
          message: t('goalItemForm.linkTooLong', { max: LINK_MAX_LENGTH }),
        });
      }

      // --- money -------------------------------------------------------------
      const currency = values.currency;
      const rawAmount = values.amount.trim();
      let amountMinor: number | null = null;
      if (rawAmount !== '') {
        const parsed = parseMoney(rawAmount, currency);
        if (!parsed.ok) {
          ok = false;
          ctx.addIssue({
            code: 'custom',
            path: ['amount'],
            message: t(MONEY_MESSAGE_KEY[parsed.error], { currency }),
          });
        } else if (parsed.minor < 1) {
          ok = false;
          ctx.addIssue({
            code: 'custom',
            path: ['amount'],
            message: t('goalItemForm.amountPositive'),
          });
        } else {
          amountMinor = parsed.minor;
        }
      }

      // The second amount exists ONLY for a foreign-currency item that has an
      // amount at all. In every other case it is dropped rather than rejected:
      // the section is not on screen then, so a leftover value is stale state,
      // not user intent.
      const rawConverted = values.converted.trim();
      let convertedMinor: number | null = null;
      if (rawConverted !== '' && currency !== goalCurrency && amountMinor !== null) {
        const parsed = parseMoney(rawConverted, goalCurrency);
        if (!parsed.ok) {
          ok = false;
          ctx.addIssue({
            code: 'custom',
            path: ['converted'],
            message: t(MONEY_MESSAGE_KEY[parsed.error], { currency: goalCurrency }),
          });
        } else if (parsed.minor < 1) {
          ok = false;
          ctx.addIssue({
            code: 'custom',
            path: ['converted'],
            message: t('goalItemForm.amountPositive'),
          });
        } else {
          convertedMinor = parsed.minor;
        }
      }

      // --- dates and the reminder intent -------------------------------------
      const rawDeadline = values.deadline.trim();
      let deadline: string | null = null;
      if (rawDeadline !== '') {
        if (!API_DATE_PATTERN.test(rawDeadline)) {
          ok = false;
          ctx.addIssue({
            code: 'custom',
            path: ['deadline'],
            message: t('goalItemForm.badDate'),
          });
        } else {
          deadline = rawDeadline;
        }
      }

      const mode: RemindMode = values.remind_mode;
      let remindOn: string | null = null;
      let remindDaysBefore: number | null = null;

      if (mode === 'on') {
        const raw = values.remind_on.trim();
        if (raw === '') {
          ok = false;
          ctx.addIssue({
            code: 'custom',
            path: ['remind_on'],
            message: t('goalItemForm.remindDateRequired'),
          });
        } else if (!API_DATE_PATTERN.test(raw)) {
          ok = false;
          ctx.addIssue({
            code: 'custom',
            path: ['remind_on'],
            message: t('goalItemForm.badDate'),
          });
        } else {
          remindOn = raw;
        }
      } else if (mode === 'days') {
        const raw = values.remind_days_before.trim();
        if (raw === '' || !WHOLE_NUMBER_PATTERN.test(raw)) {
          ok = false;
          ctx.addIssue({
            code: 'custom',
            path: ['remind_days_before'],
            message: t('goalItemForm.remindDaysRequired', { max: REMIND_DAYS_MAX }),
          });
        } else {
          const days = Number(raw);
          if (days > REMIND_DAYS_MAX) {
            ok = false;
            ctx.addIssue({
              code: 'custom',
              path: ['remind_days_before'],
              message: t('goalItemForm.remindDaysRequired', { max: REMIND_DAYS_MAX }),
            });
          } else {
            remindDaysBefore = days;
          }
        }
      }

      if (!ok) return z.NEVER;

      return {
        name,
        description: description === '' ? null : description,
        links,
        amount_minor: amountMinor,
        currency,
        converted_minor: convertedMinor,
        deadline,
        remind_on: remindOn,
        remind_days_before: remindDaysBefore,
      };
    });
}

export type GoalItemFormInput = z.input<ReturnType<typeof goalItemFormSchema>>;
