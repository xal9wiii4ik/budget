import { describe, expect, it } from 'vitest';

import { sameServerKey, urlBase64ToUint8Array } from './pushKeys';

describe('pushKeys', () => {
  it('decodes base64url (with - and _, unpadded) and compares a subscription key byte for byte', () => {
    // Standard base64 "+/+/AA==" — the url alphabet swaps both symbols and drops
    // the padding, which is exactly how VAPID public keys are printed.
    const bytes = urlBase64ToUint8Array('-_-_AA');
    expect([...bytes]).toEqual([0xfb, 0xff, 0xbf, 0x00]);

    expect(sameServerKey(new Uint8Array([0xfb, 0xff, 0xbf, 0x00]).buffer, '-_-_AA')).toBe(true);
    expect(sameServerKey(new Uint8Array([0xfb, 0xff, 0xbf, 0x01]).buffer, '-_-_AA')).toBe(false);
  });
});
