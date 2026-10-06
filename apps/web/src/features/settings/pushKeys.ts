// The VAPID public key in the two shapes the browser deals in (web-push W1).
//
// The server ships the key as base64url (no padding, `-`/`_`), the way every
// VAPID tool prints it; `PushManager.subscribe()` wants the raw bytes, and an
// existing subscription hands its key back as an `ArrayBuffer`. PURE — no DOM
// beyond `atob`, which node has too — so both directions are pinned by a test.

/**
 * base64url → bytes, for `applicationServerKey`.
 *
 * The explicit `Uint8Array<ArrayBuffer>` is load-bearing: TS 5.9's
 * `BufferSource` is `ArrayBufferView<ArrayBuffer>`, so a plain `Uint8Array`
 * (`ArrayBufferLike`, which admits a SharedArrayBuffer) does not type-check as
 * the subscribe option.
 */
export function urlBase64ToUint8Array(key: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (key.length % 4)) % 4);
  const base64 = (key + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

/**
 * Whether a subscription was made with the server's CURRENT key.
 *
 * A subscription is bound to the key it was created with; after a VAPID
 * rotation the push service refuses every send to it, and re-POSTing it to our
 * server cannot fix that. `null` (a subscription with no key at all) and a key
 * that does not decode are both "not ours".
 */
export function sameServerKey(buffer: ArrayBuffer | null, key: string): boolean {
  if (buffer === null) return false;
  let expected: Uint8Array<ArrayBuffer>;
  try {
    expected = urlBase64ToUint8Array(key);
  } catch {
    return false;
  }
  const actual = new Uint8Array(buffer);
  if (actual.length !== expected.length) return false;
  return actual.every((byte, index) => byte === expected[index]);
}
