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

export { formatApiDate, toApiDate, todayApiDate } from './dates';

export { currencyCodeSchema, moneyAmountSchema } from './schemas';
