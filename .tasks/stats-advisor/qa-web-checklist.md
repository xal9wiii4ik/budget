# QA Web Checklist: stats-advisor W1–W4

Scope: the four web subtasks of `stats-advisor` — W1 stats-core (`/stats` route,
period grammar, summary/comparison/breakdown), W2 stats-charts (monthly window,
top merchants, goals section), W3 advisor (`/advisor` route, SSE chat, no-key and
mid-stream failure arms), W4 CSV export button on `/transactions`.

Not covered here: API contracts (qa-engineer, `.tasks/stats-advisor/qa-checklist.md`),
pure-module behaviour (vitest, owned by frontend-engineer: `period.test.ts`,
`comparison.test.ts`, `history.test.ts`, `sse.test.ts`, `advisor.test.ts`,
`errors.test.ts`), mobile (FROZEN).

Environment: API `http://localhost:8010` (uvicorn, `FX_SCHEDULER_ENABLED=false`,
**no `ANTHROPIC_API_KEY`** except in the W3-S dummy-key arm), web vite dev server,
Postgres :5443. Throwaway user created through the register UI. GBP verified to
have **no** exchange rate in `exchange_rates` (0 rows with base/quote GBP), so a
GBP transaction is the unconverted probe.

Legend: ✅ pass · ❌ fail · 🚫 blocked

---

## Seed data (hand-computed baseline)

Throwaway user `qa-web-sa-1787000000@budgetqa.dev`, base currency **RUB** (default).
Categories: Еда, Транспорт, Rent, Old stuff (archived after use), Salary.
Transactions: 2026-08 → income 3000.00, expenses 12.50+40.00+25.00+900.00+7.00 =
**984.50**, plus a **GBP 50.00** expense (no rate → unconverted); 2026-07 → income
2000.00, expense 500.00; 2026-04 → expense 120.00; 2026-01 → income 1500.00.
Two goals in **USD** (deliberately ≠ base, to pin AM-5). Later in the run one more
2026-08 expense of 33.33 was added through the UI (X-1), taking August expense to
**1017.83**.

## W1 — stats-core

| id | scenario | expected | result |
|---|---|---|---|
| W1-1 | Nav "Stats" → `/stats` | route + `<h1>Stats</h1>` | ✅ nav link renders between Transactions and AI; page loads |
| W1-2 | Picker Quarter / Year / Custom | one anchor per unit on the wire | ✅ `period=quarter&quarter=2026-Q3`, `period=year&year=2026`, `period=custom&from=…&to=…`, `period=month&month=2026-08` — never a stray second anchor (S-1) |
| W1-3 | Reload / shared link on a non-default period | period restored | ✅ F5 on Q3 kept Q3; cold `GET /stats?period=quarter&quarter=2026-Q2` rendered Q2 |
| W1-4 | Prev/next stepper | steps period + URL | ✅ `aria-label` "Previous quarter"/"Next quarter" (unit-aware); Q3→Q2, Aug→Jul |
| W1-5 | No stepper for Custom | date inputs instead | ✅ stepper absent; labelled From/To `<input type=date>`; setting 2026-08-01…08-10 gave expense 977.50 (= 984.50 − the 11 Aug 7.00), matching by hand |
| W1-6 | `?period=year&month=2026-08` | fall back, no 422 | ✅ wire shows `period=month&month=2026-08`; no 422 anywhere in the log |
| W1-7 | `?period=bogus&quarter=zzz` | fall back | ✅ current month; zero console errors |
| W1-8 | Totals vs hand-computed | exact | ✅ 3 000,00 ₽ / 984,50 ₽ / 2 015,50 ₽ (GBP row excluded, as designed) |
| W1-9 | Server-echoed bounds | shown | ✅ "август 2026 г. · 1 авг. 2026 г. – 31 авг. 2026 г." |
| W1-10 | Comparison, normal previous | signed delta + percent | ✅ +1 000,00 ₽ (+50%), +484,50 ₽ (+97%), +515,50 ₽ (+34%) — all three match hand arithmetic |
| W1-11 | Previous zero / negative / incomplete | no percent, honest copy | ✅ Q3: income "+5 000,00 ₽ — nothing last period"; net "— last period was negative, so no percentage"; Custom 1-day: "Same as last period — both zero." No ∞/NaN/+100% anywhere |
| W1-12 | Category breakdown | server order + shares | ✅ Rent 900,00 (91%), Еда 52,50 (5%), Транспорт 25,00 (3%), Old stuff 7,00 (1%), Salary 3 000,00 (100%) — server `(kind, total DESC)` order preserved, shares = part/kind-total rounded |
| W1-13 | Archived styling | marked, not dropped | ✅ "Old stuff" italic + grey, same treatment as the shipped SummaryHeader |
| W1-14 | Empty period | copy + two actions | ✅ "No transactions in …" + "Add a transaction" link + "Back to this month" button |
| W1-15 | Unconverted banner | `role="status"` | ✅ `status` node "1 transaction has no exchange rate and is not included in these totals."; totals still render |
| W1-16 | Period-step loading | dim, no skeleton flash | ✅ no skeleton flash on any step (numbers replaced in place). The `dimmed`/`aria-busy` frame itself is sub-frame at localhost latency — not separately observable |
| W1-17 | Console / network hygiene | clean | ✅ zero uncaught console errors; exactly one GET per stats query per period; no render-loop storm |
| W1-18 | 375px | usable | ✅ cards stack full width, picker wraps, nothing overflows or is unreachable |
| W1-19 | Keyboard / a11y basics | reachable + labelled | ✅ visible focus rings; picker is real `<button>`s in a `role=group` with `aria-pressed`; stepper `aria-label`led; label has `aria-live="polite"`; date inputs have `<label for>` |

## W2 — stats-charts

| id | scenario | expected | result |
|---|---|---|---|
| W2-1 | Separate "Last N months" section | outside period card, own selector, scope note | ✅ own `region` + `role=group` "Months shown" + "A trailing window ending with the current month — it does not follow the period selected above." (R4.1 as ruled) |
| W2-2 | 12 → 24 selector | request + axis follow | ✅ `GET /stats/monthly?months=24`; heading "Last 24 months"; axis сент.25–авг.26 → окт.24–авг.26; footer "Amounts in RUB, over 24 months."; monthly is NOT refetched on a period change (correctly decoupled) |
| W2-3 | Zero months | zero bars, axes stay | ✅ empty months render flat with axes intact; `domain={['auto','auto']}` visibly honoured — the April net −120,00 dips below the baseline (axis reaches −1 000,00) |
| W2-4 | Partial last bar | labelled | ✅ "The last bar (авг. 26 г.) is this month so far — it covers a part-month and will keep growing." |
| W2-5 | Per-point unconverted in tooltip | own count | ✅ авг. 26 г. tooltip: "— this month so far" + "1 transaction with no exchange rate is left out of this month." |
| W2-6 | Flagged-months note | `role="status"` | ✅ `status` node naming "авг. 26 г." only — per-point, never collapsed |
| W2-7 | Top merchants | heading, order, expense-only | ✅ "Top merchants (spending)"; Landlord 900,00 (1) → Пятёрочка 52,50 (2) → Uber 25,00 (1) → Flea market 7,00 (1), total DESC verbatim; income merchant **ACME Corp absent**; own unconverted banner present |
| W2-8 | Goals section | reuses goals query | ✅ `GET /goals?include_archived=false` only — no new endpoint; "1 200,00 $ of 5 000,00 $" decoded with **goal.currency (USD)**, not base RUB (AM-5); "Open goals" → `/goals`; progressbars labelled |
| W2-9 | Section isolation on error | one section erroring never blanks the others | 🚫 **not exercisable** — `parsePeriodParams` is total by design, so no URL can force a 4xx; killing the API does not produce an error state either (see Deviation D1) |

## W3 — advisor, no-key server

| id | scenario | expected | result |
|---|---|---|---|
| W3-1 | "Спросить AI" on `/stats` | unconditional, → `/advisor` | ✅ link always rendered (no capability probe in the tree); navigates; separate "AI" nav link also present (R8) |
| W3-2 | Panel fully Russian | every string | ✅ "AI-советник", "К статистике", "Спросите про свои траты", 3 example buttons, "Вопрос", counter, "Спросить" — no English leak |
| W3-3 | 503 copy | byte-exact | ✅ `role="alert"` = `AI недоступен — ключ не настроен`; codepoint compare passed (U+2014 em dash), matches `errors.ts:288` / `errors.test.ts:206` (S-9) |
| W3-4 | Composer after 503 | stays enabled | ✅ textarea + "Спросить" enabled, counter reset to 0/2000, button never hidden (S-10) |
| W3-5 | Empty question | client-side refusal | ✅ "Введите вопрос."; **no** POST to `/advisor/ask` in the network log |
| W3-6 | Char counter | live | ✅ 0/2000 → 37/2000 on fill |
| W3-7 | Cmd/Ctrl+Enter | sends | ✅ Meta+Enter submits from the textarea |
| W3-8 | Deep link + hard reload `/advisor` | restores | ✅ direct load renders the panel; transcript resets, which is the documented client-carried design ("История разговора хранится только на этой странице") |
| W3-9 | 375px | usable | ✅ composer, examples and button all reachable, no overflow |
| W3-10 | Console / network hygiene | clean | ✅ one POST per ask; no uncaught JS errors (only the browser's own network log line for the 503 status) |

## W3-S — advisor, streaming path (dummy-key server)

| id | scenario | expected | result |
|---|---|---|---|
| W3-S1 | Ask with a dummy key | human Russian mid-stream copy | ✅ "Ответ оборвался на стороне AI. Попробуйте спросить ещё раз." — no raw `ANTHROPIC_ERROR` on screen. Server log: `advisor stream failed: AuthenticationError(401 invalid x-api-key)` → `advisor stream ended with ANTHROPIC_ERROR` (zero tokens billed) |
| W3-S2 | Transcript state | failed turn kept | ✅ user turn kept, assistant turn carries a `role="alert"` notice; no partial text existed (failure preceded the first delta), nothing was discarded |
| W3-S3 | Retry | works | ✅ second question sent and failed the same way; both turns visible; no crash, no uncaught console error |
| W3-S4 | *(bonus)* expired access token over the streaming POST | silent refresh + replay | ✅ log shows `POST /advisor/ask → 401` then a replayed `POST → 200` — the coordinator seam + AM-7 body-preserving clone work on a streaming POST (S-11, and the plan's recorded risk) |

## W4 — CSV export

| id | scenario | expected | result |
|---|---|---|---|
| W4-1 | Button present | in the toolbar | ✅ next to "Add transaction" / "Add by photo" |
| W4-2 | Download completes | file saved | ✅ blob received and read by the app (the confirmation is emitted after `downloadBlob` + a successful blob peek). The pane's OS save location is not inspectable from here — the byte-level check is W4-8 |
| W4-3 | Filename | month-derived | ✅ `transactions-2026-08.csv`, and `transactions-2026-06.csv` for June |
| W4-4 | Confirmation | `role="status"` | ✅ "Downloaded transactions-2026-08.csv." |
| W4-5 | Empty result | header-only wording | ✅ "Downloaded transactions-2026-06.csv — no transactions matched, so it has headers only." |
| W4-6 | Auth discipline | header, no token in URL | ✅ `GET /transactions/export?from=2026-08-01&to=2026-08-31` — filters only, **no token, no `limit`/`offset`** (S-15/S-16); 200 proves the bearer travelled in the header |
| W4-7 | Pending "Exporting…" | disabled button | 🚫 **not observable** — the round trip is sub-frame against a local API; no way to throttle from this pane |
| W4-8 | File bytes (S-17) | BOM + Cyrillic + major units | ✅ first bytes `EF BB BF`; `…,Еда,Пятёрочка,` and `…,Транспорт,Uber,` intact; amounts `12.50` / `900.00` as major-unit strings; `content-type: text/csv; charset=utf-8` |

## Cross-cutting

| id | scenario | expected | result |
|---|---|---|---|
| X-1 | `['stats']` invalidation | no manual reload | ✅ added a 33.33 expense on `/transactions` while `/stats?month=2026-08` was cached at 984,50 → `/stats` immediately showed **1 017,83 ₽**, comparison recomputed to +517,83 ₽ (+104%), Еда bucket 85,83 ₽ (S-4) |
| X-2 | Console hygiene, whole run | no uncaught errors | ✅ only browser network-log lines (503 / 401 / ERR_CONNECTION_REFUSED from the deliberate outage test). No React errors, no uncaught exceptions, no request storms |

---

## Deviations & observations (not test failures)

- **D1 — error state unreachable under a total API outage (app-wide, pre-existing).**
  With uvicorn killed, `/stats` sits on skeletons indefinitely: no `role="alert"`,
  no Retry, in any of the four sections, even after ~45 s. The queries never leave
  `pending`. **Reproduced on the shipped `/goals` screen**, which predates this
  scope — so this is the auth/query layer's behaviour on a network-level failure,
  **not a W1–W4 regression**. Consequence for QA: the per-section `error` rows of
  the W1/W2 UI-states tables could not be exercised live (W2-9 🚫).
- **D2 — custom period header prints the range twice**: `1 апр. 2026 г. – 1 апр.
  2026 г. · 1 апр. 2026 г. – 1 апр. 2026 г.` — `periodLabel('custom')` already
  renders the range that the server-echoed bounds then repeat. Cosmetic.
- **D3 — empty-state copy is wrong in the custom arm**: "the stepper is right
  above" is shown while in Custom mode, where there is no stepper (by design).
- **D4 — double sentence terminator** in Russian-locale labels: "No transactions in
  июнь 2026 г.." (label already ends in "г."). Also present on the shipped
  transactions empty state → pre-existing pattern, not new.
- **D5 — a sub-1 % category renders "0 %"** (Old stuff, 700/148 450 in Q3). Correct
  under the WS-4.4 honest-share policy (shares deliberately need not total 100 %);
  noted only so it is not "discovered" later.
- **D6 — `from > to` reaches the wire.** A mid-edit custom range
  (`from=2026-08-01&to=2026-04-01`) was sent and answered 200/empty. Deliberate and
  documented in `period.ts` ("read filters never error"); recorded, not a defect.

## Final verdict

- **Total:** 52 checks — W1 19, W2 9, W3 10, W3-S 4, W4 8, cross-cutting 2
- **Passed:** 50 ✅ · **Failed:** 0 ❌ · **Blocked:** 2 🚫 (W2-9 section isolation,
  W4-7 pending state — both blocked by environment limits, not by defects; see D1)
- **STOP line:** none. No check failed; nothing in W1–W4 blocks the scope.
- **Cleanup:** both servers stopped (8010 + vite 5173); no `.env.local` was
  created (`apps/web/.env` already pointed at 8010 and was left untouched); the
  throwaway user and all its rows deleted by cascade; no exchange rate added or
  altered (GBP intentionally left rate-less); the only working-tree change from
  this run is this file.

✅ **READY FOR REVIEW** — with D1 raised to senior-lead as an app-wide (pre-existing)
observation, and D2/D3 as one-line copy nits inside this scope's own new code.

