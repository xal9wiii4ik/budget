// Does the statement agree with ITSELF? (pdf-reconcile S2 → web A)
//
// The bank prints an opening balance, a closing balance and a table of
// operations; S2 checks the four claims those make (the balance chain, the two
// totals, the dates inside the period) and stores the verdict plus the two
// figures that disagreed. This module decides WHICH sentence is true of that
// verdict — nothing else.
//
// PURE and LANGUAGE-FREE by the house rule (the `aiStatusLine` precedent): keys
// out, never sentences, and the two integers are handed over RAW for the caller
// to `formatMoney` at the STATEMENT's currency.
//
// It never subtracts. `expected` and `actual` are both server integers and both
// are rendered: they are the two numbers the user can literally find (one in
// the PDF's balance line, one by adding up the preview), and a lone difference
// would hide which side is bigger in a way nothing on screen could audit.
import type { StatementSelfCheckFailure, StatementSelfCheckStatus } from '../../data/imports';
import type { SimpleKey } from '../../i18n/t';

/**
 * Structural on purpose: the helper takes the four fields it reads, so a test
 * does not have to build a whole session read. All four are OPTIONAL even
 * though the contract now sends them required — a server older than S2 sends
 * none, and that reads as `not_available`, i.e. render nothing.
 */
export interface SelfCheckSource {
  self_check_status?: StatementSelfCheckStatus;
  self_check_failed?: StatementSelfCheckFailure | null;
  self_check_expected_minor?: number | null;
  self_check_actual_minor?: number | null;
}

/** The two figures the failed check disagreed about, in statement minor units. */
export interface SelfCheckFigures {
  expected: number;
  actual: number;
}

export type SelfCheckLine =
  /** Priorbank, and every session parsed before S2: no check ever ran. */
  | { tone: 'none'; key: null; figures: null }
  | { tone: 'ok'; key: SimpleKey; figures: null }
  /**
   * `figures` is null exactly when `key` is a sentence with no numbers in it
   * (`date_range`, or the general fallback) — so the caller never interpolates
   * into a template that has no placeholders, and never leaves one empty.
   */
  | { tone: 'warning'; key: SimpleKey; figures: SelfCheckFigures | null };

const NOTHING: SelfCheckLine = { tone: 'none', key: null, figures: null };

/** Which of the four checks failed → the sentence that names it. */
const FAILED_KEYS: Readonly<Record<StatementSelfCheckFailure, SimpleKey>> = {
  balance: 'imports.selfCheckBalance',
  income_total: 'imports.selfCheckIncomeTotal',
  expense_total: 'imports.selfCheckExpenseTotal',
  date_range: 'imports.selfCheckDateRange',
};

export function selfCheckLine(source: SelfCheckSource): SelfCheckLine {
  switch (source.self_check_status) {
    case undefined:
    case 'not_available':
      // NOT a green tick: a tick would claim a check passed that never ran.
      return NOTHING;
    case 'passed':
      return { tone: 'ok', key: 'imports.selfCheckPassed', figures: null };
    case 'failed': {
      const failed = source.self_check_failed;
      // The DB CHECK makes `failed` imply a named check, so this arm is
      // unreachable from a correct server — it still says that the statement
      // does not add up, because silence would read as "all good".
      if (failed === undefined || failed === null) {
        return { tone: 'warning', key: 'imports.selfCheckFailed', figures: null };
      }
      // Dates, not money: the two integer columns are NULL for this check by
      // design, and its sentence is written without them.
      if (failed === 'date_range') {
        return { tone: 'warning', key: FAILED_KEYS.date_range, figures: null };
      }
      const expected = source.self_check_expected_minor;
      const actual = source.self_check_actual_minor;
      if (
        expected === undefined ||
        expected === null ||
        actual === undefined ||
        actual === null
      ) {
        // The three money checks always store both figures (the paired NOT NULL
        // columns), so this takes a server older than S2. Their sentences are
        // BUILT around the two numbers, so without them the honest line is the
        // general one rather than a sentence with a hole in it.
        return { tone: 'warning', key: 'imports.selfCheckFailed', figures: null };
      }
      return { tone: 'warning', key: FAILED_KEYS[failed], figures: { expected, actual } };
    }
  }
}
