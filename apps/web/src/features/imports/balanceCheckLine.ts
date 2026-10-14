// After the import: does the account agree with the bank? (pdf-reconcile, web A)
//
// At apply/replace the server computes this account's balance as of the
// statement's last day and compares it with the closing balance the bank
// printed (D-B1). All three figures — the ledger balance, the closing balance
// and their difference — are SERVER integers; this module picks the sentence
// that is true of them.
//
// The ONE derivation in the whole scope lives here: the sign of
// `balance_diff_minor` (server field = app − closing) chooses a DIRECTION key,
// and the magnitude goes out as `Math.abs`. That is so the copy can say "the
// app is 12.50 higher" instead of printing "−12.50" in the middle of a
// sentence. No subtraction, no sum, no conversion.
//
// PURE and LANGUAGE-FREE: keys out, raw minor integers out, `formatMoney` and
// `t` at the call site (the `aiStatusLine` precedent).
import type { StatementBalanceCheck, StatementImportStatus } from '../../data/imports';
import type { SimpleKey } from '../../i18n/t';

/**
 * Structural, like `selfCheckLine`: the five fields this reads, so a test needs
 * no session object (and a pre-S2 server, which sends none of the four
 * optional ones, still renders something true).
 *
 * `status` is REQUIRED and load-bearing: `balance_check === 'not_available'`
 * means two different things on the wire — "not computed yet" on a preview and
 * "the statement carried no closing balance" on a finished import — and the
 * session's status is the only thing that tells them apart.
 */
export interface BalanceCheckSource {
  status: StatementImportStatus;
  balance_check?: StatementBalanceCheck;
  app_balance_minor_at_end?: number | null;
  balance_diff_minor?: number | null;
  closing_balance_minor?: number | null;
}

export type BalanceCheckLine =
  /** A preview (or a cancelled session): nothing has touched the ledger yet. */
  | { tone: 'none'; key: null }
  /** Imported, but the statement printed no closing balance to compare with. */
  | { tone: 'quiet'; key: SimpleKey }
  | { tone: 'ok'; key: SimpleKey; closing: number }
  | {
      tone: 'warning';
      key: SimpleKey;
      /** Always positive: the DIRECTION is in the key, not in the sign. */
      diffAbs: number;
      appBalance: number;
      closing: number;
    };

const NOTHING: BalanceCheckLine = { tone: 'none', key: null };

export function balanceCheckLine(source: BalanceCheckSource): BalanceCheckLine {
  // The check is stamped BY the apply/replace, so before one has happened there
  // is no answer — and a "not available" line on a preview would describe a
  // ledger nothing has written to.
  if (source.status !== 'applied' && source.status !== 'replaced') return NOTHING;

  const closing = source.closing_balance_minor;
  switch (source.balance_check) {
    case undefined:
    case 'not_available':
      // Said quietly, and only here: the user compared nothing, and an import
      // that worked must not look like a failure.
      return { tone: 'quiet', key: 'imports.balanceNoClosing' };
    case 'match':
      // The paired columns are NOT NULL together with the verdict (DB CHECK), so
      // a missing closing figure here means a server older than S2 — which
      // cannot answer `match` at all. Degraded to the quiet arm rather than
      // printed as a tick with nothing beside it.
      if (closing === undefined || closing === null) {
        return { tone: 'quiet', key: 'imports.balanceNoClosing' };
      }
      return { tone: 'ok', key: 'imports.balanceMatches', closing };
    case 'mismatch': {
      const appBalance = source.app_balance_minor_at_end;
      const diff = source.balance_diff_minor;
      if (
        appBalance === undefined ||
        appBalance === null ||
        diff === undefined ||
        diff === null ||
        closing === undefined ||
        closing === null
      ) {
        // Nothing true can be said without all three figures: the sentence
        // names each of them so the user can audit it against the PDF.
        return NOTHING;
      }
      return {
        // `app − closing`: positive means the app holds MORE than the bank says.
        // Zero cannot reach this arm (the server would have stamped `match`), so
        // it falls to the same side as positive rather than growing a third key.
        tone: 'warning',
        key: diff > 0 ? 'imports.balanceAppHigher' : 'imports.balanceAppLower',
        diffAbs: Math.abs(diff),
        appBalance,
        closing,
      };
    }
  }
}
