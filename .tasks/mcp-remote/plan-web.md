# Implementation Plan (web): mcp-remote — OAuth consent page + Connected AI apps

## Approach
Two disjoint surfaces, no shared state. (1) `/oauth/consent?req=<uuid>` — a BARE page outside the
nav shell (D6 / rec. 5): it is a dialogue a third party opened, and a sidebar inviting the user off
to /stats mid-grant is wrong. It still needs the session, so the guard is EXTRACTED from
`ProtectedLayout` into `auth/RequireAuth.tsx` (a `{children}` wrapper, not a second layout route):
the one redirect expression — `?next=` + `reason=expired` — stays written once, `ProtectedLayout`
becomes `<RequireAuth><ProtectedShell/></RequireAuth>`, and consent stays a plain leaf route in
`App.tsx` rather than a third nested `<Route element>` whose only job is auth. The shipped
`encodeURIComponent(pathname + search)` already carries `?req=` through login, and `safeNextPath`
accepts `/oauth/consent?req=…`. (2) Settings gets a fourth section, built like the tokens block.
The one load-bearing piece of logic is the redirect guard: the server composes `redirect_to` from
the STORED `redirect_uri`, so the client check is belt-and-braces — but it is the last line against
an open redirect, so it is pure, tested, and a failure renders an error instead of navigating. No
money anywhere on either surface.

## Screens / components affected
- `App.tsx` — one leaf route `/oauth/consent` (above `*`), outside the `ProtectedLayout` element.
- `routes/ProtectedLayout.tsx` — guard body moves out; keeps `ProtectedShell`, re-exports
  `ProtectedLayout` as the wrapper. No shell behaviour change.
- `routes/SettingsPage.tsx` — `<ConnectedAppsSection />` after `NotificationsSection`, BEFORE the
  tokens block (the connector is the primary path now; a manual token is the fallback). No new state.
- `data/queryKeys.ts` — two new disjoint roots + the comment on why (below); `lib/errors.ts` —
  `describeOAuthError(error, lang, t)` (the `describePushError` signature verbatim); `i18n/dict.en.ts`
  + `dict.ru.ts` — the `consent.*` / `connectedApps.*` blocks.

## New components / hooks
- `auth/RequireAuth.tsx` — the extracted guard (`useIsAuthenticated` + `coordinator.wasSessionExpired()`).
- `routes/ConsentPage.tsx` + `.module.css` — the bare page. Deliberately NOT `AuthLayout` (it
  hardcodes the brand/title/footer grammar of a sign-in form): own `<main>` + card off the same
  tokens, `ThemeToggle`/`LanguageToggle` in a corner — the AuthLayout precedent, not its component.
- `features/oauth/redirectGuard.ts` — pure `isAllowedRedirect(raw): boolean`;
  `features/oauth/ConnectedAppsSection.tsx` — query + list + confirm + the connect pointer.
- `features/oauth/ConnectedAppRow.tsx` + `.module.css` — a SIBLING of `TokenRow`, not a reuse:
  `TokenRead.name` is a non-null user string, `OAuthAppRead.client_name` is a nullable string the APP
  declared, and the rows want different copy and a different revoke question; widening `TokenRow`
  into a structural union with four label props costs more than ~30 duplicated CSS lines (the call
  `TokenRow.module.css` already makes about `Card`).
- `data/oauthApps.ts` (`useConnectedApps`, `useRevokeConnectedApp`) and `data/oauthRequest.ts`
  (`useOAuthRequest(id)`, `useOAuthDecision(id)`) — separate: no shared key, no shared invalidation.

## Data layer
Types from the generated client ONLY: `components['schemas']['OAuthRequestRead' | 'OAuthDecision' |
'OAuthDecisionResult' | 'OAuthAppList' | 'OAuthAppRead']`; `PatScope` imported from `data/tokens.ts`
(already re-exported), never redeclared.
- `qk.oauthRequest(id) => ['oauth-request', id]` — new root, `GET /oauth/requests/{id}`,
  `staleTime: Infinity`, invalidated by nothing: the row is single-use and its answer cannot change
  except into the 404 the decision itself produces.
- `qk.oauthApps() => ['oauth-apps','list']` — new root, `GET /oauth/apps`.
- `POST /oauth/requests/{id}/decision` invalidates NOTHING, and the two roots are disjoint for
  exactly that reason: per D3 the grant appears at CODE EXCHANGE, so at decision time there is no
  connected app to refresh (and the page navigates away). Write that sentence in `queryKeys.ts` —
  without it the missing invalidation reads as an omission. Its navigation runs in `onSuccess`.
- `DELETE /oauth/apps/{id}` → 204 unwrapped BY HAND (`throwOnError` treats `data: undefined` as
  failure — the `useRevokeToken` precedent copied, not re-invented). `onSuccess` → invalidate
  `['oauth-apps']`; `onError` status 404 → invalidate too (revoked in another tab/device).
- No optimistic updates: `revoked_at` is a server stamp and `redirect_to` is server-composed.

## UI states
**Consent page** — `queryPhase(requestQuery)`, all four arms:
- `loading` — card-shaped skeleton (heading bar, two meta lines, two button placeholders) at the
  loaded card's height, so the dialogue does not jump. `unreachable` — `<QueryStateNotice>` + Retry
  and NO Allow/Deny: a grant is never offered on data we could not read. `error` — 404
  `OAUTH_REQUEST_NOT_FOUND` gets its own copy ("this request has expired or was already answered —
  go back to Claude and start again"), everything else generic + Retry, via `describeOAuthError`.
- `ready` — `<h1>` "{app} is asking for access to your budget", `{app} = client_name ??
  t('consent.unknownApp')` ("An AI app" / «ИИ-приложение»), rendered as TEXT (React escapes; never
  `dangerouslySetInnerHTML`) under a muted "name declared by the app itself" line so a hostile name
  cannot borrow our authority. Then `redirect_host` verbatim; when `loopback`, `Badge tone="warning"`
  + "a program on this computer will receive the access"; a `<fieldset>/<legend>` radio group (the
  `TokenFormModal` scope-picker markup) with one explaining line per option and `read` DEFAULT —
  `useState<PatScope>('read')`, no rhf: one radio and two buttons is not a form and there is no zod
  schema to share. Allow (primary) / Deny (ghost), both disabled while pending, labels flip.
- `done` — only when the navigation does NOT happen (guard refusal, blocked replace): "access
  granted/refused — you can close this tab", plus the generic error line on a guard refusal. After a
  successful `replace` the user is already in Claude or on the loopback listener's page.
- Deny navigates too (`redirect_to` carries `error=access_denied`): same guard, same arms. a11y: one
  `<h1>`, labelled radios, `<button type="button">`, `role="alert"`; no modal, so no focus trap.

**Connected AI apps** — same four arms as the tokens block beside it: three `skeletonRow`s;
`<QueryStateNotice>` + Retry (`connectedApps.loadFailed`); an `<EmptyState>` whose body is the
how-to-connect steps, not "no data"; `ready` = `<ul>` keyed by `app.id` — `client_name ??
t('connectedApps.unknownApp')`, a mode `Badge` reusing `tokens.scopeRead`/`tokens.scopeFull` (so the
two sections cannot name one mode differently), `formatTimestamp(created_at, { locale })` and
last-used-or-never, Revoke → destructive `ConfirmDialog` naming the app → DELETE. Revoked rows stay
listed, dimmed, `Badge tone="danger"` "Revoked {date}", no button (TokenRow precedent); active first,
revoked after, derived during render (`useMemo`, SettingsPage's `ordered` pattern). Lede = one
sentence ("Claude and other AI apps connected through the Budget connector") plus "In Claude:
Settings → Connectors → Add custom connector → paste `{url}`", `url = window.location.origin +
'/mcp'` read during render, display-only, in a `<code>`.

## i18n
New `consent.*` / `connectedApps.*` keys in `dict.en.ts` (the key set) mirrored in `dict.ru.ts`
(mapped type — a missing key fails typecheck). No plurals. RU section title: «Подключённые
AI-приложения». `client_name`, `redirect_host` and the connector URL are DATA, never translated;
the mode labels reuse the shipped `tokens.scope*` keys. `describeOAuthError` copy lives in the WEB
dict (`describePushError`/`goalItemFileError` precedent) — `@budget/shared` `ERROR_MESSAGES` is NOT
touched: mobile is frozen with no OAuth consumer, so it would only gain two dead entries.

## Pure modules + tests
`features/oauth/redirectGuard.test.ts`, node-only vitest — ONE new file, 8 cases, each a different
accept shape or refusal reason.
```ts
export function isAllowedRedirect(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }   // no base => `//host`, `/path`, garbage
  if (url.protocol === 'https:') return url.origin === 'https://claude.ai'
    && url.pathname === '/api/mcp/auth_callback';       // `origin` carries any port => exact match
  if (url.protocol !== 'http:') return false;           // javascript:, data:, file:
  return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
}
```
Cases: claude.ai exact with `?code&state` ✓ · loopback bare ✓ · loopback with port+path ✓ ·
`127.0.0.1` ✓ · `claude.ai.evil.com` ✗ (origin, not suffix) · `https://claude.ai:8443/…` ✗ ·
`//claude.ai/…` ✗ · `javascript:alert(1)` ✗. No test for `client_name ?? fallback` (a bare `??`).

## Open questions (senior-lead)
1. A brand-new Claude user has no Budget account, and the login page's "create one" link DROPS
   `?next=` — after registering they land on /transactions and the `req` is lost (expires in 10 min).
   Recommend carrying `next` through the register link and `RegisterPage` (≈4 lines, two shipped
   files) IN this scope; otherwise it is a dead end in the primary onboarding path.
2. Connector URL: plain selectable `<code>` or the copy affordance from `TokenCreatedPanel`?
   Recommend plain `<code>` for v1 (no clipboard-failure arm to design), copy as a follow-up.
3. "Signed in as {email}" on the consent page (cached `useMe`), so someone with two accounts sees
   WHICH budget they are connecting? Recommend yes, muted line, no account switcher in v1.
4. `OAuthRequestRead.expires_at` would be rendered by nothing (no countdown — a timer lies after a
   sleeping tab, and the 404 arm is the real expiry UX). Recommend leaving it unread, not dropped:
   QA and a future "expires in N min" both want the field.

## Risks
- **StrictMode double-invoke**: the navigation MUST sit in `onSuccess`, never in an effect — a double
  effect would fire `location.replace` twice and could re-POST a single-use decision (said in a comment).
- **Service worker**: checked `apps/web/public/sw.js` — the fetch handler returns early unless
  `request.mode === 'navigate'`, then network-first with an offline fallback and no caching, so the
  consent page can never be served stale. No SW change; do not add one.
- **`pnpm typecheck` is blocked until backend B1 lands `openapi.json` + the regenerated `schema.d.ts`**
  — the five `components['schemas'][…]` reads do not exist yet. No hand-written server types, no `as`,
  no stand-in interface; if the gate must be green earlier, the regen sequences first.
- **Framing**: the anti-clickjacking headers are nginx's (`X-Frame-Options`, `frame-ancestors 'none'`
  on `location = /index.html`, D6) — web cannot enforce them; if that infra edit slips the dialogue
  ships frameable. Flag it, do not work around it.
- **Guard false negative**: a legitimately new Claude callback would be refused and the user would see
  the `done` arm — accepted, visible, safe, one constant to change. Deny-then-navigate also means our
  UI never confirms a refusal — accepted, Claude shows its own.

## Estimates (agent-minutes)
Write ~55 (consent page 25 · section + data layer 15 · guard + tests 5 · RU/EN i18n 10). Gates ~10
(`pnpm typecheck`, `pnpm lint`, `pnpm test`), plus a re-run after the contract regen — the first
point typecheck can pass. Verification ~5 (dev-stand render of both surfaces, every arm).
