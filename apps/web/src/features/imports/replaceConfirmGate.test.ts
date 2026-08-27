import { describe, expect, it } from 'vitest';

import {
  canConfirmReplace,
  replaceConfirmState,
  type ReplaceConfirmInput,
} from './replaceConfirmGate';

// A confirmed, ready-to-fire replace: 12 operations previewed for the very date
// on screen, and "12" typed back. Every case below is this one, minus one fact.
const CONFIRMED: ReplaceConfirmInput = {
  fromDate: '2026-06-01',
  periodFrom: '2026-05-26',
  periodTo: '2026-08-26',
  previewFrom: '2026-06-01',
  previewDeletedTotal: 12,
  typed: '12',
  isSubmitting: false,
};

describe('replaceConfirmState', () => {
  it('unlocks only when the typed number IS the previewed one', () => {
    expect(replaceConfirmState(CONFIRMED)).toEqual({ status: 'ready', deletedTotal: 12 });
    expect(canConfirmReplace(replaceConfirmState(CONFIRMED))).toBe(true);
  });

  it('refuses a number that is not the previewed one', () => {
    const state = replaceConfirmState({ ...CONFIRMED, typed: '13' });
    expect(state).toEqual({ status: 'needs_confirmation', deletedTotal: 12, mismatch: true });
    expect(canConfirmReplace(state)).toBe(false);
  });

  it('does not treat an empty box as a mismatch, but does not unlock either', () => {
    const state = replaceConfirmState({ ...CONFIRMED, typed: '   ' });
    expect(state).toEqual({ status: 'needs_confirmation', deletedTotal: 12, mismatch: false });
  });

  // The critical one: the same "12" that was correct a second ago must stop
  // confirming as soon as it describes another range.
  it('locks again when the date moves away from the previewed one', () => {
    const state = replaceConfirmState({ ...CONFIRMED, fromDate: '2026-07-01' });
    expect(state).toEqual({ status: 'needs_preview' });
    expect(canConfirmReplace(state)).toBe(false);
  });

  it('locks while the preview itself is missing (loading, failed or refetching)', () => {
    expect(replaceConfirmState({ ...CONFIRMED, previewDeletedTotal: null })).toEqual({
      status: 'needs_preview',
    });
    expect(replaceConfirmState({ ...CONFIRMED, previewFrom: null })).toEqual({
      status: 'needs_preview',
    });
  });

  // Zero is a real, confirmable figure — "nothing will be deleted, go ahead" —
  // and an empty box must not pass for it.
  it('treats a zero preview as a number to type, not as no confirmation', () => {
    const zeroed = { ...CONFIRMED, previewDeletedTotal: 0 };
    expect(replaceConfirmState({ ...zeroed, typed: '' })).toEqual({
      status: 'needs_confirmation',
      deletedTotal: 0,
      mismatch: false,
    });
    expect(replaceConfirmState({ ...zeroed, typed: '0' })).toEqual({
      status: 'ready',
      deletedTotal: 0,
    });
  });

  it('rejects a number that is not the printed one in disguise', () => {
    for (const typed of ['+12', '12.0', '1e1', ' 1 2 ']) {
      expect(replaceConfirmState({ ...CONFIRMED, typed })).toEqual({
        status: 'needs_confirmation',
        deletedTotal: 12,
        mismatch: true,
      });
    }
  });

  it('names the date problems before asking for a preview', () => {
    expect(replaceConfirmState({ ...CONFIRMED, fromDate: '' })).toEqual({ status: 'needs_date' });
    expect(replaceConfirmState({ ...CONFIRMED, fromDate: '2026-05-25' })).toEqual({
      status: 'out_of_range',
    });
    expect(replaceConfirmState({ ...CONFIRMED, fromDate: '2026-08-27' })).toEqual({
      status: 'out_of_range',
    });
  });

  it('is inert while the request is in flight', () => {
    expect(replaceConfirmState({ ...CONFIRMED, isSubmitting: true })).toEqual({
      status: 'submitting',
    });
  });
});
