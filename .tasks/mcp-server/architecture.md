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
- `scope` (String(32), CheckConstraint `scope IN ('read','full')`) — строковый enum,
  НЕ булев флаг: пользователь решил «потом разграничим» по областям — будущие
  гранулярные скоупы (напр. `transactions:write`) добавляются расширением CHECK
  без смены типа колонки и без переделки схемы.
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
> списка, включая `/transactions/export`, → 403 `TOKEN_ENDPOINT_FORBIDDEN`;
> код `TOKEN_METHOD_FORBIDDEN` отменён. ЕДИНСТВЕННАЯ DELETE-пара —
> `/transactions/{transaction_id}` (решение пользователя 2026-08-19), требует `full`.

Гейт — внутри PAT-ветки dependency, до хендлера:
- пара (метод, `route.path_format`) не в allowlist → 403 `TOKEN_ENDPOINT_FORBIDDEN`;
- GET/HEAD — любой scope; POST/PATCH/PUT/DELETE — требуют `full`, иначе 403
  `TOKEN_SCOPE_READONLY`; DELETE-пара в allowlist одна — `delete_transaction`.
JWT-запросы гейт не трогает. MCP-пакет при старте узнаёт scope своего токена через
`GET /tokens/self` (см. §4-исключение) и не публикует write-инструменты read-токену —
это UX (модель не зовёт заведомо запрещённое), не безопасность; сервер — единственный
enforcement.

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
| list_upcoming_recurring | GET /recurring/upcoming | read | что СПИСАЛОСЬ БЫ в ближайшие `days` дней — ещё не проведённые списания (проведённые уже в list_transactions) |
| get_profile | GET /profile | read | базовая валюта = единица всех серверных агрегатов, плюс заявленный доход/страна/язык как контекст ответа |
| get_stats_summary | GET /stats/summary | read | итоги периода + базовая валюта (`currency`) |
| get_stats_monthly | GET /stats/monthly | read | помесячный тренд |
| get_top_merchants | GET /stats/top-merchants | read | топ мерчантов |
| convert_currency | GET /fx/convert | read | конвертация СЕРВЕРОМ — модель не считает деньги |
| create_transaction | POST /transactions | write | внесение операции по просьбе пользователя |
| update_transaction | PATCH /transactions/{transaction_id} | write | исправление ошибок — предпочтительнее удаления |
| delete_transaction | DELETE /transactions/{transaction_id} | write (только `full`; в `read` НЕ публикуется) | удаление одной операции по ЯВНОЙ просьбе пользователя; единственный необратимый инструмент — guardrail-описание в plan-mcp.md |
| create_category | POST /categories | write | новая пользовательская категория |
| update_category | PATCH /categories/{category_id} | write | переименование/АРХИВ — архивирование и есть «удаление» категории в этом продукте (история транзакций сохраняется; системные — SYSTEM_CATEGORY_READONLY) |
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
плодит токены) — с ЕДИНСТВЕННЫМ исключением `GET /tokens/self` (PAT-доступный
self-introspection: возвращает ТОЛЬКО `{id, scope}` самого токена — ни списка, ни
plaintext, ни создания/отзыва; токен узнаёт лишь собственные права, которые и так
выяснил бы пробным вызовом — эскалации нет по построению; нужен MCP-серверу, чтобы
не публиковать write-инструменты read-токену). В таблицу инструментов НЕ входит —
модель его не зовёт, пакет использует при старте.
Дальше без исключений: `/users/me PATCH` (смена email/пароля = захват аккаунта),
`/users/{id}/*` (superuser-мёртвые), `/receipts/*` (бинарный presigned-flow,
бессмысленен через stdio), `/advisor/*` (вложенный AI + SSE), `/transactions/export`
(стриминговый CSV, объём), **все DELETE, КРОМЕ `delete_transaction`** (решение
пользователя 2026-08-19; остальные DELETE — goals/contributions/recurring/limits —
по-прежнему запрещены). Отдельного `delete_category` НЕТ и не будет: удаления
категорий не существует и в API — категории архивируются через `update_category`,
потому что на них ссылаются прошлые транзакции; это ответ на просьбу пользователя,
не пропуск. `PATCH /profile` — смена базовой валюты через AI-реплику запрещена,
потому что операция каскадная: сбрасывает заявленный доход и меняет смысл всех
агрегатов (прошлые суммы начинают читаться в другой валюте), а откатить её одной
репликой нельзя — решение пользователя 2026-08-23. Поэтому роутер `profile.py`
расщеплён по методу: GET идёт через `current_user_jwt_or_pat` + пара в allowlist,
PATCH остаётся JWT-only и отвечает PAT-токену 401 на декоде. `/health` (шум, не
инструмент).

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
- **Порядок гейтов в PAT-ветке** (амендмент MAJOR-1 к review-s1.md, утверждён
  пользователем 2026-08-19): hash-lookup → 401 `TOKEN_INVALID` → **стэш
  `request.state.pat`** → rate limit (429) → allowlist (403
  `TOKEN_ENDPOINT_FORBIDDEN`) → scope (403 `TOKEN_SCOPE_READONLY`) → дебаунс
  `last_used_at`. Стэш стоит сразу после аутентификации, поэтому в аудит попадают
  и ОТКЛОНЁННЫЕ вызовы аутентифицированного токена (403/429), а не только
  успешные: неудачные попытки авторизации — ровно то, что аудит обязан фиксировать
  в первую очередь, а схема, пишущая только успехи, ведёт журнал всего, кроме
  подозрительного. Rate limit поднят ПЕРЕД allowlist и scope намеренно: он
  ограничивает объём аудит-строк от отказов тем же бюджетом, что и от обычных
  вызовов.
- **Batch запрещён**: в API батч-эндпоинтов нет, MCP батч-инструментов не
  определяет; каждый write — одна сущность (инвариант структуры allowlist).
- **Идемпотентность — B-1 втянут в S1** (решение пользователя 2026-08-19):
  опциональный `client_id` (UUID) на `POST /transactions` — select-first по
  (user_id, client_id), частичный уникальный индекс, IntegrityError-recovery,
  повтор возвращает СОХРАНЁННУЮ строку с 200 без записи. Дизайн ГОТОВ и binding:
  `.tasks/mobile-offline/plan.md` (B-1) + architecture Decision 3 там же — сюда не
  переписывается, S1 исполняет его as-is. В `.tasks/mobile-offline/` поставлена
  пометка, что B-1 уехал сюда (5.5 не делает его повторно). MCP-пакет генерирует
  `client_id` на каждый ЛОГИЧЕСКИЙ вызов create_transaction — ретрай транспорта
  не создаёт вторую операцию. Описания «сначала list, исправляй через update»
  остаются как защита от дублей на уровне модели (client_id ловит только ретрай).
- **Аудит — таблица `pat_audit_log`** (решение пользователя, переопределяет прежнюю
  log-only рекомендацию; та же миграция 0007). Строка на КАЖДЫЙ вызов через PAT —
  включая отклонённые гейтами (403/429), см. порядок гейтов выше.
  **ОГРАНИЧЕНИЕ: 401 (невалидный/отозванный токен) в аудит не пишется** — строки
  токена в `personal_access_tokens` нет, вешать FK `token_id` не на что. Поля:
  - `id` (BigInteger, Identity, PK) — компактный append-only ключ;
  - `token_id` (Uuid, FK personal_access_tokens ON DELETE CASCADE);
  - `user_id` (Uuid) — денормализовано, выборки без JOIN;
  - `occurred_at` (timestamptz, server_default now());
  - `method` (String(8)), `path` (String(200)) — ШАБЛОН роута (`route.path_format`),
    не сырой URL: компактно и без query-значений в аудите;
  - `status_code` (SmallInteger); `entity_id` (Uuid, nullable) — для write: id
    затронутой сущности (PATCH/PUT — из path-параметра; POST 2xx — `id` из JSON-ответа).
  Индекс ОДИН составной `ix_pat_audit_token_time (token_id, occurred_at)` — покрывает
  «что делал этот токен и когда»; отдельный индекс по user_id не нужен (локальная
  однопользовательская фаза, выборка по токену первична).
  Запись — ASGI-middleware в `app.py`: срабатывает только при `request.state.pat`,
  собственная короткая сессия, ошибка вставки НИКОГДА не валит запрос (stderr-лог);
  тело ответа буферизуется ТОЛЬКО для PAT-write 2xx ради `entity_id` (ответы
  маленькие). Против раздувания: никакие тела запросов/ответов не хранятся, объём
  ограничен самими rate-limit'ами (≤80 строк/мин на токен в худшем случае);
  retention — ручной SQL-prune, автопрун-джоб отложен до HTTP-фазы 2.
  **Просмотр — только SQL в v1** (обоснование: read-эндпоинт без UI-читателя —
  мёртвая поверхность контракта; пример запроса — в README пакета; эндпоинт+UI
  добавит HTTP-фаза 2).

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

- **S1 PAT-бэкенд** (FULL): миграция 0007 (personal_access_tokens + pat_audit_log +
  `transactions.client_id` из B-1), `pat_auth.py`, аудит-middleware, `/tokens` router
  (POST/GET/DELETE-revoke JWT-only + `GET /tokens/self` PAT-доступный), scope-гейт,
  rate limit, идемпотентность POST /transactions (B-1 as-is), contract regen
  (+ CORS-verbs проверка — новых верба нет, но тест это ловит). Блокирует всё.
- **S2 Веб-«Настройки»** (STANDARD): нужен контракт из S1.
- **S3 mcp-server read + stdio** (STANDARD): нужен S1 (живой PAT); генератор и
  truncate строятся по закоммиченному openapi.json параллельно с S2.
- **S4 write-инструменты + guardrails-описания** (предлагаю STANDARD: серверная
  безопасность вся в S1/FULL; S4 — TS-слой поверх): после S3.
- **S5 док-страница конфига Claude Desktop/Code** (FAST): после S3, параллельно S4.

Параллелится: S2 ∥ S3 (после S1); S5 ∥ S4 (после S3).

## 9. Открытые вопросы — РЕШЕНЫ пользователем (2026-08-19)

1. Исключение `users/me GET` — ПРИНЯТО (валюта в stats/summary).
2. Срок жизни PAT — без `expires_at` в v1, ручной revoke; TTL в HTTP-фазе 2.
3. Аудит — ТАБЛИЦА `pat_audit_log` (переопределил log-only рекомендацию), см. §6.
4. Скоупы токена: `read` | `full` (не read_write); модель с запасом под будущее
   дробление по областям. Self-introspection `GET /tokens/self` — см. §4.
5. `delete_transaction` добавлен (только `full`, guardrails обязательны — §4/§6);
   удаление категорий = архивирование через `update_category` (в API удаления нет).
6. Идемпотентность: B-1 из mobile-offline втянут в S1 — см. §6.

## Что НЕ решает этот документ
Тексты курируемых описаний инструментов; форма /tokens-схем и UI-детали S2;
tsx-vs-dist запуск бинаря; точный порог/алгоритм усечения массивов (50KB — стартовое
значение, правится в plan-mcp.md без пересмотра архитектуры).
