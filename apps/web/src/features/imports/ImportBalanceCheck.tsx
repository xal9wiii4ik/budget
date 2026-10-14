import { formatMoney } from '@budget/shared';

import { useLocale, useT } from '../../i18n/context';
import { balanceCheckLine, type BalanceCheckSource } from './balanceCheckLine';
import styles from './ImportChecks.module.css';

interface ImportBalanceCheckProps {
  session: BalanceCheckSource;
  /** The statement's currency — which is also the account's (the upload refuses
   * any other pair), so the ledger figure and the bank's agree by construction. */
  currency: string;
}

/**
 * After the import: what this account now holds against what the bank said it
 * should hold.
 *
 * One component for "the result" and "the record" alike — the figures live on
 * the session, so the line is identical right after an apply and on an F5 three
 * days later, and a second copy inside the report block would be the same
 * sentence twice.
 *
 * Every number is a server field. The mismatch arm names BOTH balances beside
 * the magnitude of the server's own difference, so the user can check the claim
 * instead of trusting it, and it names the two honest causes of a difference —
 * most mismatches are not an error at all.
 */
export function ImportBalanceCheck({ session, currency }: ImportBalanceCheckProps) {
  const t = useT();
  const locale = useLocale();
  const line = balanceCheckLine(session);

  if (line.tone === 'none') return null;

  if (line.tone === 'quiet') {
    return <p className={styles.quiet}>{t(line.key)}</p>;
  }

  if (line.tone === 'ok') {
    return (
      <p className={styles.ok}>
        {t(line.key, { closing: formatMoney(line.closing, currency, { locale }) })}
      </p>
    );
  }

  return (
    <div className={styles.warning} role="status">
      <p>
        {t(line.key, {
          amount: formatMoney(line.diffAbs, currency, { locale }),
          app: formatMoney(line.appBalance, currency, { locale }),
          closing: formatMoney(line.closing, currency, { locale }),
        })}
      </p>
      <p className={styles.detail}>{t('imports.balanceMismatchWhy')}</p>
    </div>
  );
}
