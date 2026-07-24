// Barrel for @budget/shared. Single '.' entry, no subpath exports (plan §2).
export {
  getCurrencyExponent,
  parseMoney,
  formatMoney,
  formatAmount,
  toInputString,
  type MoneyParseError,
  type ParseMoneyResult,
} from './money';

export {
  CURRENCY_EXPONENTS,
  DEFAULT_CURRENCY_EXPONENT,
  CURRENCY_CODE_PATTERN,
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
} from './dates';

export {
  currencyCodeSchema,
  moneyAmountSchema,
  emailSchema,
  loginFormSchema,
  registerFormSchema,
  transactionFormSchema,
  categoryFormSchema,
  HEX_COLOR_PATTERN,
  type LoginFormValues,
  type RegisterFormValues,
  type TransactionFormInput,
  type TransactionFormValues,
  type CategoryFormValues,
} from './schemas';
