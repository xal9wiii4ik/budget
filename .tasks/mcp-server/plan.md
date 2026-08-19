# Implementation Plan: S1 — PAT-бэкенд (scope mcp-server, PLAN 5.6)

## Approach
PAT живёт рядом с JWT: одна dependency `current_user_jwt_or_pat` сниффит префикс
`bgt_pat_` и либо идёт в PAT-ветку, либо делегирует в `current_active_user`. Роутеры по
сути не меняются — PAT-ветка возвращает тот же `User`, поэтому user_id-скоуп, no-oracle,
минорные единицы и снапшот курса работают как есть.

Enforcement — **fail-closed allowlist** (поправка senior-lead; отменяет денайлист
architecture §3 и код `TOKEN_METHOD_FORBIDDEN`): frozenset пар `(method,
route.path_format)` = таблица architecture §4, матчинг по `request.scope["route"]`
(FastAPI `APIRoute.matches` кладёт `route` в scope — проверено на fastapi 0.139 /
starlette 1.3.1; `path_format` идёт с префиксом роутера и байт-в-байт равен пути в
openapi.json). Всё вне списка, включая любой DELETE и `/transactions/export`, → 403
`TOKEN_ENDPOINT_FORBIDDEN`. Требуемый scope выводится из метода (GET/HEAD → read,
иначе read_write) — третьего поля в таблице нет, дрейфовать нечему. Rate limit —
прямой `hit` по storage slowapi-лимитера: декоратор на ~20 роутов зацепил бы и
JWT-трафик, и размазал конфиг.

## Files to modify
- `enums.py` — `PatScope(read|read_write)`, порядок значений load-bearing (модель
  пересобирает CHECK байт-в-байт под 0007); `models/__init__.py` — реэкспорт модели.
- `config.py` — `pat_read_rate_limit="60/minute"`, `pat_write_rate_limit="20/minute"`, `pat_last_used_debounce_seconds=60`.
- `app.py` — маунт `tokens.router` (prefix `/tokens`, БЕЗ `prime_rate_limit`).
- **Переезд dependency** (импорт `from budget_api.auth import current_active_user` →
  `from budget_api.pat_auth import current_user_jwt_or_pat` + все
  `Depends(current_active_user)` в файле; порядок параметров AUTH-FIRST не трогаем):
  `routers/categories.py` (3 места), `transactions.py` (6), `fx.py` (1), `goals.py` (9),
  `recurring.py` (4), `limits.py` (3), `stats.py` (3) — 29 мест / 7 файлов. НЕ
  переезжают: `auth.py`, `users.py`, `receipts.py`, `advisor.py`, `health.py`.
- `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts` — регенерация.

## New files
- `models/personal_access_token.py` — таблица architecture §1, plain `Mapped[...]` без
  TYPE_CHECKING-сплита (образец `category_limit.py`), CHECK scope из `PatScope`.
- `alembic/versions/0007_personal_access_tokens.py` — DDL + симметричный downgrade.
- `pat_auth.py` — PAT-ветка, allowlist, scope-гейт, rate limit, дебаунс, аудит-лог.
- `schemas/token.py`, `routers/tokens.py`, `tests/test_pat_auth.py`, `tests/test_tokens.py`.

## Code skeletons
```python
PAT_ALLOWLIST: frozenset[tuple[str, str]] = frozenset({  # = таблица architecture §4
    ("GET", "/transactions"), ("GET", "/transactions/summary"), ("POST", "/transactions"),
    ("PATCH", "/transactions/{transaction_id}"), ("GET", "/categories"),
    ("POST", "/categories"), ("PATCH", "/categories/{category_id}"), ("GET", "/goals"),
    ("GET", "/goals/{goal_id}"), ("GET", "/goals/{goal_id}/progress"), ("POST", "/goals"),
    ("GET", "/goals/{goal_id}/contributions"), ("PATCH", "/goals/{goal_id}"),
    ("POST", "/goals/{goal_id}/contributions"), ("GET", "/limits"), ("GET", "/recurring"),
    ("PUT", "/limits/{category_id}"), ("POST", "/recurring"), ("GET", "/fx/convert"),
    ("PATCH", "/recurring/{template_id}"), ("GET", "/stats/summary"),
    ("GET", "/stats/monthly"), ("GET", "/stats/top-merchants"),
})  # каждая пара сверяется с openapi.json тестом 11

async def current_user_jwt_or_pat(request, session=Depends(get_session), ...) -> User:
    # 1. нет префикса bgt_pat_ -> делегат в current_active_user (JWT-путь)
    # 2. sha256(token).hexdigest() -> lookup + JOIN users; revoked_at IS NULL,
    #    user.is_active; иначе 401 TOKEN_INVALID (ОДИН код-путь: нет == отозван)
    # 3. (request.method, request.scope["route"].path_format) not in PAT_ALLOWLIST
    #    -> 403 TOKEN_ENDPOINT_FORBIDDEN            <-- FAIL-CLOSED, ПЕРВЫМ
    # 4. write-метод и pat.scope != read_write -> 403 TOKEN_SCOPE_READONLY
    # 5. rate limit -> 429 {"detail": "RATE_LIMITED"}
    # 6. дебаунс last_used_at; request.state.pat = pat; аудит-строка для write
```
Порядок 3→4→5 обязателен: неизвестный путь не подсказывает про scope; нет ключа `route`
в scope — трактуем как «не в allowlist». Rate limit: ключи architecture §6, значения из
Settings, пропуск при `rate_limit_enabled is False`, contextvar `prime_rate_limit` не
нужен (есть `request`):
```python
key = f"{request.app.state.rate_limit_scope}:{'pat-read'|'pat-write'}:{pat.id}"
for item in limits.parse_many(<settings-значение по классу метода>):
    if not limiter.limiter.hit(item, key):   # memory storage, sync, без I/O
        raise HTTPException(429, detail="RATE_LIMITED")
```
Дебаунс `last_used_at` — SQL из architecture §2 + `commit()` ДО хендлера (провалившийся
хендлер не отменяет факт использования). **`routers/tokens.py`** — JWT-only, импорт `current_active_user`
из `auth.py` (PAT-ветки тут нет вообще = нет эскалации):
- `POST ""` 201 → `TokenCreated{id,name,scope,created_at,token}`, тело
  `TokenCreate{name: str(1..100), scope: PatScope}`; `token` = `bgt_pat_` +
  `secrets.token_urlsafe(32)`, отдаётся ЕДИНСТВЕННЫЙ раз, в БД только sha256-hex.
- `GET ""` → `TokenList{items: list[TokenRead]}` (обёртка — конвенция recurring/goals),
  `TokenRead{id,name,scope,created_at,last_used_at,revoked_at}` — хэша в схеме НЕТ.
- `DELETE /{token_id}` 204 soft-revoke, выборка по user_id; чужой / несуществующий / уже
  отозванный → 404 `TOKEN_NOT_FOUND` одним путём.

## Contract regen
`pnpm openapi` → `/tokens` в `openapi.json` + `schema.d.ts`, пара в одном коммите. В
PAT_ALLOWLIST `/tokens` НЕ входит: контракт (веб S2) и доступность по PAT независимы.

## Тесты (только за реально ломаемое; фикстуры `pat_factory` — в conftest.py)
1. Валидный PAT аутентифицирует GET /transactions, видит только свои строки.
2. Отозванный / несуществующий / мусорный → 401 `TOKEN_INVALID`, тело байт-в-байт одно.
3. Scope: read-PAT на POST /transactions → 403 `TOKEN_SCOPE_READONLY`, read_write → 201.
4. Allowlist fail-closed под read_write-PAT: GET /transactions/export и DELETE
   /limits/{category_id} → 403 `TOKEN_ENDPOINT_FORBIDDEN`.
5. JWT гейтом не задет: тот же DELETE /limits/{category_id} с JWT → 204.
6. Анти-эскалация: POST /tokens и DELETE /tokens/{id} с read_write-PAT → 401.
7. Дебаунс: первый вызов проставляет `last_used_at`, второй в окне не меняет.
8. Rate limit при `pat_read_rate_limit="2/minute"`: третий PAT-GET → 429
   `{"detail":"RATE_LIMITED"}`, JWT того же юзера всё ещё 200 (ключ — токен).
9. Созданный plaintext отдаётся один раз И реально аутентифицирует; в GET /tokens его нет.
10. Revoke: свой → 204, дальше 401; чужой и несуществующий → 404 `TOKEN_NOT_FOUND`.
11. Каждая пара `PAT_ALLOWLIST` есть в экспортированном OpenAPI (иначе переименование
    роута молча выключит инструмент MCP).

Не пишем: pydantic-валидацию `name`/`scope`, существование колонок, 401 на каждый
переехавший роутер отдельно. Оценка: 7 новых файлов (2 — тесты), ~13 изменённых.

## Open questions (senior-lead)
1. **Аудит write'ов** (architecture §6): в dependency есть token_id/user_id/method/path,
   но НЕ статус ответа и не id сущности. Предлагаю строку до хендлера (логгер
   `pat_audit`, INFO, только write); версия со статусом требует middleware в `app.py`.
2. `TOKEN_METHOD_FORBIDDEN` (architecture §3) не реализуется (allowlist поглощает DELETE)
   — подтверди отклонение.
3. `expires_at` нет (OQ-2) — миграция 0007 без колонки.

## Risks
- Забытая замена одного `Depends` — инструмент MCP молча не работает (ловится QA);
  обратный риск (дыра) отсутствует по построению: незнакомый путь → 403.
- `limiter.limiter.hit()` синхронный — ок для memory-storage; на Redis в фазе 2 станет
  блокирующим вызовом в async-хендлере (отметить в docs/backend.md).
