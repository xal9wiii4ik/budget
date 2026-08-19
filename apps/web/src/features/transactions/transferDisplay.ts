// What a transfer row shows (accounts-and-transfers W2). Pure, so the two things
// that are easy to get quietly wrong — WHICH currency labels WHICH magnitude, and
// what is shown while the account list has not arrived — are unit-tested instead
// of being read off a JSX diff.
//
// A1: a transfer is ONE row with both sides on it. Both magnitudes and both
// currencies come from the ROW (A5 put `counter_currency` there), never from the
// accounts cache: only the two NAMES are joined, so a pending/failed accounts
// query costs the route line and nothing else. Nothing here computes anything —
// the sign is a direction marker, and the rate (`transfer_rate`) is a server
// string this module only ever LABELS, never parses, rounds or recomputes.
import type { components } from '@budget/api-client';

type TransactionRead = components['schemas']['TransactionRead'];

export interface TransferLeg {
  /** The stored magnitude with its direction applied (negative = leaving). */
  signedMinor: number;
  /** The currency of THAT leg — never the other one's, never a fallback. */
  currency: string;
}

export interface TransferDisplay {
  /** "Card USD → Card BYN", or null while either account name is unknown. */
  route: string | null;
  /** Money leaving the source account, in the source account's currency. */
  sent: TransferLeg;
  /**
   * Money arriving on the target account, in the TARGET's currency — or null
   * when the row carries no counter pair (a type-level state the server's CHECK
   * excludes for transfers). Showing the sent leg twice would relabel money.
   */
  received: TransferLeg | null;
  /**
   * The muted rate caption, e.g. "3.300000 BYN / USD" — the server's
   * `transfer_rate` string (A2) VERBATIM with the two currency codes around it.
   * Null when the server sent no rate, when there is no counter pair, and for a
   * same-currency transfer, where "1 USD / USD" would be noise, not information.
   */
  rate: string | null;
}

export function transferDisplay(
  tx: TransactionRead,
  accountName: (accountId: string) => string | undefined,
): TransferDisplay {
  const source = accountName(tx.account_id);
  const target =
    tx.counter_account_id === null ? undefined : accountName(tx.counter_account_id);

  return {
    // Both names or no route: "Card USD → " reads as a half-loaded lie, and
    // guessing the missing side is not an option.
    route: source !== undefined && target !== undefined ? `${source} → ${target}` : null,
    sent: { signedMinor: -tx.amount_minor, currency: tx.currency },
    received:
      tx.counter_amount_minor === null || tx.counter_currency === null
        ? null
        : { signedMinor: tx.counter_amount_minor, currency: tx.counter_currency },
    // Interpolated as received: the digits the server printed are the digits the
    // user sees. A rate belongs to the TRANSFER, not to a leg, so this caption is
    // the same whether the row shows both sides or one leg under an account filter.
    rate:
      tx.transfer_rate === null ||
      tx.counter_currency === null ||
      tx.counter_currency === tx.currency
        ? null
        : `${tx.transfer_rate} ${tx.counter_currency} / ${tx.currency}`,
  };
}
