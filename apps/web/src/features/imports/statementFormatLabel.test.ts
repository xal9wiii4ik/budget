import { describe, expect, it } from 'vitest';

import { statementFormatLabel } from './statementFormatLabel';

describe('statementFormatLabel', () => {
  // The reason this module exists: a server deployed with a newer parser
  // registry than this build. The unknown id must come back as a printable
  // label, not as `undefined` (which the picker would render as a blank option)
  // and not as a throw (which would take the whole upload window down).
  it('falls back to the identifier itself for a format this build has no name for', () => {
    expect(statementFormatLabel('alfabank_xlsx_v1')).toEqual({
      kind: 'unknown',
      label: 'alfabank_xlsx_v1',
    });
    // Contrast: a known id does NOT take that branch, so the assertion above is
    // about the fallback rather than about every input.
    expect(statementFormatLabel('priorbank_csv_v1').kind).toBe('known');
  });
});
