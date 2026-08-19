# Architecture Plan: mcp-server (PLAN 5.6)

## Context
AI-клиенты (stdio MCP) читают и пишут бюджет через наш же API от лица пользователя.
Нужны: PAT-auth рядом с JWT без эскалации, scope-модель, динамическая генерация
инструментов из закоммиченного `openapi.json`, guardrails на write (деньги).

## 1. Таблица `personal_access_tokens` (миграция 0007)

- `id` (Uuid, PK, default uuid4) — стабильный идентификатор для списка/отзыва/rate-key.
- `user_id` (Uuid, FK users.id ON DELETE CASCADE, index).
- `name` (String(100)) — метка, задаёт пользователь («MacBook Claude Desktop»).
- `token_hash` (String(64), UNIQUE index) — hex SHA-256 от полной строки токена.
- `scope` (String(10), CheckConstraint `scope IN ('read','read_write')`).
- `created_at` (DateTime(timezone=True), server_default=now()).
- `last_used_at` (DateTime(timezone=True), nullable).
- `revoked_at` (DateTime(timezone=True), nullable) — soft-revoke, строка остаётся в списке.

Стиль: plain `Mapped[...]` без TYPE_CHECKING-сплита (как `category_limit.py`).

**Формат токена**: `bgt_pat_` + `secrets.token_urlsafe(32)` (~51 символ итого).
**Хранение — только SHA-256** (не argon2): токен — 256 бит случайности, брутфорс
нерелевантен, KDF не нужен; SHA-256 даёт O(1) lookup по уникальному индексу без
per-request стоимости хеширования (argon2 на каждый MCP-вызов — самострел).
**PAT vs JWT в Authorization**: сниффинг префикса — `Bearer bgt_pat_...` → PAT-ветка;
иначе (JWT всегда начинается с `eyJ`) → штатный fastapi-users JWT-путь.

## 2. PAT-auth на бэкенде

Новый модуль `apps/api/src/budget_api/pat_auth.py` (сосед `auth.py`, framework glue).
Одна dependency `current_user_jwt_or_pat`:
- префикс `bgt_pat_` → hash-lookup (not revoked, user active) → scope/метод-гейт →
  стэш `request.state.pat` (id, scope — для rate-key и аудита) → вернуть User;
- иначе → делегат в существующий `current_active_user` (JWT).

**Кто переезжает на неё**: только data-роутеры allowlist-поверхности — categories,
transactions, fx, goals, recurring, limits, stats. **JWT-only остаются**: `/auth/*`,
`/users/*` (стоковый fastapi-users-роутер и так использует свой authenticator —
PAT туда структурно не попадает), `/tokens/*`, `/receipts/*`, `/advisor/*`.
Анти-эскалация `/tokens/*`: роутер импортирует `current_active_user` из `auth.py`,
PAT-ветки там нет вообще — токеном нельзя выпустить/отозвать токен.

**Ошибки** (SCREAMING_SNAKE, стиль проекта): невалидный/отозванный PAT → 401
`TOKEN_INVALID` (один код и один код-путь для «не существует» и «отозван» — no-oracle).

**last_used_at**: дебаунс-UPDATE в PAT-ветке — одна строка SQL
`UPDATE ... SET last_used_at=now() WHERE id=:id AND (last_used_at IS NULL OR
last_used_at < now() - interval '60 seconds')`. Минутная гранулярность честна для
UI «последнее использование», нет записи на каждый запрос, нет фоновых батчей.

## 3. Scope-enforcement

> **ПОПРАВКА senior-lead (принята, авторитетна — детали в plan.md):** вместо
> денайлиста — FAIL-CLOSED allowlist пар (метод, путь) = таблица §4; всё вне
> списка, включая любой DELETE и `/transactions/export`, → 403
> `TOKEN_ENDPOINT_FORBIDDEN`; код `TOKEN_METHOD_FORBIDDEN` отменён.

Гейт — внутри PAT-ветки dependency, до хендлера:
- пара (метод, `route.path_format`) не в allowlist → 403 `TOKEN_ENDPOINT_FORBIDDEN`;
- GET/HEAD — любой scope; POST/PATCH/PUT — требуют `read_write`, иначе 403
  `TOKEN_SCOPE_READONLY`; DELETE-пар в allowlist нет как класса.
JWT-запросы гейт не трогает. MCP-пакет дополнительно фильтрует инструменты по
scope — но это UX, не безопасность; сервер — единственный enforcement.

## 4. ПОЛНАЯ ТАБЛИЦА ИНСТРУМЕНТОВ (утверждает пользователь)

| tool | метод+эндпоинт | scope | зачем AI-клиенту |
|---|---|---|---|
| list_transactions | GET /transactions | read | поиск/фильтр операций (период, категория, limit≤100) |
| get_transactions_summary | GET /transactions/summary | read | агрегат по категориям за период — считает сервер |
| list_categories | GET /categories | read | id категорий для create/patch, структура бюджета |
| list_goals | GET /goals | read | обзор целей накопления |
| get_goal | GET /goals/{goal_id} | read | детали одной цели |
| get_goal_progress | GET /goals/{goal_id}/progress | read | серия прогресса — серверная математика |
| list_goal_contributions | GET /goals/{goal_id}/contributions | read | история взносов |
| list_limits | GET /limits | read | лимиты месяца + spent (серверный расчёт) |
| list_recurring | GET /recurring | read | регулярные платежи |
| get_stats_summary | GET /stats/summary | read | итоги периода + базовая валюта (`currency`) |
| get_stats_monthly | GET /stats/monthly | read | помесячный тренд |
| get_top_merchants | GET /stats/top-merchants | read | топ мерчантов |
| convert_currency | GET /fx/convert | read | конвертация СЕРВЕРОМ — модель не считает деньги |
| create_transaction | POST /transactions | write | внесение операции по просьбе пользователя |
| update_transaction | PATCH /transactions/{transaction_id} | write | исправление (вместо DELETE+create) |
| create_category | POST /categories | write | новая пользовательская категория |
| update_category | PATCH /categories/{category_id} | write | переименование/архив (системные — сервер отдаст SYSTEM_CATEGORY_READONLY) |
| create_recurring | POST /recurring | write | новый регулярный платёж |
| update_recurring | PATCH /recurring/{template_id} | write | правка шаблона |
| set_category_limit | PUT /limits/{category_id} | write | установка/обновление лимита (upsert) |
| create_goal | POST /goals | write | новая цель |
| update_goal | PATCH /goals/{goal_id} | write | правка цели |
| add_goal_contribution | POST /goals/{goal_id}/contributions | write | взнос в цель |

**[ОТКЛОНЕНИЕ] users/me GET исключён** (в task.md был в READ). Две независимые
причины: (1) `UserRead` = {id, email, is_active} — базовой валюты там НЕТ; (2) это
стоковый fastapi-users-роутер со своим JWT-only authenticator — PAT туда не встроить
без второго FastAPIUsers-инстанса или кастомного дубля роута. Базовая валюта уже
приходит в `get_stats_summary.currency` (и в goals-ответах `base_currency`) — этого
достаточно для контекста. Email отдавать AI незачем.

**«Никогда»-список**: `/auth/*` (сессии/пароли), `/tokens/*` (эскалация: токен
плодит токены), `/users/me PATCH` (смена email/пароля = захват аккаунта),
`/users/{id}/*` (superuser-мёртвые), `/receipts/*` (бинарный presigned-flow,
бессмысленен через stdio), `/advisor/*` (вложенный AI + SSE), `/transactions/export`
(стриминговый CSV, объём), **все DELETE** (разрушительно; update покрывает
исправления), `/health` (шум, не инструмент).

## 5. packages/mcp-server

`@budget/mcp-server`, private, type: module — по образцу api-client/shared.
Deps: `@modelcontextprotocol/sdk`; dev: typescript, vitest, @types/node. `bin`:
`budget-mcp` (tsx или прекомпил dist — решает frontend в plan-mcp.md).

```
src/index.ts     — stdio entry: load openapi → build tools → serve
src/openapi.ts   — загрузка+parse openapi.json, разрешение $ref в компонентах
src/allowlist.ts — курируемая таблица §4: {name, method, path, scope, description,
                   переопределения описаний параметров}
src/tools.ts     — генератор: JSON Schema инструмента из parameters/requestBody
src/http.ts      — fetch-клиент: BUDGET_API_URL (default http://localhost:8010),
                   PAT из env BUDGET_PAT, маппинг detail-кодов в текст ошибки
src/truncate.ts  — усечение ответа
```

**openapi.json — читается в РАНТАЙМЕ при старте сервера** из закоммиченного
`apps/api/openapi.json` (путь резолвится от корня пакета `../../apps/api/openapi.json`,
override `BUDGET_OPENAPI_PATH`). Обоснование: build-time codegen создал бы ВТОРОЙ
генерируемый артефакт, который надо держать в паре (уже есть болезненная пара
openapi.json↔schema.d.ts с drift-тестом); рантайм-чтение = ноль новых артефактов,
`pnpm openapi` автоматически подхватывается следующим стартом MCP. Фаза 1 —
локальный запуск из монорепы, файл всегда рядом. Валидация при старте: каждый
allowlist-путь обязан существовать в json, иначе fail-fast с понятной ошибкой.

**Усечение**: сериализованный JSON > 50_000 байт → массивы режутся с хвоста,
в ответ добавляется `_truncated: {shown, note: "response truncated, narrow the
query (dates/category/limit)"}` — честная пометка, модель уточняет запрос.
Плюс жёсткий `limit ≤ 100` в описаниях списочных инструментов.

## 6. Guardrails для write

- **Rate limit per PAT** — в PAT-ветке dependency, напрямую через storage
  slowapi-лимитера (moving window из библиотеки `limits`), НЕ декораторами по ~20
  роутам (декоратор зацепил бы и JWT-трафик и размазал конфиг). Ключи:
  `{rate_limit_scope}:pat-read:{token_id}` 60/min и `pat-write:{token_id}` 20/min
  (значения — settings, как остальные лимиты). Превышение → 429 `RATE_LIMITED`
  (штатный envelope).
- **Batch запрещён**: в API батч-эндпоинтов нет, MCP батч-инструментов не
  определяет; каждый write — одна сущность (инвариант структуры allowlist).
- **Идемпотентность v1**: серверного `client_id` нет (5.5 не стартовал) — v1 БЕЗ
  серверной дедупликации. Митигция: write-rate-limit; курируемые описания
  обязывают «сначала list — проверь, что записи ещё нет; исправляй через update,
  а не повторным create»; результат create эхом возвращает id — ретрай виден
  модели. Настоящее решение (Idempotency-Key / client_id) уезжает в 5.5 и ляжет
  на его дедуп-механику, не изобретаем одноразовый суррогат сейчас.
- **Аудит — log-only** (structured line на каждый PAT-write: token_id, user_id,
  method, path, status, id сущности; logger `pat_audit`). Обоснование: инсталляция
  локальная и однопользовательская, у аудит-таблицы не было бы ни читателя, ни UI,
  ни retention-политики — миграция ради мёртвых строк; сами денежные изменения и
  так инспектируемы (транзакции хранят created/updated). Точка апгрейда до таблицы —
  HTTP-фаза 2 / multi-user.

## 7. Динамическая генерация не ломает инварианты

- **Минорные единицы**: MCP не считает деньги — суммы идут сквозняком в pydantic,
  описания требуют `amount_minor` + `currency`, арифметика запрещена текстом tool'а.
- **Снапшот курса**: create/patch транзакций проходят штатный write-путь — снапшот
  ставит сервер; override пользователя побеждает, MCP ничего не пересчитывает.
- **user_id-скоупинг**: PAT-ветка возвращает того же `User` — все выборки скоупятся
  штатно через PAT.user_id, отдельного кода нет.
- **No-oracle**: чужой id даёт тот же байт-идентичный 404 — MCP лишь транслирует
  detail-код; плюс `TOKEN_INVALID` сам одноканальный (missing == revoked).

## 8. Подзадачи S1–S5 и зависимости

- **S1 PAT-бэкенд** (FULL): миграция 0007, `pat_auth.py`, `/tokens` router
  (POST/GET/DELETE-revoke, JWT-only), scope/метод-гейт, rate limit, contract regen
  (+ CORS-verbs проверка — новых верба нет, но тест это ловит). Блокирует всё.
- **S2 Веб-«Настройки»** (STANDARD): нужен контракт из S1.
- **S3 mcp-server read + stdio** (STANDARD): нужен S1 (живой PAT); генератор и
  truncate строятся по закоммиченному openapi.json параллельно с S2.
- **S4 write-инструменты + guardrails-описания** (предлагаю STANDARD: серверная
  безопасность вся в S1/FULL; S4 — TS-слой поверх): после S3.
- **S5 док-страница конфига Claude Desktop/Code** (FAST): после S3, параллельно S4.

Параллелится: S2 ∥ S3 (после S1); S5 ∥ S4 (после S3).

## 9. Открытые вопросы для пользователя

1. **Исключение `users/me GET` из allowlist** (§4, [ОТКЛОНЕНИЕ]). Рекомендация:
   исключить — валюта есть в stats/summary, PAT в стоковый роутер не встраивается
   без дублирования.
2. **Срок жизни PAT**: в зафиксированной схеме нет `expires_at`. Рекомендация:
   v1 без экспирации (ручной revoke в UI, last_used_at виден) — локальный
   однопользовательский сценарий; добавить TTL при переходе к HTTP-фазе 2.
3. **Аудит log-only vs таблица** (§6). Рекомендация: log-only, апгрейд в фазе 2.

## Что НЕ решает этот документ
Тексты курируемых описаний инструментов; форма /tokens-схем и UI-детали S2;
tsx-vs-dist запуск бинаря; точный порог/алгоритм усечения массивов (50KB — стартовое
значение, правится в plan-mcp.md без пересмотра архитектуры).
