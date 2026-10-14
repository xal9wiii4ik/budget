import { formatMoney } from '@budget/shared';

import { useLocale, useT } from '../../i18n/context';
import { selfCheckLine, type SelfCheckSource } from './selfCheckLine';
import styles from './ImportChecks.module.css';

interface ImportSelfCheckProps {
  session: SelfCheckSource & {
    opening_balance_minor?: number | null;
    closing_balance_minor?: number | null;
  };
  /** The STATEMENT's currency — every figure here is the bank's, not the app's. */
  currency: string;
}

/**
 * Whether the statement agrees with itself, as the header's last line.
 *
 * Thin by design: `selfCheckLine` decided which sentence is true, this does the
 * `t()` and the `formatMoney`. Both the EXPECTED and the ACTUAL figure are
 * printed (never their difference, and never a difference computed here) —
 * those are the two numbers the user can find on paper.
 *
 * The anchors line is rendered whenever the bank printed both balances, failed
 * check or not: it is the pair the user compares with the PDF, and a statement
 * that passed its own check still benefits from showing what was checked.
 */
export function ImportSelfCheck({ session, currency }: ImportSelfCheckProps) {
  const t = useT();
  const locale = useLocale();
  const line = selfCheckLine(session);

  const opening = session.opening_balance_minor;
  const closing = session.closing_balance_minor;
  const anchors =
    opening === undefined || opening === null || closing === undefined || closing === null
      ? null
      : t('imports.selfCheckAnchors', {
          opening: formatMoney(opening, currency, { locale }),
          closing: formatMoney(closing, currency, { locale }),
        });

  // No check and no anchors: this statement said nothing about itself, so the
  // screen says nothing about it either.
  if (line.tone === 'none' && anchors === null) return null;

  return (
    <div className={styles.block}>
      {line.tone === 'ok' ? <p className={styles.ok}>{t(line.key)}</p> : null}
      {line.tone === 'warning' ? (
        // `role="status"`: a statement that does not add up is news, and it is
        // also the reason the apply button below is disabled.
        <div className={styles.warning} role="status">
          <p>
            {/* The two figures are interpolated INTO the sentence that names
                the failed check — and the helper hands over `figures: null`
                exactly for the keys that have no placeholders. */}
            {line.figures === null
              ? t(line.key)
              : t(line.key, {
                  expected: formatMoney(line.figures.expected, currency, { locale }),
                  actual: formatMoney(line.figures.actual, currency, { locale }),
                })}
          </p>
        </div>
      ) : null}
      {anchors === null ? null : <p className={styles.anchors}>{anchors}</p>}
    </div>
  );
}
