import { z } from 'zod';
import { CURRENCY_CODE_PATTERN } from './currencies';
import { parseMoney, type MoneyParseError } from './money';

// Shape validation for an ISO-4217 currency code (alpha-3, uppercase).
export const currencyCodeSchema = z.string().regex(CURRENCY_CODE_PATTERN);

// Internal English default messages (plan AM4). NOT exported: clients map/override
// messages via the issue's `params.reason` (the MoneyParseError code) for i18n.
// The contract clients depend on is `params.reason`, not this text.
const MONEY_ERROR_MESSAGES: Record<MoneyParseError, string> = {
  empty: 'Enter an amount.',
  malformed: 'Enter a valid amount.',
  negative: 'Amount must not be negative.',
  'too-many-decimals': 'Too many decimal places for this currency.',
  overflow: 'Amount is too large.',
};

// Factory: fixed-currency amount field. string "12.50" -> number 1250 (minor
// units), with per-currency exponent validation surfaced as a zod issue whose
// `params.reason` is the MoneyParseError code (plan D8 + AM4).
export function moneyAmountSchema(currency: string) {
  return z.string().transform((raw, ctx) => {
    const result = parseMoney(raw, currency);
    if (!result.ok) {
      ctx.addIssue({
        code: 'custom',
        params: { reason: result.error },
        message: MONEY_ERROR_MESSAGES[result.error],
      });
      return z.NEVER;
    }
    return result.minor;
  });
}

// --- Auth form schemas (web-auth-flow AM-1) -------------------------------
// Shared between web (task 1.5) and mobile (task 1.8) so both clients validate
// identically. Messages here are DEFAULTS only, not a contract: like
// MONEY_ERROR_MESSAGES they may be overridden/localised by a client — tests key
// on the zod issue shape (path/code), never on this English text.

// A syntactically valid email address (zod 4 top-level format validator).
export const emailSchema = z.email({ error: 'Enter a valid email address.' });

// Login: email must be well-formed; password must be non-empty. Login does NOT
// re-run registration's length policy — an existing short password must still be
// submittable so the server can authenticate it (plan E16).
export const loginFormSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, { error: 'Enter your password.' }),
});

// Register: password min length 8 mirrors the server's validate_password exactly
// (1.1 R3 — length >= 8, nothing fancier). email+password only; the stock
// BaseUserCreate privilege fields are ignored server-side (carry-forward 3).
export const registerFormSchema = z.object({
  email: emailSchema,
  password: z.string().min(8, { error: 'Password must be at least 8 characters.' }),
});

export type LoginFormValues = z.infer<typeof loginFormSchema>;
export type RegisterFormValues = z.infer<typeof registerFormSchema>;

// --- Transaction / category form schemas (web 1.6, mobile 1.8) -------------
// Shared so both clients enforce the SAME server-mirroring rules (note <= 500,
// amount-minor per-currency exponent, hex-color pattern). Boundary condition
// (senior diff gate): this file imports ONLY zod + shared's own money helpers —
// no react-hook-form, no web modules. The RHF resolver and the ""-> null bridge
// live in apps/web (lib/patch.ts). Optional string fields carry "" (the RHF empty
// sentinel) here; the patch builder interprets "" downstream. `kind` is inlined
// per form (no shared cross-enum alias — T5); both enums are structurally equal.

// Case-insensitive 6-digit hex (C7): never assume canonical casing.
export const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

// amount via moneyAmountSchema (magnitude only; sign carried by kind — T4/T8).
// category_id/note carry "" when empty. occurred_at is a required "YYYY-MM-DD".
//
// @deprecated single-currency form; web uses multiCurrencyTransactionFormSchema
// since 3.2 (the currency is a form field there, so the amount exponent cannot be
// bound at factory time). Kept byte-identical while apps/mobile is frozen —
// removal trigger: the mobile unfreeze task adopts the multi-currency factory.
export function transactionFormSchema(currency: string) {
  return z.object({
    amount: moneyAmountSchema(currency),
    kind: z.enum(['expense', 'income']),
    category_id: z.string(),
    occurred_at: z.string().min(1, { error: 'Choose a date.' }),
    note: z.string().max(500, { error: 'Note must be 500 characters or fewer.' }),
  });
}

// name trimmed, min 1; kind required; icon/color optional (carry ""). color, when
// present, must match the case-insensitive hex pattern (C7).
export const categoryFormSchema = z.object({
  name: z.string().trim().min(1, { error: 'Enter a name.' }),
  kind: z.enum(['expense', 'income']),
  icon: z.string(),
  color: z
    .string()
    .refine((v) => v === '' || HEX_COLOR_PATTERN.test(v), {
      error: 'Enter a 6-digit hex color like #3366FF.',
    }),
});

// The output (post-transform) shapes: `amount` is the parsed minor number. The
// patch builders in apps/web consume these; useForm holds the *Input variants.
export type TransactionFormInput = z.input<ReturnType<typeof transactionFormSchema>>;
export type TransactionFormValues = z.output<ReturnType<typeof transactionFormSchema>>;
export type CategoryFormValues = z.output<typeof categoryFormSchema>;

// --- Multi-currency transaction form (3.2 W1, WD-2) ------------------------
// The currency is now a FORM FIELD, so the amount's exponent is only known per
// submitted value — a per-field moneyAmountSchema(fixedCurrency) cannot see it.
// Hence one object-level transform that validates both money fields against the
// currency each is denominated in (AM-5 decode discipline at the parse side):
//
//   amount      -> parsed with the SELECTED currency (values.currency)
//   base_amount -> parsed with the BASE currency (the factory argument)
//
// `base_amount` is the requirement-3 converted section's field. Its "" is the
// AUTO sentinel: "" -> base_amount_minor: null, meaning "no user override"
// (create omits the key, PATCH sends an explicit null to discard a stored one —
// interpreted by buildCreateBody / buildTransactionPatch, never here).
//
// When the selected currency IS the base currency, base_amount_minor is null
// unconditionally: a base-currency row's amount_minor already IS its base amount
// and the server 422s (BASE_AMOUNT_WITHOUT_CURRENCY) on a second copy. The guard
// starts here so a stale string left in a hidden field can never reach the wire.
//
// `currency` is the free ^[A-Z]{3}$ shape, NOT z.enum(SUPPORTED_CURRENCIES): the
// server is format-only, the receipts confirm flow must be able to submit a
// parsed out-of-set code, and the picker's option list is what gates the UI.
//
// `merchant` (receipts S6 / R3) is OPTIONAL and additive on purpose: only the
// receipt confirm mode renders that input, and every other caller — create, edit,
// and the frozen mobile client, which uses `transactionFormSchema` above and
// never this factory — simply omits the key. Its 255 cap mirrors the server's
// `_MERCHANT_MAX` the way `note`'s 500 mirrors `_NOTE_MAX`.
const MERCHANT_MAX = 255;

export function multiCurrencyTransactionFormSchema(baseCurrency: string) {
  return z
    .object({
      amount: z.string(),
      currency: currencyCodeSchema,
      base_amount: z.string(),
      kind: z.enum(['expense', 'income']),
      category_id: z.string(),
      occurred_at: z.string().min(1, { error: 'Choose a date.' }),
      note: z.string().max(500, { error: 'Note must be 500 characters or fewer.' }),
      merchant: z
        .string()
        .max(MERCHANT_MAX, { error: `Merchant must be ${MERCHANT_MAX} characters or fewer.` })
        .optional(),
    })
    .transform((values, ctx) => {
      const amount = parseMoney(values.amount, values.currency);
      if (!amount.ok) {
        ctx.addIssue({
          code: 'custom',
          path: ['amount'],
          params: { reason: amount.error },
          message: MONEY_ERROR_MESSAGES[amount.error],
        });
      }

      let baseAmountMinor: number | null = null;
      let baseAmountOk = true;
      if (values.currency !== baseCurrency && values.base_amount.trim() !== '') {
        const baseAmount = parseMoney(values.base_amount, baseCurrency);
        if (baseAmount.ok) {
          baseAmountMinor = baseAmount.minor;
        } else {
          baseAmountOk = false;
          ctx.addIssue({
            code: 'custom',
            path: ['base_amount'],
            params: { reason: baseAmount.error },
            message: MONEY_ERROR_MESSAGES[baseAmount.error],
          });
        }
      }

      if (!amount.ok || !baseAmountOk) return z.NEVER;

      return {
        amount: amount.minor,
        currency: values.currency,
        base_amount_minor: baseAmountMinor,
        kind: values.kind,
        category_id: values.category_id,
        occurred_at: values.occurred_at,
        note: values.note,
        // An absent field folds to the same "" sentinel an emptied input carries,
        // so consumers have one rule ("" = no merchant) instead of two. The
        // ""->null bridge stays downstream (emptyToNull), as for note.
        merchant: values.merchant ?? '',
      };
    });
}

export type MultiCurrencyTransactionFormInput = z.input<
  ReturnType<typeof multiCurrencyTransactionFormSchema>
>;
export type MultiCurrencyTransactionFormValues = z.output<
  ReturnType<typeof multiCurrencyTransactionFormSchema>
>;

// --- Goal form (3.2 W3, WD-2) ----------------------------------------------
// Object-level like the multi-currency transaction form and for the same reason:
// `currency` is a FORM FIELD, so `target` (and the create-only `initial_saved`)
// can only be parsed against the currency the user has selected right now — a
// per-field moneyAmountSchema(fixed) cannot see it. NOT a factory: there is no
// second currency involved (unlike the transaction form's base), so nothing is
// left to bind at construction time.
//
// Empty-string sentinels (the RHF empty convention, interpreted here once):
//   deadline      "" -> null  (no deadline; PATCH turns that into an explicit
//                              clear via buildGoalPatch — the one user-owned
//                              nullable field, D12)
//   priority      "" -> null  ("append last" on create; on edit the patch builder
//                              omits the key, so the stored priority is kept)
//   initial_saved "" -> null  (create-only field; no opening contribution row)
//
// The magnitude floors mirror the server's `ge=1` on target_minor /
// initial_saved_minor: a zero target would 422, and telling the user that in the
// field beats a generic form error.
const GOAL_NAME_MAX = 100;
const API_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WHOLE_NUMBER_PATTERN = /^\d+$/;

export const goalFormSchema = z
  .object({
    name: z.string().trim().min(1, { error: 'Enter a name.' }),
    target: z.string(),
    currency: currencyCodeSchema,
    deadline: z.string(),
    priority: z.string(),
    initial_saved: z.string(),
  })
  .transform((values, ctx) => {
    let ok = true;

    if (values.name.length > GOAL_NAME_MAX) {
      ok = false;
      ctx.addIssue({
        code: 'custom',
        path: ['name'],
        message: `Name must be ${GOAL_NAME_MAX} characters or fewer.`,
      });
    }

    const target = parseMoney(values.target, values.currency);
    let targetMinor = 0;
    if (!target.ok) {
      ok = false;
      ctx.addIssue({
        code: 'custom',
        path: ['target'],
        params: { reason: target.error },
        message: MONEY_ERROR_MESSAGES[target.error],
      });
    } else if (target.minor < 1) {
      ok = false;
      ctx.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'Set a target greater than zero.',
      });
    } else {
      targetMinor = target.minor;
    }

    const rawDeadline = values.deadline.trim();
    let deadline: string | null = null;
    if (rawDeadline !== '') {
      if (!API_DATE_PATTERN.test(rawDeadline)) {
        ok = false;
        ctx.addIssue({ code: 'custom', path: ['deadline'], message: 'Enter a valid date.' });
      } else {
        deadline = rawDeadline;
      }
    }

    const rawPriority = values.priority.trim();
    let priority: number | null = null;
    if (rawPriority !== '') {
      const parsed = Number(rawPriority);
      if (!WHOLE_NUMBER_PATTERN.test(rawPriority) || !Number.isSafeInteger(parsed)) {
        ok = false;
        ctx.addIssue({
          code: 'custom',
          path: ['priority'],
          message: 'Enter a whole number (lower runs first).',
        });
      } else {
        priority = parsed;
      }
    }

    const rawInitial = values.initial_saved.trim();
    let initialSavedMinor: number | null = null;
    if (rawInitial !== '') {
      const initial = parseMoney(rawInitial, values.currency);
      if (!initial.ok) {
        ok = false;
        ctx.addIssue({
          code: 'custom',
          path: ['initial_saved'],
          params: { reason: initial.error },
          message: MONEY_ERROR_MESSAGES[initial.error],
        });
      } else if (initial.minor < 1) {
        ok = false;
        ctx.addIssue({
          code: 'custom',
          path: ['initial_saved'],
          message: 'Enter an amount greater than zero.',
        });
      } else {
        initialSavedMinor = initial.minor;
      }
    }

    if (!ok) return z.NEVER;

    return {
      name: values.name,
      target_minor: targetMinor,
      currency: values.currency,
      deadline,
      priority,
      initial_saved_minor: initialSavedMinor,
    };
  });

export type GoalFormInput = z.input<typeof goalFormSchema>;
export type GoalFormValues = z.output<typeof goalFormSchema>;

// --- Contribution form (3.2 W4, WD-2) --------------------------------------
// The API takes a SIGNED `amount_minor` (a withdrawal is a negative row, D10).
// The form collects a MAGNITUDE plus a direction — the T4 magnitude/sign split
// the transaction form already established (there the sign is carried by `kind`).
// A typed "-5" is therefore a `negative` field error, NOT a silent withdrawal.
// The currency is fixed (the goal's), so this one IS a factory.
//
// Future-dated contributions are deliberately NOT rejected here (PM decision,
// meta-review S4/S5 carry-forward (a)): they are legitimate and the UI renders
// them honestly instead of hiding or blocking them.
export function contributionFormSchema(goalCurrency: string) {
  return z.object({
    amount: moneyAmountSchema(goalCurrency).refine((minor) => minor > 0, {
      error: 'Enter an amount greater than zero.',
    }),
    direction: z.enum(['add', 'withdraw']),
    occurred_at: z.string().min(1, { error: 'Choose a date.' }),
    note: z.string().max(500, { error: 'Note must be 500 characters or fewer.' }),
  });
}

export type ContributionDirection = 'add' | 'withdraw';
export type ContributionFormInput = z.input<ReturnType<typeof contributionFormSchema>>;
export type ContributionFormValues = z.output<ReturnType<typeof contributionFormSchema>>;

/**
 * Apply the direction to a magnitude: the ONE place the ledger sign is decided.
 * Trivial by construction and deliberately so — a flipped sign here silently
 * turns a deposit into a withdrawal (and vice versa), which is why it is a named,
 * tested function instead of an inline ternary at the call site.
 */
export function signedAmountMinor(direction: ContributionDirection, minor: number): number {
  return direction === 'withdraw' ? -minor : minor;
}

// --- Advisor composer (4.4 W3, WS-8) ---------------------------------------
// The advisor question, validated with the SAME schema the mobile client will use
// at unfreeze (R3: form schemas live here, never in a client). It mirrors the
// server's `AdvisorAsk.question` validator exactly — trim first, then reject a
// blank, then cap at 2000 — so a wall of whitespace is not a 2000-character
// question on either side of the wire and the user never sees a raw 422.
//
// Message text here is a DEFAULT, not a contract (the app's advisor panel is
// Russian by ruling R4.2 and overrides both strings at the call site).
export const ADVISOR_QUESTION_MAX = 2000;

export const advisorAskSchema = z
  .string()
  .trim()
  .min(1, { error: 'Enter a question.' })
  .max(ADVISOR_QUESTION_MAX, {
    error: `Question must be at most ${ADVISOR_QUESTION_MAX} characters.`,
  });

// --- Recurring template form (5.3 W2, WR-8) --------------------------------
// Object-level like the goal form and for the same reason: `currency` is a FORM
// FIELD, so `amount` can only be parsed against the currency selected right now —
// a per-field moneyAmountSchema(fixed) cannot see it. Shared (not web-local) so
// the frozen mobile client validates identically at unfreeze.
//
// The schema MIRRORS the DB CHECK `anchor_matches_unit` (architecture D3), which
// is what makes the server's ANCHOR_REQUIRED / ANCHOR_MISMATCH unreachable from
// a client UI (T6 bug-signal family):
//
//   interval_unit 'month' -> day_of_month required 1..31, weekday forced null
//   interval_unit 'week'  -> weekday required 0..6,       day_of_month forced null
//
// **`weekday` is ISO 0 = MONDAY** (D3, `date.weekday()`), NOT JavaScript's
// `Date.getDay()` (0 = Sunday). Nothing in this file — or in any client that
// consumes it — may derive a weekday from a `Date`; the labels come from the
// tested `weekdayLabels` helper in the web app. (Obligation R1.)
//
// Empty-string sentinels (the RHF empty convention, interpreted here once):
//   day_of_month / weekday  "" -> null  (the anchor the effective unit does not use)
//   end_date                "" -> null  (no end condition — D4)
//   category_id / merchant / note keep "" and are bridged to null downstream by
//   `emptyToNull` / `buildRecurringTemplatePatch` (T7), exactly as note/deadline.
//
// `paused` is deliberately NOT a form field (WR-9): pause/resume is a row-level
// action with its own one-field PATCH, the goals-`archived` precedent.
const TEMPLATE_NAME_MAX = 100;
// The app-wide magnitude bound (server `MAX_MINOR_AMOUNT`, schemas/transaction.py).
// Duplicated as a literal rather than imported across the wire boundary — it is a
// contract constant, and a client that silently allowed more would just collect a
// 422 the user cannot act on.
const MAX_MINOR_AMOUNT = 999_999_999_999_999;
const DAY_OF_MONTH_MIN = 1;
const DAY_OF_MONTH_MAX = 31;
const WEEKDAY_MIN = 0; // Monday (ISO)
const WEEKDAY_MAX = 6; // Sunday

// "5" -> 5 ; "" -> null ; anything else -> undefined (a malformed control value).
function parseAnchor(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!WHOLE_NUMBER_PATTERN.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function recurringTemplateFormSchema() {
  return z
    .object({
      name: z.string().trim().min(1, { error: 'Enter a name.' }),
      amount: z.string(),
      currency: currencyCodeSchema,
      kind: z.enum(['expense', 'income']),
      category_id: z.string(),
      merchant: z
        .string()
        .max(MERCHANT_MAX, { error: `Merchant must be ${MERCHANT_MAX} characters or fewer.` }),
      note: z.string().max(500, { error: 'Note must be 500 characters or fewer.' }),
      interval_unit: z.enum(['month', 'week']),
      day_of_month: z.string(),
      weekday: z.string(),
      end_date: z.string(),
    })
    .transform((values, ctx) => {
      let ok = true;

      if (values.name.length > TEMPLATE_NAME_MAX) {
        ok = false;
        ctx.addIssue({
          code: 'custom',
          path: ['name'],
          message: `Name must be ${TEMPLATE_NAME_MAX} characters or fewer.`,
        });
      }

      // AM-5 at the parse side: the SELECTED currency decides the exponent, so
      // "5000" is ¥5000 in JPY and ₽50.00 in RUB — never a base-bound guess.
      const amount = parseMoney(values.amount, values.currency);
      let amountMinor = 0;
      if (!amount.ok) {
        ok = false;
        ctx.addIssue({
          code: 'custom',
          path: ['amount'],
          params: { reason: amount.error },
          message: MONEY_ERROR_MESSAGES[amount.error],
        });
      } else if (amount.minor < 1) {
        ok = false;
        ctx.addIssue({
          code: 'custom',
          path: ['amount'],
          message: 'Enter an amount greater than zero.',
        });
      } else if (amount.minor > MAX_MINOR_AMOUNT) {
        ok = false;
        ctx.addIssue({
          code: 'custom',
          path: ['amount'],
          params: { reason: 'overflow' },
          message: MONEY_ERROR_MESSAGES.overflow,
        });
      } else {
        amountMinor = amount.minor;
      }

      // The CHECK, mirrored: exactly the anchor of the chosen unit, the other one
      // null. A stale value left in the unused control is DROPPED here rather than
      // sent — sending it is what the server answers with ANCHOR_MISMATCH.
      const dayOfMonth = parseAnchor(values.day_of_month);
      const weekday = parseAnchor(values.weekday);
      let effectiveDayOfMonth: number | null = null;
      let effectiveWeekday: number | null = null;

      if (values.interval_unit === 'month') {
        if (dayOfMonth === undefined || dayOfMonth === null) {
          ok = false;
          ctx.addIssue({
            code: 'custom',
            path: ['day_of_month'],
            message: 'Choose a day of the month.',
          });
        } else if (dayOfMonth < DAY_OF_MONTH_MIN || dayOfMonth > DAY_OF_MONTH_MAX) {
          ok = false;
          ctx.addIssue({
            code: 'custom',
            path: ['day_of_month'],
            message: `Choose a day between ${DAY_OF_MONTH_MIN} and ${DAY_OF_MONTH_MAX}.`,
          });
        } else {
          effectiveDayOfMonth = dayOfMonth;
        }
      } else {
        if (weekday === undefined || weekday === null) {
          ok = false;
          ctx.addIssue({ code: 'custom', path: ['weekday'], message: 'Choose a weekday.' });
        } else if (weekday < WEEKDAY_MIN || weekday > WEEKDAY_MAX) {
          ok = false;
          ctx.addIssue({ code: 'custom', path: ['weekday'], message: 'Choose a weekday.' });
        } else {
          effectiveWeekday = weekday;
        }
      }

      // D4: an end date in the PAST is accepted — the server does not reject it,
      // so neither do we. The form says what it means; it does not forbid it.
      const rawEndDate = values.end_date.trim();
      let endDate: string | null = null;
      if (rawEndDate !== '') {
        if (!API_DATE_PATTERN.test(rawEndDate)) {
          ok = false;
          ctx.addIssue({ code: 'custom', path: ['end_date'], message: 'Enter a valid date.' });
        } else {
          endDate = rawEndDate;
        }
      }

      if (!ok) return z.NEVER;

      return {
        name: values.name,
        amount_minor: amountMinor,
        kind: values.kind,
        currency: values.currency,
        category_id: values.category_id,
        merchant: values.merchant,
        note: values.note,
        interval_unit: values.interval_unit,
        day_of_month: effectiveDayOfMonth,
        weekday: effectiveWeekday,
        end_date: endDate,
      };
    });
}

export type RecurringTemplateFormInput = z.input<
  ReturnType<typeof recurringTemplateFormSchema>
>;
export type RecurringTemplateFormValues = z.output<
  ReturnType<typeof recurringTemplateFormSchema>
>;

// --- Category limit form (5.4 W4, WR-8) ------------------------------------
// One field, and a FACTORY (not object-level): unlike the goal and template
// forms, the currency here is NOT a form field — D15 makes the stamp a server
// decision, the limit is always written in the CURRENT base currency, and the
// dialog shows that currency as read-only text. So the exponent IS knowable at
// construction time, and binding it is what makes "50" mean ¥50 in JPY and
// ₽0.50 in RUB rather than a base-bound guess (AM-5 at the parse side).
//
// The floor mirrors the server's `amount_minor: ge=1` and the ceiling its
// MAX_MINOR_AMOUNT — a budget of zero is not a budget, it is a deletion, and the
// dialog offers Remove for that. Both are stated here so the user gets a field
// message instead of a raw 422 they cannot act on.
export function categoryLimitFormSchema(currency: string) {
  return z.object({
    amount: moneyAmountSchema(currency)
      .refine((minor) => minor >= 1, { error: 'Enter an amount greater than zero.' })
      .refine((minor) => minor <= MAX_MINOR_AMOUNT, {
        error: MONEY_ERROR_MESSAGES.overflow,
      }),
  });
}

export type CategoryLimitFormInput = z.input<ReturnType<typeof categoryLimitFormSchema>>;
export type CategoryLimitFormValues = z.output<ReturnType<typeof categoryLimitFormSchema>>;
