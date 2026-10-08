# Grooming review: mcp-remote (2026-10-08)

Скоуп: удалённый MCP-коннектор для Claude (PLAN.md 5.6b) — Streamable HTTP `/mcp` + свой OAuth 2.1
AS (DCR, PKCE S256, ротация refresh) + страница согласия и раздел «Подключённые AI-приложения».
Команда грумминга: architect (5 таблиц + ALTER, новый пакет `oauth/`, Starlette-маршруты вне
контракта, nginx/compose), backend-engineer, frontend-engineer, qa-engineer (FULL → стоп-пробы).
Исключены: mobile-engineer / mobile-qa (мобилка заморожена, не трогается; только гейт регенерации
контракта — её тесты прогоняются при смене `schema.d.ts`); web-qa на грумминге (чеклист пишет и
гонит одним прогоном после W1+B1 на стенде vite 5199 + API 8021). Решения владельца не
пересматривались: домен sslip.io, регистрация открыта.

## Подзадачи

| ID | Состав | Тир | Оценка (а-мин: письмо/гейты/верификация) | Зависимости |
|---|---|---|---|---|
| B1 | 0016 + 5 моделей + `oauth/{urls,clients,tokens,provider,client_auth,consent,routes}` + `routers/oauth.py` + `pat_auth` второй префикс + `routers/tokens.py` фильтры + config/app + pyproject/uv.lock + контракт + ≈17 тестов | FULL | 150 / 40 / 25 (+1 круг на стоп-пробах) | нет |
| W1 | `RequireAuth` (вынос из ProtectedLayout) + `/oauth/consent` + `redirectGuard` + `ConnectedAppsSection`/`ConnectedAppRow` + `data/oauthApps.ts`,`oauthRequest.ts` + i18n RU/EN + `?next=` через регистрацию + 1 тест-файл | FULL (consent — security UI) | 55 / 10 / 15 | typecheck только после regen B1; пишется параллельно |
| B2 | `mcp/server.py` (per-request credential) + `mcp/remote.py` + `Route("/mcp")` + lifespan + nginx.conf + compose.prod + env.example + ≈6 тестов | FULL (внешняя интеграция) | 90 / 30 / 25 | B1 |

Порядок: B1 ∥ W1 → гейт senior-lead (оба диффа) → B2 → гейт → qa-engineer (prod-like стенд 8443,
P1–P14) ∥ web-qa (vite 5199 + API 8021) → code-reviewer (B1+B2+W1 одним проходом) → мета-ревью только
при находках → docs/.

## Решения senior-lead (поверх architecture.md; имеют силу над текстом архитектуры)

- **R1 — публичные клиенты + секреты.** DCR принимает `token_endpoint_auth_method` ∈ {none,
  client_secret_post, client_secret_basic}; отсутствующее значение = SDK-дефолт `client_secret_post`.
  Секрет хранится ТОЛЬКО как SHA-256 (`oauth_clients.client_secret_hash`), сравнение — наш
  `oauth/client_auth.py` (замена SDK `ClientAuthenticator`, подкласс невозможен). Причина: что именно
  шлёт DCR claude.ai, локально не проверить; отказ стоил бы владельцу полного круга.
- **R2 — `state` ≤ 2 KB** (архитектура исправлена с 512). Длиннее → `invalid_request`.
- **R3 — хотя бы один pytest строит приложение с `public_base_url="http://testserver"`**: обход
  `exposure.walk` не падает, PRM×2 и AS-метаданные отдают ожидаемые байты.
- **R4 — `mcp` → `dependencies`, extra `mcp = []` как no-op алиас** (uv принимает — проверено),
  dev-группа без self-reference, `uv lock` регенерируется и коммитится, Dockerfile не трогаем.
- **R5 — формулировка `TOKEN_SCOPE_READONLY`** в `mcp/http.py` одна на оба транспорта («…issue a full
  token, or reconnect the AI app choosing full access»); пин в `test_mcp_server.py` правится осознанно.
- **R6 — стенды.** Честный OAuth-поток — только prod-like compose (`https://localhost:8443`,
  `PUBLIC_BASE_URL=https://localhost:8443`): префикс `/api/` существует лишь за nginx. Веб-стенд:
  vite 5199 + API 8021 + `PUBLIC_BASE_URL=http://localhost:5199`. Валидатор разрешает `http://` только
  для localhost/127.0.0.1.
- **R7 — порядок регистрации.** Starlette-маршруты OAuth/MCP добавляются ДО строки
  `app.state.pat_allowlist = pat_allowlist(app)` (как в архитектуре, не как в plan.md): сторож
  `TypeError` на незнакомый контейнер тогда срабатывает на старте прода, а не только в тесте.
  Проверено на fastapi 0.139.2: `_IncludedRouter` матчит по маршрутам, а не по префиксу — маршрут
  `/oauth/authorize` работает и до, и после `include_router(prefix="/oauth")`.
- **R8 — отказанная DCR-регистрация СЧИТАЕТСЯ в per-IP бакете** (лимитер стоит до валидации, D7);
  P9 QA утверждает конверт 429, а не номер попытки. Лимиты authorize/token 60/min per-IP — в B1,
  не откладываются.
- Открытые вопросы плана бэкенда: 1 (одна фраза) — да; 2 (замена аутентификатора) — да; 3 (`PublicUrls`
  один раз, `app.state.public_urls`) — да; 4 (`client_id` в `/oauth/apps` не отдаём) — да; 5 (prefix
  `location /.well-known/oauth-`) — да.
- Открытые вопросы плана веба: 1 (`?next=` сквозь ссылку «создать аккаунт» и RegisterPage) — ДА, в
  W1: это основной путь онбординга из Claude; 2 (plain `<code>`) — да; 3 («Вы вошли как {email}»,
  без переключателя) — да; 4 (`expires_at` остаётся в контракте, не рендерится) — да.
- QA: Section A чеклиста (~86 случаев) — карта покрытия по темам, НЕ мандат на число тестов;
  число и темы тестов задаёт plan.md (≈17 + ≈6) по правилу CLAUDE.md. R-A…R-E чеклиста закрыты: R-A
  (compose passthrough) — в B2; R-B (`python -m budget_api.mcp` внутри образа) — следствие R4; R-C —
  контракт `OAuthRequestRead`; R-D = R8; R-E = R2.
- Исправлено на грумминге: `docs/mcp.md` врёт про «md5-пин openapi.json» (`openapi_md5` в снимке —
  provenance, тестом не читается) — чинит B1 в том же проходе.

## Что уходит оркестратору (env/compose)
Прод `.env`: ничего — `docker-compose.prod.yml` выводит `PUBLIC_BASE_URL` из `SITE_DOMAIN`.
Dev `docker-compose.yml`/`.env`: ничего (без `PUBLIC_BASE_URL` удалённый MCP выключен). Для локальной
разработки по желанию: `apps/api/.env` → `PUBLIC_BASE_URL=http://localhost:5173` (смысл только со
стендом, где `/api/`, `/mcp` и `/.well-known/oauth-*` проксируются на API).

## Артефакты
architecture.md, plan.md, plan-web.md, qa-checklist.md (P1–P14, стенд `budget-prod-qa` 8480/8443).
