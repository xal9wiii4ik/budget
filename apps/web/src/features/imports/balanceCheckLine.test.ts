import { describe, expect, it } from 'vitest';

import { balanceCheckLine } from './balanceCheckLine';

describe('balanceCheckLine', () => {
  // `not_available` is AMBIGUOUS on the wire: it means "not computed yet" on a
  // preview and "the statement printed no closing balance" on a finished
  // import, and the session's STATUS is the only thing that tells them apart.
  // Getting this backwards grows a line about a ledger nothing has touched.
  it('says nothing on a preview and says why on a finished import', () => {
    expect(
      balanceCheckLine({ status: 'parsed', balance_check: 'not_available' }).tone,
    ).toBe('none');
    expect(balanceCheckLine({ status: 'applied', balance_check: 'not_available' })).toEqual({
      tone: 'quiet',
      key: 'imports.balanceNoClosing',
    });
  });

  it('shows the closing balance when the account matches the bank', () => {
    expect(
      balanceCheckLine({
        status: 'applied',
        balance_check: 'match',
        closing_balance_minor: 450_000,
        app_balance_minor_at_end: 450_000,
        balance_diff_minor: 0,
      }),
    ).toEqual({ tone: 'ok', key: 'imports.balanceMatches', closing: 450_000 });
  });

  // The sign of `balance_diff_minor` (server field = app − closing) is the ONE
  // derivation in this scope, and flipping it inverts a sentence about the
  // user's money. The two directions are asserted against the SAME magnitude,
  // which is what makes them a contrast rather than two copies of one case.
  it('turns a positive difference into "the app holds more"', () => {
    expect(
      balanceCheckLine({
        status: 'applied',
        balance_check: 'mismatch',
        closing_balance_minor: 450_000,
        app_balance_minor_at_end: 451_250,
        balance_diff_minor: 1_250,
      }),
    ).toEqual({
      tone: 'warning',
      key: 'imports.balanceAppHigher',
      diffAbs: 1_250,
      appBalance: 451_250,
      closing: 450_000,
    });
  });

  it('turns a negative difference into "the app holds less", same magnitude', () => {
    expect(
      balanceCheckLine({
        status: 'replaced',
        balance_check: 'mismatch',
        closing_balance_minor: 451_250,
        app_balance_minor_at_end: 450_000,
        balance_diff_minor: -1_250,
      }),
    ).toEqual({
      tone: 'warning',
      key: 'imports.balanceAppLower',
      diffAbs: 1_250,
      appBalance: 450_000,
      closing: 451_250,
    });
  });

  // A mismatch is a sentence that NAMES all three figures, so without them
  // there is nothing true to render — and inventing a bare "they differ" line
  // would be a claim the user cannot audit.
  it('renders nothing for a mismatch whose figures did not arrive', () => {
    expect(balanceCheckLine({ status: 'applied', balance_check: 'mismatch' }).tone).toBe(
      'none',
    );
  });
});
