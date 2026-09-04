// Barrel for @budget/shared. Single '.' entry, no subpath exports (plan §2).
export {
  getCurrencyExponent,
  parseMoney,
  formatMoney,
  formatAmount,
  toInputString,
  toInputStringAtExponent,
  toSignedInputString,
  type MoneyParseError,
  type ParseMoneyResult,
} from './money';

export {
  COUNTRY_CODES,
  COUNTRY_CODE_PATTERN,
  COUNTRY_CURRENCIES,
  countryToCurrency,
} from './countries';

export {
  CURRENCY_EXPONENTS,
  DEFAULT_CURRENCY_EXPONENT,
  CURRENCY_CODE_PATTERN,
  SUPPORTED_CURRENCIES,
  type SupportedCurrency,
} from './currencies';

export {
  formatApiDate,
  formatTimestamp,
  toApiDate,
  todayApiDate,
  todayApiDateUtc,
  monthParam,
  currentMonth,
  shiftMonth,
  monthBounds,
  formatMonthLabel,
  formatMonthShortLabel,
  quarterParam,
  currentQuarter,
  shiftQuarter,
  quarterOfMonth,
  formatQuarterLabel,
  sentenceEnd,
} from './dates';

// The received-amount mirror of a transfer form (mobile-catchup-1). Pure and
// UI-free, shared by web's TransferFormModal and mobile's transfer-form screen.
export {
  mirrorDecision,
  type MirrorState,
} from './amountMirror';

export {
  signedLegFor,
  type SignedLeg,
  type TransactionLeg,
} from './transfers';

export {
  type Lang,
  LANGS,
  isLang,
} from './i18n/lang';

export {
  SYSTEM_CATEGORY_NAMES,
  type SystemCategoryKey,
} from './i18n/categories';

export {
  SYSTEM_CATEGORY_KEYS,
  systemCategoryName,
} from './systemCategories';

export {
  ERROR_MESSAGES,
  errorMessage,
  type ErrorMessageKey,
} from './i18n/errors';

export {
  currencyCodeSchema,
  moneyAmountSchema,
  emailSchema,
  loginFormSchema,
  registerFormSchema,
  transactionFormSchema,
  multiCurrencyTransactionFormSchema,
  goalFormSchema,
  contributionFormSchema,
  recurringTemplateFormSchema,
  categoryLimitFormSchema,
  accountFormSchema,
  transferFormSchema,
  signedAmountMinor,
  categoryFormSchema,
  advisorAskSchema,
  ADVISOR_QUESTION_MAX,
  HEX_COLOR_PATTERN,
  type LoginFormValues,
  type RegisterFormValues,
  type TransactionFormInput,
  type TransactionFormValues,
  type MultiCurrencyTransactionFormInput,
  type MultiCurrencyTransactionFormValues,
  type GoalFormInput,
  type GoalFormValues,
  type ContributionDirection,
  type ContributionFormInput,
  type ContributionFormValues,
  type CategoryFormValues,
  type RecurringTemplateFormInput,
  type RecurringTemplateFormValues,
  type CategoryLimitFormInput,
  type CategoryLimitFormValues,
  type AccountCurrencyLookup,
  type AccountFormInput,
  type AccountFormValues,
  type TransferFormInput,
  type TransferFormValues,
} from './schemas';
