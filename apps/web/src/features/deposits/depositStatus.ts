// What one deposit row is in, as a value instead of four inline ternaries in the
// JSX. Pure and language-free: it returns BADGE KEYS, never sentences (the house
// rule for pure modules — the dictionary lives in i18n/, this file must not know
// which language is on screen).
//
// It reads SERVER fields only. `status` is the server's (`active | matured`, a
// computed field, not something the client re-derives from `term_end` — the
// server freezes accrual on that date and only it knows the rule); the override
// anchor is a stored pair; `archived` is a column. No date arithmetic, no money
// arithmetic.
//
// The two traps this module exists to hold in one place, both of which are
// legitimate ZERO values that a truthiness check would silently eat:
//   * `accrued_after_tax_minor: 0` — a real "nothing left after tax" figure that
//     must still be rendered; only `null` means "this deposit is not taxed";
//   * `accrued_override_minor: 0` — a real manual anchor ("the bank says zero"),
//     which must still raise the "edited by hand" badge.
import type { DepositRead } from '../../data/deposits';

/** Badge keys, in the order they are rendered. Mapped to copy by the row. */
export type DepositBadge = 'archived' | 'matured' | 'overridden';

export interface DepositRowState {
  /** Archive first (it explains the missing buttons), then term, then anchor. */
  badges: DepositBadge[];
  /**
   * Whether money may still move in or out. Archiving a deposit archives its
   * ledger account, so the server refuses the transfer with ACCOUNT_ARCHIVED.
   */
  canMoveMoney: boolean;
  /**
   * Whether the deposit's own fields may still be written — its terms and the
   * manual interest anchor. Same input, DIFFERENT server guard
   * (`DEPOSIT_ARCHIVED` on PATCH), and it deliberately does not cover the one
   * write an archived deposit does accept: `{archived: false}`, which is why the
   * edit dialog stays reachable on an archived row.
   */
  canEditTerms: boolean;
  /** Whether the row has an after-tax figure to show beside the gross one. */
  showAfterTax: boolean;
  /** Whether the accrued figure is the user's manual anchor rather than a sum. */
  isOverridden: boolean;
}

export function depositRowState(deposit: DepositRead): DepositRowState {
  const isOverridden = deposit.accrued_override_minor !== null;
  const badges: DepositBadge[] = [];
  if (deposit.archived) badges.push('archived');
  if (deposit.status === 'matured') badges.push('matured');
  if (isOverridden) badges.push('overridden');

  return {
    badges,
    // A matured deposit still takes transfers (the term ended, the money is
    // still there and closing it IS a transfer back), so only the archive stops
    // this — the same rule the server enforces via ACCOUNT_ARCHIVED.
    canMoveMoney: !deposit.archived,
    canEditTerms: !deposit.archived,
    showAfterTax: deposit.accrued_after_tax_minor !== null,
    isOverridden,
  };
}
