// __DEV__-only on-device probes (plan §A step 1-2 for O4, and §E for W11). These
// RECORD Hermes runtime behaviour that the Node/vitest gate cannot observe; both
// probed features have committed fallbacks so the app never blocks on the outcome.
// The findings are logged to the Metro console for capture in
// .tasks/mobile-mvp/spike-request-clone.md when a simulator/device is available.
//
// Kept out of the vitest graph: this module references the RN `__DEV__` global and
// is imported only by the root layout, never by a test.
import { createApiClient } from '@budget/api-client';

// O4 (a): does openapi-fetch hand the injected fetch a `Request` under RN? Verified
// with a local short-circuit fetch (no network) so the probe is side-effect-free.
async function probeOpenapiFetchSeam(): Promise<void> {
  try {
    const client = createApiClient({
      baseUrl: 'http://probe.local',
      fetch: async (input) => {
        console.log(
          '[probe:O4a] input instanceof Request =',
          input instanceof Request,
          '| url =',
          input.url,
          '| method =',
          input.method,
        );
        return new Response(null, { status: 204 });
      },
    });
    await client.GET('/users/me');
  } catch (error) {
    console.log('[probe:O4a] threw:', String(error));
  }
}

// O4 (b): does RN/Hermes Request.clone() preserve an un-sent JSON body? Consuming a
// sibling clone stands in for the "send" leg so the probe needs no reachable server;
// the clone-body question is answered the same way. Rebuild remains the default
// regardless of this outcome.
async function probeRequestCloneBody(): Promise<void> {
  const body = JSON.stringify({ probe: 1 });
  try {
    const original = new Request('http://probe.local/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const sent = await original.clone().text();
    const replay = await original.clone().text();
    console.log(
      '[probe:O4b] clone preserves body =',
      sent === body && replay === body,
      '| sent.len =',
      sent.length,
    );
  } catch (error) {
    console.log('[probe:O4b] clone threw:', String(error));
  }
}

// O4 (c): does RN's Request expose the browser-spec `.body` ReadableStream getter, or
// is the body reachable ONLY via text()? The coordinator decides body presence by
// METHOD precisely because `.body` is expected to be undefined here (whatwg-fetch
// polyfill holds it as `_bodyInit`); under undici/Node `.body` DOES exist, which is why
// the Node gate cannot observe this. Records the real on-device shape.
async function probeRequestBodyShape(): Promise<void> {
  try {
    const probeRequest = new Request('http://probe.local/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ probe: 1 }),
    });
    console.log(
      "[probe:O4c] 'body' in Request.prototype =",
      'body' in Request.prototype,
      '| typeof probeRequest.body =',
      typeof probeRequest.body,
      '| text() reads =',
      (await probeRequest.text()).length > 0,
    );
  } catch (error) {
    console.log('[probe:O4c] threw:', String(error));
  }
}

// W11: does Hermes ship a working Intl.Collator (the 0.1 canary only proved
// Intl.NumberFormat)? sortForDisplay isolates the fallback, so this only records.
// PluralRules is logged alongside it because its absence is what red-screened two
// tabs (D-1); i18n/plural.ts now computes the category itself, so this only makes
// the next Hermes Intl seam visible in the Metro log instead of on a device.
function probeIntlCollator(): void {
  try {
    const collator = new Intl.Collator(undefined, { sensitivity: 'base' });
    const sorted = ['Z', 'a', 'Ё', 'Е'].sort((x, y) => collator.compare(x, y));
    console.log(
      '[probe:W11] Collator available =',
      typeof Intl?.Collator === 'function',
      '| PluralRules =',
      typeof Intl?.PluralRules,
      // mobile-catchup-2: which arm of lib/countryLabel is live. Absent here means
      // the country picker shows "🇬🇪 GE" instead of "Georgia" — committed
      // fallback, so this only records which one a device actually got.
      '| DisplayNames =',
      typeof Intl?.DisplayNames,
      '| compare(Ё,Е) =',
      collator.compare('Ё', 'Е'),
      '| sort =',
      sorted.join(','),
    );
  } catch (error) {
    console.log('[probe:W11] Collator threw:', String(error));
  }
}

/** Run all dev probes once at startup. No-op outside __DEV__. */
export function runDevProbes(): void {
  if (!__DEV__) return;
  probeIntlCollator();
  void probeOpenapiFetchSeam();
  void probeRequestCloneBody();
  void probeRequestBodyShape();
}
