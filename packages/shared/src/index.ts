// Barrel for @budget/shared. Single '.' entry, no subpath exports (plan §2).
export {
  getCurrencyExponent,
  parseMoney,
  formatMoney,
  formatAmount,
  toInputString,
  toInputStringAtExponent,
  type MoneyParseError,
  type ParseMoneyResult,
} from './money';

export {
  CURRENCY_EXPONENTS,
  DEFAULT_CURRENCY_EXPONENT,
  CURRENCY_CODE_PATTERN,
  SUPPORTED_CURRENCIES,
  type SupportedCurrency,
} from './currencies';

export {
  formatApiDate,
  toApiDate,
  todayApiDate,
  monthParam,
  currentMonth,
  shiftMonth,
  monthBounds,
  formatMonthLabel,
  formatMonthShortLabel,
} from './dates';

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
  signedAmountMinor,
  categoryFormSchema,
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
} from './schemas';
