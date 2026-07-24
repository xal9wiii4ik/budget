# Spike: RN Request/body semantics for the auth coordinator (O4)

Owner: mobile-engineer. Status at implementation close: **probe shipped, NOT yet run
on-device; captured-init rebuild is the DEFAULT and is in force.**

## Question (O4)

Two things had to be true for the web coordinator's `authFetch` seam to port to RN:

- **(a)** Does openapi-fetch hand the injected `fetch` a `Request` (not a
  `[url, init]` pair) under React Native / Hermes?
- **(b)** Does RN/Hermes `Request.clone()` preserve an **un-sent JSON body** across a
  send, so the web pattern (`input.clone()` before bearer-attach, replay the clone on
  401) can be used verbatim?

## Code-grounded finding for (a) — settled by reading, not assumed

openapi-fetch is pinned at **0.17.0** in `packages/api-client/package.json` — the
SAME version the web client is verified against, and confirmed installed. Its
`src/index.js` builds `new Request(url, requestInit)` and calls
`fetch(request, requestInitExt)` — i.e. the injected fetch's first argument is a
`Request`. This is **library code, not platform code**, so it holds under RN too. The
`authFetch(input: Request)` seam is therefore structurally sound on RN. The shipped
`__DEV__` probe (`probe:O4a` in `apps/mobile/src/lib/probes.ts`) records this on-device
for completeness (it constructs a client with a local short-circuit fetch and logs
`input instanceof Request`), but the finding does not depend on running it.

## HAZARD (fixed): `.body`-gated read drops on-device write bodies (O4c)

The first implementation gated the body read on `input.body`:
`const bodyText = input.body ? await input.text() : null`. This passes the Node/vitest
gate but is WRONG on-device. `Request.prototype.body` is the browser-spec
`ReadableStream` getter; RN's whatwg-fetch-derived polyfill does **not** implement it —
the body is held internally as `_bodyInit` and `.body` stays `undefined`. undici (Node)
DOES expose `.body`, so the divergence is invisible to the Node gate. Result on-device:
`bodyText` becomes `null` and **every protected POST/PATCH body is silently dropped**.

**Fix — decide body presence by METHOD, not by `.body`:**

- `GET`/`HEAD` → no body; never call `text()`, never pass a body to the rebuild.
- Any other method → `const text = await input.text();` then `bodyText = text === '' ? null : text`.
  `Body.text()` IS implemented by both undici and the RN polyfill, so this is portable.
- `build()` passes `body: bodyText ?? undefined` so a bodyless rebuild never sends `''`.

A vitest regression tripwire (`coordinator.test.ts` → "RN POLYFILL TRIPWIRE: body reaches
the wire on send AND 401-replay even when input.body is undefined (O4c)") feeds `authFetch`
a hand-rolled Request-like object whose `.body` is `undefined` but whose `text()` resolves
to the JSON payload, and asserts the payload reaches the wire on BOTH the initial send and
the 401-retry replay. `probe:O4c` in `probes.ts` records the real polyfill shape on-device
(`'body' in Request.prototype` / `typeof probeRequest.body`) — the device run will confirm
`.body` is absent under Hermes.

## (b) remains on-device-uncertain — so the rebuild is the DEFAULT (as committed)

RN's `fetch`/`Request` come from a whatwg-fetch-derived polyfill (not a browser-native
implementation) with a documented history of body-clone quirks. Rather than depend on
`Request.clone()` preserving an un-sent body, the implemented coordinator uses the
**captured-init rebuild** (the plan's committed default):

- at `authFetch` entry, read the body ONCE by METHOD (see the O4c hazard above:
  `.body` cannot be trusted on RN) and capture `input.method` / `input.url` / headers;
- build **fresh** `Request` objects from `(url, { method, headers, body: bodyText ?? undefined })`
  for BOTH the initial send and the 401 retry.

A plain JS string body is replayable with certainty; there is **no `Request.clone()`
dependency** anywhere in the coordinator. Auth endpoints never reach `authFetch` (they
run on the plain `authClient`), so bodies here are JSON or empty — no FormData/stream
edge. The vitest suite proves the rebuild replays the identical body on retry
(`coordinator.test.ts` → "BODY PRESERVATION: the captured-init rebuild replays the
retry with the same body").

## Probe status

- `apps/mobile/src/lib/probes.ts` ships `probe:O4a` (Request seam), `probe:O4b`
  (clone body preservation), and `probe:O4c` (Request `.body` getter presence /
  polyfill shape — the O4c hazard above), run once at startup under `__DEV__` and
  logged to the Metro console.
- **Not yet run on a simulator/device**: this machine has no full Xcode, so
  `xcrun simctl` is unavailable (grooming-review R7). When a simulator/device exists,
  capture the `[probe:O4a]` / `[probe:O4b]` log lines here.
- `probe:O4b` consumes a sibling clone in place of an over-the-wire send so the probe
  needs no reachable server; the clone-body question is answered the same way. Even a
  FAIL there does not change the shipped design — the rebuild does not use `clone()`.

## Decision

**Captured-init rebuild stays the default regardless of the on-device probe outcome.**
If a future on-device run proves `clone()` sound AND a reason emerges to prefer it, the
switch is localized to `authFetch` in `apps/mobile/src/auth/coordinator.ts`; nothing
else depends on the choice.
