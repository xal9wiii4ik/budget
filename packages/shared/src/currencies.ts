// ISO-4217 minor-unit exponents. Source of truth for minor<->major conversion.
//
// We enumerate ONLY the currencies whose exponent differs from 2; everything
// else (including well-formed but unknown codes, e.g. an OCR result) defaults
// to 2. This is safe precisely because the set of non-2-exponent transactional
// currencies is small and stable, so "default 2 for anything unlisted" never
// silently mis-scales a real currency by 100x. (plan D3)
//
// Excluded on purpose: the exponent-4 funds codes (CLF, UYW) — non-transactional
// units of account that will not appear on a receipt; if one ever does it renders
// with 2 decimals. (plan D3 / Risk 4)
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  // exponent 0
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // exponent 3
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

// Exponent used for any well-formed currency code not present in the table.
export const DEFAULT_CURRENCY_EXPONENT = 2;

// Shape check for a currency code (ISO-4217 alpha-3, uppercase). Consumed by
// currencyCodeSchema; also used to guard the format helpers against a malformed
// code (a programmer error, distinct from an unknown-but-well-formed code).
export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

// The convertible set (3.2 D7): the closure of the six canonical FX pairs the
// rates infrastructure fetches. The transaction/goal pickers offer exactly this
// set; the API deliberately stays format-only (^[A-Z]{3}$, OQ-4), so this
// constant gates the UI, never validation — an out-of-set code (a JPY receipt)
// must still be submittable. Since the base-currency scope a SERVER TWIN does
// exist (SUPPORTED_CURRENCIES in apps/api/src/budget_api/domain/money.py, which
// gates the PATCH /profile base-currency arm): the two lists must be edited
// TOGETHER, and drift in either direction fails
// apps/api/tests/test_currency_exponents_sync.py.
export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'RUB', 'BYN'] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];
