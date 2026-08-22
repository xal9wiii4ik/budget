import { z } from 'zod';
import { COUNTRY_CODE_PATTERN } from './countries';
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

// accounts-and-transfers W1: `account_id` is REQUIRED (the server's
// `TransactionCreate.account_id` is NOT NULL) and `currency` is no longer a free
// user choice — it is a DERIVED echo of the selected account's currency
// (architecture §4), which the form keeps in sync and renders read-only. The
// field stays in the schema because the amount's exponent is read from it, and
// because the base-amount rules above are stated in terms of it.
/**
 * transaction-details-and-i18n S1/S2: the ORIGINAL (spent) pair and the country.
 *
 * `original_currency` is the currency the money was SPENT in; `currency` stays
 * what the ACCOUNT was charged in. The two fields are one unit of meaning:
 *
 *   original_currency === currency  ->  single-amount operation. There is no pair
 *       at all — the server 422s `ORIGINAL_CURRENCY_MATCHES_ACCOUNT` on equality
 *       (architecture §2), so equality is folded to `null` HERE and the wire can
 *       never represent it. The user sees one amount field and no error.
 *   original_currency !== currency  ->  the spent amount is REQUIRED and parses
 *       with the ORIGINAL currency's exponent (AM-5: 1000 JPY is 1000 minor
 *       units, not 100000), while `amount` — what the account was charged — MAY
 *       be blank: blank means "server, convert it at the day's rate"
 *       (architecture §3, create row 4 / PATCH row 4).
 *
 * That is the whole-or-nothing rule the DB CHECK enforces, expressed so that half
 * a pair is unrepresentable rather than merely rejected.
 *
 * All three new members are OPTIONAL on both the input and the output shape, for
 * the same reason `merchant` is: apps/mobile uses this very factory, renders none
 * of these controls, and is frozen — an absent key must keep meaning "this client
 * has no opinion", not "clear it".
 */
export type MultiCurrencyTransactionFormValues = {
  account_id: string;
  // `null` ONLY in the paired case: "let the server compute what was charged".
  amount: number | null;
  currency: string;
  base_amount_minor: number | null;
  kind: 'expense' | 'income';
  category_id: string;
  occurred_at: string;
  note: string;
  merchant: string;
  original_amount_minor?: number | null;
  original_currency?: string | null;
  // "" is the "not set" sentinel, like category_id/note; the ""->null bridge
  // stays downstream (emptyToNull / clearableChange).
  country?: string;
};

export function multiCurrencyTransactionFormSchema(baseCurrency: string) {
  return z
    .object({
      account_id: z.string().min(1, { error: 'Choose an account.' }),
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
      // Format-only, like `currency` (D7): the picker suggests a known set, any
      // well-formed code is accepted. Its own message, because unlike `currency`
      // (a derived echo of the account) this one is TYPED by a person.
      original_currency: z
        .string()
        .regex(CURRENCY_CODE_PATTERN, { error: 'Use a 3-letter currency code, like EUR.' })
        .optional(),
      original_amount: z.string().optional(),
      country: z
        .string()
        .refine((value) => value === '' || COUNTRY_CODE_PATTERN.test(value), {
          error: 'Choose a country from the list.',
        })
        .optional(),
    })
    .transform((values, ctx): MultiCurrencyTransactionFormValues | typeof z.NEVER => {
      // Equality folds to "no pair" (see the doc comment): from here on, a
      // non-null `spendCurrency` IS the dual-currency case.
      const spendCurrency =
        values.original_currency !== undefined && values.original_currency !== values.currency
          ? values.original_currency
          : null;

      // The charged amount is optional ONLY in the paired case.
      let amountMinor: number | null = null;
      let amountOk = true;
      if (values.amount.trim() === '') {
        if (spendCurrency === null) {
          amountOk = false;
          ctx.addIssue({
            code: 'custom',
            path: ['amount'],
            params: { reason: 'empty' satisfies MoneyParseError },
            message: MONEY_ERROR_MESSAGES.empty,
          });
        }
      } else {
        const amount = parseMoney(values.amount, values.currency);
        if (amount.ok) {
          amountMinor = amount.minor;
        } else {
          amountOk = false;
          ctx.addIssue({
            code: 'custom',
            path: ['amount'],
            params: { reason: amount.error },
            message: MONEY_ERROR_MESSAGES[amount.error],
          });
        }
      }

      // The spent amount: required, and parsed with the SPENT currency's
      // exponent — never the account's.
      let originalMinor: number | null = null;
      let originalOk = true;
      if (spendCurrency !== null) {
        const original = parseMoney(values.original_amount ?? '', spendCurrency);
        if (original.ok) {
          originalMinor = original.minor;
        } else {
          originalOk = false;
          ctx.addIssue({
            code: 'custom',
            path: ['original_amount'],
            params: { reason: original.error },
            message: MONEY_ERROR_MESSAGES[original.error],
          });
        }
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

      if (!amountOk || !originalOk || !baseAmountOk) return z.NEVER;

      return {
        account_id: values.account_id,
        amount: amountMinor,
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
        // Emitted as a pair or not at all — `null` on both members is the only
        // "no pair" representation this output can carry.
        original_amount_minor: spendCurrency === null ? null : originalMinor,
        original_currency: spendCurrency,
        country: values.country ?? '',
      };
    });
}

export type MultiCurrencyTransactionFormInput = z.input<
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

/**
 * `minStartDate` — the earliest `start_date` this form may submit, "YYYY-MM-DD",
 * or `undefined` for "do not check it here".
 *
 * CREATE passes today (UTC — `todayApiDateUtc()`, the basis of the server's
 * `_today()`), which pre-empts the obvious typo without a round-trip: the server
 * REFUSES a past start with 422 `START_DATE_TOO_EARLY` rather than clamping it.
 *
 * EDIT passes nothing, deliberately. The PATCH floor is `min(last_materialized_on,
 * today)` and that watermark is server-only state; guessing it here would either
 * block a legal rewind or wave through an illegal one. The 422 is the UX there.
 */
export function recurringTemplateFormSchema(options?: { minStartDate?: string }) {
  return z
    .object({
      name: z.string().trim().min(1, { error: 'Enter a name.' }),
      // accounts-and-transfers: the template carries the account every row it
      // materializes is written on (`RecurringTemplateCreate.account_id` is NOT
      // NULL). Transfers are NOT representable as templates (architecture §7),
      // so there is no counter pair here.
      account_id: z.string().min(1, { error: 'Choose an account.' }),
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
      start_date: z.string(),
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

      // A6/A7: the FIRST date the schedule may fire on. Empty = "no seed", which
      // is the shipped behaviour (the first charge lands on the next natural
      // date). Parsed after `end_date` because the order rule below needs both.
      const rawStartDate = values.start_date.trim();
      let startDate: string | null = null;
      if (rawStartDate !== '') {
        if (!API_DATE_PATTERN.test(rawStartDate)) {
          ok = false;
          ctx.addIssue({ code: 'custom', path: ['start_date'], message: 'Enter a valid date.' });
        } else {
          startDate = rawStartDate;
          // Both checks are lexicographic compares of two "YYYY-MM-DD" strings,
          // which for this format IS a date compare — no Date parsing, no zone.
          if (options?.minStartDate !== undefined && startDate < options.minStartDate) {
            ok = false;
            ctx.addIssue({
              code: 'custom',
              path: ['start_date'],
              message: 'Choose today or a later date — a template cannot start in the past.',
            });
          } else if (endDate !== null && startDate > endDate) {
            // Strictly after, mirroring the server: start == end is a one-off
            // charge, not a mistake. The issue lands on `start_date` because that
            // is the date the user is most likely editing when the pair breaks.
            ok = false;
            ctx.addIssue({
              code: 'custom',
              path: ['start_date'],
              message: 'The start date must be on or before the end date.',
            });
          }
        }
      }

      if (!ok) return z.NEVER;

      return {
        name: values.name,
        account_id: values.account_id,
        amount_minor: amountMinor,
        kind: values.kind,
        currency: values.currency,
        category_id: values.category_id,
        merchant: values.merchant,
        note: values.note,
        interval_unit: values.interval_unit,
        day_of_month: effectiveDayOfMonth,
        weekday: effectiveWeekday,
        start_date: startDate,
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

// --- Account form (accounts-and-transfers W1) ------------------------------
// Object-level like the goal form and for the same reason: `currency` is a FORM
// FIELD on create, so `starting_balance` can only be parsed against the currency
// the user has just picked — a per-field moneyAmountSchema(fixed) cannot see it.
// On EDIT the currency is immutable (architecture §4: the balance formula is
// pure integer arithmetic only because every row on an account shares its
// currency), so the form renders it as read-only text and simply carries the
// stored code through this same field.
//
// `starting_balance` is the ONE money input in the app that may be NEGATIVE: a
// credit card legitimately starts in the minus, and architecture §1 deliberately
// puts no sign CHECK on the column. `parseMoney` is a MAGNITUDE parser by
// construction (a leading '-' is its `negative` error), so the sign is peeled off
// here and re-applied to the parsed INTEGER minor value — no float ever touches
// it. An empty field is 0, which is also the server's default.
const ACCOUNT_NAME_MAX = 100;

export const accountFormSchema = z
  .object({
    name: z.string().trim().min(1, { error: 'Enter a name.' }),
    type: z.enum(['card', 'cash']),
    currency: currencyCodeSchema,
    starting_balance: z.string(),
  })
  .transform((values, ctx) => {
    let ok = true;

    if (values.name.length > ACCOUNT_NAME_MAX) {
      ok = false;
      ctx.addIssue({
        code: 'custom',
        path: ['name'],
        message: `Name must be ${ACCOUNT_NAME_MAX} characters or fewer.`,
      });
    }

    const raw = values.starting_balance.trim();
    const negative = raw.startsWith('-');
    const magnitude = negative ? raw.slice(1).trim() : raw;
    let startingBalanceMinor = 0;
    if (magnitude !== '') {
      const parsed = parseMoney(magnitude, values.currency);
      if (!parsed.ok) {
        ok = false;
        ctx.addIssue({
          code: 'custom',
          path: ['starting_balance'],
          params: { reason: parsed.error },
          message: MONEY_ERROR_MESSAGES[parsed.error],
        });
      } else if (parsed.minor > MAX_MINOR_AMOUNT) {
        ok = false;
        ctx.addIssue({
          code: 'custom',
          path: ['starting_balance'],
          params: { reason: 'overflow' },
          message: MONEY_ERROR_MESSAGES.overflow,
        });
      } else {
        startingBalanceMinor = negative ? -parsed.minor : parsed.minor;
      }
    }

    if (!ok) return z.NEVER;

    return {
      name: values.name,
      type: values.type,
      currency: values.currency,
      starting_balance_minor: startingBalanceMinor,
    };
  });

export type AccountFormInput = z.input<typeof accountFormSchema>;
export type AccountFormValues = z.output<typeof accountFormSchema>;

// --- Transfer form (accounts-and-transfers W1) -----------------------------
// A FACTORY over a lookup, not over a currency pair: a transfer carries TWO
// amounts denominated in TWO different accounts' currencies (architecture §4),
// and both accounts are form fields — so neither exponent is knowable until the
// user has picked. `currencyOf` resolves "account id -> its currency" from the
// client's account cache; `undefined` means the id is not (or no longer) a
// usable account, which is a field error rather than a guessed exponent (AM-5).
//
// The object-level transform also owns the SAME_ACCOUNT rule: the server answers
// 422 SAME_ACCOUNT_TRANSFER, and the issue is routed onto the target select —
// the control the user can actually change — instead of the form root.
//
// Both amounts are magnitudes >= 1 (the server's `ge=1` on `amount_minor` and
// `counter_amount_minor`); the DIRECTION is carried by the two account fields,
// exactly as `kind` carries it on a plain transaction (T4).
//
// What is deliberately NOT here: the exchange rate. It is a SERVER field
// (`TransactionRead.transfer_rate`, addendum A2) computed from the two stored
// amounts; dividing them client-side would be forbidden money arithmetic.
export type AccountCurrencyLookup = (accountId: string) => string | undefined;

export function transferFormSchema(currencyOf: AccountCurrencyLookup) {
  return z
    .object({
      account_id: z.string().min(1, { error: 'Choose the account the money leaves.' }),
      counter_account_id: z
        .string()
        .min(1, { error: 'Choose the account the money arrives on.' }),
      amount: z.string(),
      counter_amount: z.string(),
      occurred_at: z.string().min(1, { error: 'Choose a date.' }),
      note: z.string().max(500, { error: 'Note must be 500 characters or fewer.' }),
    })
    .transform((values, ctx) => {
      let ok = true;

      const currency = currencyOf(values.account_id);
      if (currency === undefined) {
        ok = false;
        ctx.addIssue({
          code: 'custom',
          path: ['account_id'],
          message: 'That account is unavailable. Pick another one.',
        });
      }

      const counterCurrency = currencyOf(values.counter_account_id);
      if (counterCurrency === undefined) {
        ok = false;
        ctx.addIssue({
          code: 'custom',
          path: ['counter_account_id'],
          message: 'That account is unavailable. Pick another one.',
        });
      }

      if (values.account_id === values.counter_account_id) {
        ok = false;
        ctx.addIssue({
          code: 'custom',
          path: ['counter_account_id'],
          message: 'Pick a different account to transfer to.',
        });
      }

      const amount = parseAmountLeg(values.amount, currency, 'amount', ctx);
      const counterAmount = parseAmountLeg(
        values.counter_amount,
        counterCurrency,
        'counter_amount',
        ctx,
      );
      if (amount === null || counterAmount === null) ok = false;

      if (!ok || currency === undefined || counterCurrency === undefined) return z.NEVER;
      if (amount === null || counterAmount === null) return z.NEVER;

      return {
        account_id: values.account_id,
        currency,
        amount_minor: amount,
        counter_account_id: values.counter_account_id,
        counter_currency: counterCurrency,
        counter_amount_minor: counterAmount,
        occurred_at: values.occurred_at,
        note: values.note,
      };
    });
}

// One leg of a transfer: parsed at ITS OWN account's exponent, magnitude >= 1 and
// within the server's bound. `null` = an issue was reported for this leg (either
// its currency is unknown, so there is no honest exponent to parse with, or the
// text is not a usable amount).
function parseAmountLeg(
  raw: string,
  currency: string | undefined,
  path: 'amount' | 'counter_amount',
  ctx: z.RefinementCtx,
): number | null {
  if (currency === undefined) return null;
  const parsed = parseMoney(raw, currency);
  if (!parsed.ok) {
    ctx.addIssue({
      code: 'custom',
      path: [path],
      params: { reason: parsed.error },
      message: MONEY_ERROR_MESSAGES[parsed.error],
    });
    return null;
  }
  if (parsed.minor < 1) {
    ctx.addIssue({
      code: 'custom',
      path: [path],
      message: 'Enter an amount greater than zero.',
    });
    return null;
  }
  if (parsed.minor > MAX_MINOR_AMOUNT) {
    ctx.addIssue({
      code: 'custom',
      path: [path],
      params: { reason: 'overflow' },
      message: MONEY_ERROR_MESSAGES.overflow,
    });
    return null;
  }
  return parsed.minor;
}

export type TransferFormInput = z.input<ReturnType<typeof transferFormSchema>>;
export type TransferFormValues = z.output<ReturnType<typeof transferFormSchema>>;
