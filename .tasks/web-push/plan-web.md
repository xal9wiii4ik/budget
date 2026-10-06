# Implementation Plan (web): web push reminders — W1

## Approach
One Settings section explains what this device can do and gives one button for it. The browser
subscription is browser state: it is read from `pushManager.getSubscription()` and never put in
the Query cache. The only server state is `GET /push/config` plus three mutations (arch §6–§7).
A pure `notificationsState()` turns six facts into one of six arms, and the component renders
exactly that arm. `sw.js` gains `push` and `notificationclick`. The offline code stays byte-identical.
**Gate dependency:** the `components['schemas']['Push*']` types arrive with B1's `pnpm openapi` regen,
so W1 typecheck/lint/test cannot go green before B1 lands. `schema.d.ts` currently has no `/push`.

## Route verdict (arch §5 URL targets vs `src/App.tsx`)
**All six OK:** `/goals/:goalId` (l.42), `/goals` (l.38), `/recurring` (l.37), `/deposits` (l.35), `/transactions` (l.31),
`/settings` (l.51), all under ProtectedLayout; nginx `try_files … /index.html` deep-links them; logged-out tap → login guard.

## Screens / components affected
- `public/sw.js` — append the two handlers below. `install`/`activate`/`fetch`/`CACHE` stay untouched (no cache bump).
  The ONE header edit: `/* global … */` gains `URL`. eslint DOES lint `public/sw.js` with `no-undef`
  (probed: `URL` and bare `clients` both error), so the handlers use `self.clients` / `self.registration`.
  - `push`: `event.waitUntil(showNotification(...))`. Every field is type-checked inside a try.
    - `title` non-empty string else `FALLBACK_TITLE = 'Budget'` (manifest name, language-neutral); `body` string else `''`;
      `tag` string else omitted; `url` through `safePath()` (`new URL(url, origin)` must keep the origin, else `/`).
    - The handler NEVER returns without showing a notification (`userVisibleOnly`). Safari revokes
      subscriptions whose pushes show nothing. So `data` is null or not JSON → generic notification, no throw.
    - Options: `{body, tag, data:{url}, icon:'/icons/icon-192.png'}`. The icon is verified in `public/icons/`.
  - `notificationclick`: `close()`, then `waitUntil`. `target = safePath(data.url)`.
    - `matchAll({type:'window', includeUncontrolled:true})` → keep the clients with the same origin.
      Prefer one whose `url === target`, else the first one.
    - `focus()` first (while the click's activation is live), then `navigate(target)` if not already there. `navigate` REJECTS
      for an uncontrolled client (page loaded before the first register) → `.catch` → `openWindow(target)`. No client → `openWindow`.
    - A full navigation (the SPA reboots at the deep link) is chosen over postMessage-routing, which would need an app-side listener.
- `src/routes/SettingsPage.tsx` — `<NotificationsSection />` between `<PasswordSection />` and the profile block. The slot is accepted.
  It does not depend on `profileQuery`: a failed profile read must not hide it.
- `src/data/queryKeys.ts` — `pushConfig: () => ['push','config'] as const`, a new disjoint root. Comment in the tokens style.
- `src/i18n/dict.en.ts` + `dict.ru.ts` — `settings.notifications.*`, about 22 keys. Plurals: `testSent` {one/other} in EN, one/few/many in RU.
- `src/lib/errors.ts` — `describePushError(error, lang) → {kind:'server-off'|'rate-limited'|'other', message}`.
  - A new helper is needed: `PUSH_NOT_CONFIGURED` is an ARM switch, not a message, and the existing helpers carry
    field routing that push has no use for.
  - network and generic copy go through shared `errorMessage`. `RATE_LIMITED` → the web key `settings.notifications.rateLimited`.
    Adding it to shared `ERROR_MESSAGES` would touch the frozen mobile package.
- `nginx.conf` — `location = /sw.js` already `no-cache` (l.85): **no change**. `src/main.tsx` — no change (PROD-only stays).

## New components / hooks
- `src/data/push.ts` — module note + types from `components['schemas']`: `PushConfigRead`, `PushSubscriptionCreate`,
  `PushSubscriptionRead`, `PushTestResult`, `PushUnsubscribe`. Final names follow B1's schema.
  - `usePushConfig()` (`GET /push/config`, `staleTime` 1h — `importFormats` precedent: config changes only on restart);
    `useSubscribePush()` (POST `/push/subscriptions`, `throwOnError`); `useUnsubscribePush()` (POST `/push/unsubscribe`,
    204 unwrapped by hand — `useRevokeToken` precedent); `useSendTestPush()` (POST `/push/test`).
  - Every mutation's `onError`: `PUSH_NOT_CONFIGURED` → invalidate `['push']`, so the refetched `enabled:false` flips the arm.
- `src/features/settings/notificationsState.ts` — PURE. `notificationsState(input) → NotificationsArm`.
  - Inputs: `{supported, isIOS, standalone, permission, serverEnabled, subscribed}`.
  - Also pure, with environment values as arguments: `supportsPush(env)`, `isIOSDevice({userAgent, platform, maxTouchPoints})`,
    `isStandalone({navigatorStandalone, displayModeStandalone})`. The global readers are a 6-line `readPushEnvironment()` in
    the hook, so the module stays testable under vitest `environment:'node'`.
  - **Precedence (one change vs the brief, with evidence):** `ios-not-installed → unsupported → server-off → denied → on|off`.
    - iOS Safari outside a Home-Screen install does not expose `PushManager` or `Notification` (WebKit: push is for Home-Screen web apps only).
      With `unsupported` first, every iPhone in a tab would get the dead-end "unsupported" sentence instead of the one instruction that helps.
    - An installed iOS < 16.4 app is standalone, so it correctly falls to `unsupported`.
    - `server-off` outranks `denied`: nothing the user does on the device can help. Sending them to OS settings first would be a wasted trip.
    - `on` ⇔ `subscribed && permission==='granted'`. A subscription with revoked permission reads as `denied`, which the precedence already covers.
  - `isIOSDevice` treats `/iPad|iPhone|iPod/` OR (`platform==='MacIntel' && maxTouchPoints>1`) as iOS. iPadOS sends a desktop
    Mac UA, and a real Mac must NOT get the install arm: desktop Safari pushes without install.
  - Standalone check without a cast (an `in`-narrowing, not an interface lie):
    ```ts
    const navigatorStandalone = 'standalone' in navigator && navigator.standalone === true;
    const displayModeStandalone = window.matchMedia('(display-mode: standalone)').matches;
    ```
- `src/features/settings/pushKeys.ts` — PURE.
  - `urlBase64ToUint8Array(key): Uint8Array<ArrayBuffer>`. The explicit return type is load-bearing: TS 5.9 `BufferSource` is
    `ArrayBufferView<ArrayBuffer>`, so a plain `Uint8Array` (`ArrayBufferLike`) does not type-check as `applicationServerKey`.
  - `sameServerKey(buffer: ArrayBuffer|null, key: string): boolean`, used for the rotation check below.
- `src/features/settings/useNotifications.ts` — the hook. It holds:
  - `local: {status:'checking'} | {status:'ready', subscription: PushSubscription|null}`.
  - `permission` (initialised from `Notification.permission`, set after a request).
  - `busy: null|'enabling'|'disabling'`, `error?: string`, `testResult?: PushTestResult`.
  - **Reading** uses `navigator.serviceWorker.getRegistration()` → `pushManager.getSubscription()`. NEVER `.ready` on mount:
    `.ready` never settles when nothing is registered (every `vite dev` session before the first Enable). That would be an eternal skeleton.
  - **Enable** (all inside the click handler; nothing requests permission outside it — the iOS rule):
    1. `register('/sw.js')` → `await serviceWorker.ready` → `Notification.requestPermission()`; `'denied'` → arm flips to
       denied; `'default'` (dismissed) → stay off, no error. 2–3. `subscribe({userVisibleOnly:true, applicationServerKey})`.
    4. `toJSON()` narrowed: `endpoint`, `keys.p256dh` and `keys.auth` must all be strings, else an error line. No `!` or `as`.
    5. POST with `lang: useLang()` and `user_agent: navigator.userAgent.slice(0,255)`.
    6. POST fails → `sub.unsubscribe()` (rollback: `on` never lies). 7. `subscribe()` throws (NotAllowed/Abort) → error line.
  - **Disable**: `sub.unsubscribe()` → POST unsubscribe. A POST failure leaves the arm `off` (it is, on this device) with a note:
    the server drops the row itself on the next send (410 → gone, arch §3).
  - **Test**: shows the `{sent, removed}` line. On `{sent:0}` while the browser holds a subscription, the server lost this device:
    unsubscribe locally → arm `off` + the "not registered — turn on again" line. The copy points at a button that is now on screen.
  - **Re-sync** (arch §7): an effect fires once `config.enabled` and `local.status==='ready'` with a subscription.
    - A `useRef` guard makes it fire once. React 19 StrictMode keeps refs across its dev double-invoke, so that is one POST.
    - If `!sameServerKey(sub.options.applicationServerKey, config.public_key)` (VAPID rotated): the old subscription is dead at the
      push service → unsubscribe + POST unsubscribe → `off`. `subscribe()` needs a gesture on Safari, so no silent re-subscribe.
    - Otherwise: re-POST (idempotent upsert; heals a deleted row).
    - Language changes need no re-POST: the server prefers `profile.language` (arch §4.5), which LanguageSection already PATCHes.
- `src/features/settings/NotificationsSection.tsx` — `.section` / `.title` / `.lede` from `SettingsSections.module.css` (no new CSS file).
  It renders one arm, buttons via the shared `Button` with `loading`. Lede: reminders about goals, deposits and payments,
  one notification a day, no amounts on the lock screen.

## Data layer
- The four `/push/*` routes, JWT, via `apiClient` only. Key `qk.pushConfig()` = `['push','config']` is the only cached entry.
  Invalidation: none on success (no cached read changes); `PUSH_NOT_CONFIGURED` → `['push']`. No optimistic updates.

## UI states (the section)
- loading: config pending OR `local.status==='checking'` → `.skeletonControl`. Same height as a button row, so no jump.
  `ios-not-installed` and `unsupported` render immediately without waiting for config: they outrank it.
- error: config read failed → `QueryStateNotice compact` with `settings.notifications.loadFailed` + Retry.
- arms (RU+EN):
  - unsupported: one sentence. ios-not-installed: Share → Add to Home Screen → open Budget from the icon.
  - server-off: in the tone of `advisor.aiNotConfigured`, e.g. "Notifications are unavailable — no push keys are configured on
    the server" / "Уведомления недоступны — на сервере не настроены ключи".
  - denied: allow in the browser's site settings; on iPhone, Settings → Notifications → Budget.
  - off: Enable. on: status + Disable + Send test.
- success lines (`role="status"`): "Sent to N devices", plus "M stale removed" when >0. `{sent:0}` → the honest
  "no device registered — turn on again".
- action errors: `role="alert"` line from `describePushError`. 503 → server-off arm, 429 → rateLimited key.

## Dev experience (document in docs/web.md "Install surface" at implementation)
- `vite dev` serves `public/sw.js` as-is at `/sw.js`, and `pwaAssets` answers `/offline.html`, so the worker's install succeeds.
  `localhost` is a secure context. Enable therefore works in Chrome and Safari on the Mac under `vite dev`.
- After the first Enable, the worker controls dev pages. It touches navigations only (failed → offline page), never HMR or modules.
  Same origin as the docker web on :5173, same file, so it is harmless.
- Only limitation: actual delivery needs the VAPID trio in `apps/api/.env`; without it → `server-off` arm.

## Tests (2 files, 4 tests; nothing DOM)
- `notificationsState.test.ts` (3): (1) a table reaching all six arms; (2) the two ordering claims — `server-off` beats
  `denied`, `ios-not-installed` beats `unsupported` when the tab lacks PushManager; (3) `isIOSDevice`: iPadOS desktop UA → iOS, a Mac → not.
- `pushKeys.test.ts` (1): one known base64url vector (`-`/`_` + no padding) decodes to the exact bytes, and
  `sameServerKey` matches it and rejects a 1-byte change.
- No SW test: vitest has no ServiceWorkerGlobalScope runtime; web-qa checks the worker in a browser.
- Gates: `pnpm turbo lint typecheck test --filter=@budget/web`, AFTER B1's contract regen.

## Open questions
1. Precedence: I propose `ios-not-installed` first (evidence above), a deviation from the brief's order. Needs senior-lead OK.
2. The rotation check in re-sync (unsubscribe on key mismatch) goes beyond §7's "re-POST is how a rotation reaches the server".
   A re-POST cannot fix a subscription bound to the old key. Accept, or drop to keep scope minimal?

## Risks
- iOS standalone/iPad detection (test 3; a real-device check needs HTTPS — Tailscale/deploy). `.ready` hang (`getRegistration`
  on read). StrictMode double effect (ref guard). `navigate()` on an uncontrolled client (catch → `openWindow`).
- `applicationServerKey` encoding/typing (test + explicit `Uint8Array<ArrayBuffer>`). `sw.js` lint globals. Safari dropping
  subscriptions if any push path skips `showNotification`.
