import { describe, expect, it } from 'vitest';

import { aiStatusLine } from './aiStatusLine';

// The cases below are the arms that differ in SHAPE — which clauses are
// present, in which order, and under which tone. Re-asserting each of the five
// statuses with every combination of counts would only re-prove the same
// structure (senior-lead's grooming resolution).
describe('aiStatusLine', () => {
  it('says nothing when the session has no ai_status (pre-ai-layer server)', () => {
    expect(aiStatusLine({})).toEqual({ tone: 'quiet', parts: [] });
  });

  it('names a server without a provider quietly, as a fact and not a failure', () => {
    expect(aiStatusLine({ ai_status: 'not_configured' })).toEqual({
      tone: 'quiet',
      parts: [{ key: 'imports.aiOff' }],
    });
  });

  it('explains a configured provider that had nothing to do', () => {
    expect(aiStatusLine({ ai_status: 'skipped' })).toEqual({
      tone: 'quiet',
      parts: [{ key: 'imports.aiSkipped' }],
    });
  });

  it('omits the "to check" clause when nothing is flagged', () => {
    expect(
      aiStatusLine({ ai_status: 'ok', ai_rows_suggested: 7, ai_rows_flagged: 0 }),
    ).toEqual({ tone: 'quiet', parts: [{ key: 'imports.aiSuggested', count: 7 }] });
  });

  it('carries the counts AND the note on a partial pass, and warns', () => {
    expect(
      aiStatusLine({ ai_status: 'partial', ai_rows_suggested: 4, ai_rows_flagged: 2 }),
    ).toEqual({
      tone: 'warning',
      // `count` is passed through, never pre-formatted: ru plural agreement is
      // the dictionary's job (`Intl.PluralRules`), not this module's.
      parts: [
        { key: 'imports.aiSuggested', count: 4 },
        { key: 'imports.aiFlagged', count: 2 },
        { key: 'imports.aiPartial' },
      ],
    });
  });

  it('renders no count on a failed pass, even if the fields carry some', () => {
    expect(
      aiStatusLine({ ai_status: 'failed', ai_rows_suggested: 3, ai_rows_flagged: 9 }),
    ).toEqual({ tone: 'warning', parts: [{ key: 'imports.aiFailed' }] });
  });
});
