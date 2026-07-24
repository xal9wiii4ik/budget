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
