// A transfer row (memoized): "Card USD → Card BYN" with the money that actually
// moved — OUT of the source in the SOURCE's currency, IN to the target in the
// TARGET's currency. Addendum A5 puts `counter_currency` on the row, so neither
// amount waits for the account list; only the two NAMES are joined from it, and a
// pending/failed accounts query costs the route line and nothing else.
//
// A1: ONE row for the whole operation, never two, and no category — a transfer is
// not spending, it is moving. Tapping opens the ONE form that edits both sides.
//
// Under an account filter the row shows ONE leg: the one belonging to the account
// being viewed, chosen by the SHARED `signedLegFor` (A3) — the same rule the web
// client uses, which is why the same transfer reads "−100.00 USD" in the source
// account's history and "+330.00 BYN" in the target's.
//
// The sign is a DIRECTION marker, not arithmetic: stored magnitudes are rendered
// with a leading minus/plus by the shared formatter, and nothing here adds,
// subtracts or divides them. In particular the exchange rate is NOT computed here
// — `transfer_rate` is a server string (A2) printed verbatim, and hidden when both
// sides share a currency ("1 USD / USD" is noise, not information).
import { formatMoney, signedLegFor } from '@budget/shared';
import type { components } from '@budget/api-client';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing, TOUCH_TARGET } from '../../components/theme';
import type { AccountRead } from '../../data/accounts';
import { useLocale, useT } from '../../i18n/context';

type TransactionRead = components['schemas']['TransactionRead'];

interface TransferRowProps {
  transaction: TransactionRead;
  /** id -> account, for the two NAMES only. */
  accountsById: Map<string, AccountRead>;
  /** The account the list is filtered by, or undefined for the all-accounts list. */
  viewAccountId: string | undefined;
  onEdit: (transaction: TransactionRead) => void;
}

interface Leg {
  signedMinor: number;
  currency: string;
}

function TransferRowImpl({
  transaction,
  accountsById,
  viewAccountId,
  onEdit,
}: TransferRowProps) {
  const t = useT();

  const source = accountsById.get(transaction.account_id)?.name;
  const target =
    transaction.counter_account_id === null
      ? undefined
      : accountsById.get(transaction.counter_account_id)?.name;
  // Both names or no route: "Card USD → " reads as a half-loaded lie, and guessing
  // the missing side is not an option.
  const route = source !== undefined && target !== undefined ? `${source} → ${target}` : null;

  const sent: Leg = { signedMinor: -transaction.amount_minor, currency: transaction.currency };
  // `null` when the row carries no counter pair (a state the server's CHECK
  // excludes for transfers): showing the sent leg twice would relabel money.
  const received: Leg | null =
    transaction.counter_amount_minor === null || transaction.counter_currency === null
      ? null
      : {
          signedMinor: transaction.counter_amount_minor,
          currency: transaction.counter_currency,
        };
  // `null` only if the filtered account is on neither leg (the server cannot
  // return such a row) or the counter pair is missing — both fall back to the
  // two-sided rendering rather than to an invented amount.
  const leg = viewAccountId === undefined ? null : signedLegFor(transaction, viewAccountId);

  const rate =
    transaction.transfer_rate === null ||
    transaction.counter_currency === null ||
    transaction.counter_currency === transaction.currency
      ? null
      : `${transaction.transfer_rate} ${transaction.counter_currency} / ${transaction.currency}`;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onEdit(transaction)}
      style={styles.row}
    >
      <Text style={styles.icon}>⇄</Text>
      <View style={styles.details}>
        <Text style={styles.title} numberOfLines={1}>
          {/* The route is two account NAMES — the user's own text, joined by a
              translated frame. */}
          {route === null ? t('tx.transfer') : t('tx.transferRoute', { route })}
        </Text>
        {transaction.note ? (
          <Text style={styles.note} numberOfLines={1}>
            {transaction.note}
          </Text>
        ) : null}
      </View>
      <View style={styles.amounts}>
        {leg !== null ? (
          <LegAmount leg={leg} />
        ) : (
          <>
            <LegAmount leg={sent} />
            {received === null ? null : <LegAmount leg={received} />}
          </>
        )}
        {rate === null ? null : <Text style={styles.rate}>{rate}</Text>}
      </View>
    </Pressable>
  );
}

/** One transfer leg, coloured by its direction. The sign comes in already applied. */
function LegAmount({ leg }: { leg: Leg }) {
  const locale = useLocale();

  return (
    <Text style={[styles.amount, leg.signedMinor < 0 ? styles.expense : styles.income]}>
      {formatMoney(leg.signedMinor, leg.currency, { locale })}
    </Text>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.card,
    gap: spacing.md,
  },
  icon: {
    fontSize: 20,
    width: 24,
    textAlign: 'center',
  },
  details: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 15,
    color: colors.text,
    fontWeight: '500',
  },
  note: {
    fontSize: 13,
    color: colors.textMuted,
  },
  amounts: {
    alignItems: 'flex-end',
    gap: 2,
  },
  amount: {
    fontSize: 15,
    fontWeight: '600',
  },
  income: {
    color: colors.income,
  },
  expense: {
    color: colors.expense,
  },
  rate: {
    fontSize: 12,
    color: colors.textMuted,
  },
});

export const TransferRow = memo(TransferRowImpl);
