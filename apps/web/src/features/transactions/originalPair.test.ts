import { describe, expect, it } from 'vitest';

import { describeOriginalPairError } from './originalPair';

describe('describeOriginalPairError', () => {
  it('turns a missing rate into "type the charged amount", not a failure', () => {
    const described = describeOriginalPairError('FX_RATE_UNAVAILABLE');
    expect(described?.needsManualCharge).toBe(true);
    expect(described?.target).toBe('amount');
    // The copy explains the six stored pairs and asks for the bank's own number;
    // it is NOT the generic failure key.
    expect(described?.messageKey).toBe('txForm.chargeNoRateAhead');
  });

  it('leaves codes it does not own to the shared error layer', () => {
    expect(describeOriginalPairError('TRANSACTION_NOT_FOUND')).toBeNull();
    expect(describeOriginalPairError(undefined)).toBeNull();
  });
});
