# Code review — mcp-server S1 (PAT-бэкенд), тир FULL

Дата: 2026-08-19. Ревьюер: code-reviewer. Диффы некоммиченные (git status на момент ревью).
Контекст прочитан: architecture.md, plan.md, mobile-offline/plan.md (B-1), docs/conventions.md, docs/backend.md.
Гейты (pytest 360/360, ruff, pyright, typecheck) НЕ перегонялись — прогнаны независимо; здесь только точечные пробы.

## Вердикт

**Одобрено с оговорками: 0 BLOCKER, 1 MAJOR (аудит-покрытие — нужно решение senior-lead/пользователя), 2 MINOR, 2 NIT.**
Безопасностное ядро (хеширование, fail-closed allowlist, порядок гейтов, анти-эскалация, no-oracle, B-1) — корректно и проверено, включая сверку `route_template` с исходниками установленного fastapi 0.139.2.

## Findings

### MAJOR-1 — аудит не пишет отклонённые PAT-вызовы (отклонение от architecture §6)

- Файлы: `apps/api/src/budget_api/pat_auth.py:265` (стэш `request.state.pat` — ПОСЛЕДНИЙ шаг, после всех гейтов), `apps/api/src/budget_api/pat_audit.py:15-17,125-129`.
- Суть: architecture §6 требует «строка на КАЖДЫЙ вызов через PAT». Фактически строка пишется только для вызовов, прошедших все гейты: запрос ВАЛИДНЫМ токеном, срезанный allowlist'ом (403 `TOKEN_ENDPOINT_FORBIDDEN`), scope-гейтом (403 `TOKEN_SCOPE_READONLY`) или rate-limit'ом (429), не оставляет следа — стэш ещё не сделан. Туда же: неотловленный 500 из хендлера пролетает сквозь middleware исключением, и вставка аудита не выполняется вовсе.
- Почему проблема: именно отклонённые попытки (утёкший read-токен долбится в write/export, перебор эндпоинтов) — первоочередной материал для расследования по аудит-таблице. Сейчас скомпрометированный токен, получающий сплошные 403, в `pat_audit_log` невидим. Это осознанное решение инженера (задокументировано в docstring pat_audit.py), но отклонение от утверждённой пользователем архитектуры нигде не зафиксировано.
- Фикс (маленький): в `current_user_jwt_or_pat` переставить `request.state.pat = PatContext(...)` сразу после успешного hash-lookup (перед allowlist-гейтом) — тогда 403/429 аудируются со своим status_code, а `/tokens/self` и debounce не меняются (стэш до них); в `PatAuditMiddleware.__call__` обернуть `await self.app(scope, receive, send_wrapper)` в `try/finally` (вставка в `finally`, status 500 при незавершённом ответе). Плюс один тест: 403-проба валидным токеном оставляет строку. Альтернатива — явно зафиксировать отклонение в architecture §6 с подписью пользователя; тогда severity падает до NIT.

### MINOR-1 — фолбэк аудита нарушает собственное правило «никогда сырой URL»

- Файл: `apps/api/src/budget_api/pat_audit.py:133` — `path = route_template(scope) or scope.get("path", "")`.
- Суть: если шаблон не разрешился, в `path` пишется сырой путь запроса. Модульная докстрока и модель (`pat_audit_log.path` — «Route TEMPLATE … never the raw URL») обещают обратное. Сегодня ветка практически недостижима (аутентификация PAT уже требует разрешённого шаблона, effective_route_context остаётся в scope), утечка ограничена uuid'ами из path — но фолбэк противоречит инварианту, ради которого колонка спроектирована.
- Фикс: `route_template(scope) or "<unresolved>"`.

### MINOR-2 — POST /tokens ничем не ограничен по частоте

- Файл: `apps/api/src/budget_api/routers/tokens.py:89`, маунт в `app.py` без `prime_rate_limit` (осознанно — PAT-лимиты живут в dependency).
- Суть: JWT-сессия может выпускать токены без всякого лимита — единственный «минтящий credentials» эндпоинт без rate limit (login 10/min, register 5/h, receipts 30/min). Риск низкий (single-user фаза, JWT = полный доступ и так), но это неограниченный рост таблицы + бесшумное массовое создание кредов.
- Фикс: дешёвый вариант — `token_create_rate_limit` (напр. 10/hour per user) через существующий `user_rl_key`-паттерн receipts; либо явно отложить в HTTP-фазу 2 с пометкой в architecture.

### NIT-1 — комментарий про HEAD врёт

- Файл: `apps/api/src/budget_api/pat_auth.py:59-61` («GET/HEAD are served to any scope»).
- Starlette добавляет HEAD к каждому GET-роуту, но пар `("HEAD", …)` в allowlist нет — любой HEAD через PAT получает 403 `TOKEN_ENDPOINT_FORBIDDEN`. Направление безопасное (fail-closed), но комментарий описывает несуществующее поведение. Поправить комментарий (или осознанно добавить HEAD-пары — не нужно для MCP).

### NIT-2 — узкий except в аудит-вставке

- Файл: `apps/api/src/budget_api/pat_audit.py:152` — ловятся `(SQLAlchemyError, OSError, TimeoutError)`.
- Исключение вне списка (RuntimeError при teardown loop'а и т.п.) вылетит после уже отправленного ответа — клиент не пострадает, но инвариант «never fail a request» даст трещину в логах/keep-alive. Для писателя аудита стандартен `except Exception` в этом одном месте.

## Что проверено и чисто (по фокус-листу)

1. **Хранение токена**: в БД только sha256-hex (`hash_token` от полной строки, create+lookup симметричны); plaintext существует только в `TokenCreated` (openapi подтверждает: единственная схема с полем `token`); grep — ни одного `logger/print` в pat_auth/tokens/schemas; лог в transactions.py пишет только user uuid; аудит хранит только шаблон роута.
2. **route_template / fail-closed**: сверено с исходниками установленного fastapi 0.139.2 — `_handle_selected` кладёт `_EffectiveRouteContext` выбранного роута в `scope["fastapi"]["effective_route_context"]` БЕЗ restore (виден и dependency, и middleware); его `path_format` строится через `include_context.path_for` = полный префиксованный шаблон, байт-в-байт ключ openapi. try/finally-restore существует только на фазе МАТЧИНГА — протухший чужой контекст в хендлер не попадает. Фолбэк `scope["route"]` отдаёт router-relative шаблон (`""`, `/summary`, `/self`, …) — вручную сверил: ни один relative-шаблон в приложении не совпадает ни с одной allowlist-парой, т.е. фолбэк не может вернуть более широкое право; `None` и пустая строка → 403. Порядок кандидатов (effective первым) корректный.
3. **Порядок гейтов**: 401 lookup (один raise на missing/revoked/inactive-owner, JOIN users) → 403 allowlist → 403 scope → 429 rate → debounce+stash. Ни одна ветка не проскакивает; JWT-путь не касается гейтов 2-5.
4. **Анти-эскалация /tokens**: POST/GET-list/DELETE — `current_active_user` из auth.py (PAT туда структурно не заходит: тест даёт 401 на все три); `/tokens/*` вне allowlist кроме `GET /tokens/self`; `TokenSelf` = строго `{id, scope}`; JWT на /self → 404 `TOKEN_NOT_FOUND`. `/self` объявлен до `/{token_id}`.
5. **user_id-скоупинг/no-oracle**: list_tokens и revoke фильтруют по user_id; revoke — один SELECT (id+user_id+revoked_at IS NULL) → один 404 для чужого/несуществующего/повторного; `_load_by_client_id` скоупится по user_id (пер-user частичный индекс, кросс-юзер тест есть).
6. **B-1 as-is**: hit до `_validate_category` (тест с заархивированной категорией пинит); replay — чистое чтение (тест merchant-map пинит отсутствие upsert'а); `user_id` связан ДО записей (`user_id = user.id` до первой возможной инвалидции сессии, expire_on_commit=False в db.py); recovery: rollback → re-select, `None` → re-raise чужих конфликтов; окно закрыто частичным индексом; матрица тестов = §verification B-1-плана, включая настоящий concurrency-тест и форсированный IntegrityError-arm.
7. **Аудит-middleware**: чистый ASGI, вставка после ответа, своя сессия, ошибка глотается (тест с mock'ом); буферизация ТОЛЬКО PAT-POST-2xx с потолком 64KB; entity_id PATCH/PUT/DELETE из пути, POST из тела (DELETE 204 покрыт тестом); JWT-строк нет (тест). Оговорки — MAJOR-1/MINOR-1/NIT-2 выше.
8. **Миграция 0007**: downgrade строго симметричен (обратный порядок); частичный уникальный индекс `uq_transactions_user_id_client_id … WHERE client_id IS NOT NULL` совпадает с моделью (`models/transaction.py`); CHECK `scope IN ('read', 'full')` байт-идентичен модельному (`_SCOPE_VALUES` из PatScope, порядок enum зафиксирован комментарием); имена констрейнтов совпадают с naming convention base.py (ck_/fk_/pk_/ix_ проверены вручную).
9. **Тесты**: все 14 пунктов плана закрыты 1:1 (сверено по файлам), плюс B-1-матрица; вакуумных/дублирующих не нашёл — каждый тест контрастирует ломаемое поведение (401-на-каждый-роутер, pydantic-валидация, существование колонок — осознанно не написаны, как велит план); `pat_factory` минтит токен через реальный POST /tokens (ловит рассинхрон хеширования).
10. **Rate limit**: ключ `{rate_limit_scope}:pat-read|pat-write:{token_id}` — изолирован и от JWT (тест: JWT 200 после 429 токена), и от IP-ключей декорированных роутов; `rate_limit_enabled=False` → полный пропуск; значения из Settings; `parse_many` покрывает составные лимиты.

**Контракт**: openapi.json диф чисто аддитивный (0 удалённых строк); POST /transactions честно декларирует 200+201; `client_id` только в TransactionCreate (не в Read); `/tokens/*` + схемы в паре с schema.d.ts — НЕ ЗАБЫТЬ закоммитить пару одним коммитом.
**Проба-подтверждение**: `PAT_ALLOWLIST` == таблица architecture §4 поэлементно, ровно 25 пар (выполнено интерпретатором).
