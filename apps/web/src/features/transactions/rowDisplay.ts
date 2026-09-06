// The row's money lines and title — MOVED to @budget/api-client (mobile-catchup-3),
// re-exported here so every call site in this feature keeps its import.
//
// The reason is the same one that moved `buildCreateBody` there in
// mobile-catchup-2: the mobile transactions list now renders the very same
// spent/charged pair, and the rule for which amount leads is a decision about
// money that must exist exactly once. The module is pure and types-only against
// the generated schema, so api-client is where it belongs; its test moved with it
// (packages/api-client/src/rowDisplay.test.ts).
export { baseEquivalent, primaryAmount, rowTitle } from '@budget/api-client';
export type {
  BaseEquivalent,
  RowMoneySource,
  RowMoney,
  RowAmounts,
  RowTitleLabels,
} from '@budget/api-client';
