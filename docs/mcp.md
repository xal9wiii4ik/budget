# mcp.md — apps/api/src/budget_api/mcp (MCP-сервер внутри API-пакета: stdio + `/mcp`)

## Что это
`python -m budget_api.mcp` — локальный MCP-сервер (stdio) для Claude Desktop/Code:
AI-клиент читает и пишет бюджет пользователя через API :8010 с personal access
token'ом. Заменил TS-пакет `packages/mcp-server` (удалён 2026-09-20, скоуп
`mcp-decorators`). Запуск, конфиг клиента, env, troubleshooting — `apps/api/MCP.md`
(руководство пользователя). Здесь — карта для агента.

SDK `mcp` — **рантайм-зависимость** (с скоупа `mcp-remote`, R4): его хендлеры несут
OAuth-сервер и `/mcp` внутри процесса API, поэтому образ (`uv sync --frozen --no-dev`)
обязан его содержать. Extra `mcp = []` остался ПУСТЫМ алиасом: `--extra mcp` стоит в
документированной строке запуска и в конфиге Claude Desktop владельца, а несуществующий
extra валит uv. Запуск не изменился:
`uv run --frozen --extra mcp --directory <abs>/apps/api python -m budget_api.mcp`.

## Единственный источник правды — маркер на хендлере
- `mcp/decorator.py` — `@mcp_tool(name, description, params=, managed_body=)` и
  `@pat_reachable(reason=)`; `exposure_of(fn)`. Маркер стоит ВПЛОТНУЮ над `async def`
  (после `@router.<method>` и лимитеров). Немаркированный маршрут: 403 токену и
  невидим в MCP — fail-closed по построению. Сознательное «нет» — комментарий
  `# MCP: no — <причина>` над роутом. Скоуп НЕ аргумент: read ⇔ GET, точка.
- `mcp/exposure.py` — обходит смонтированные роутеры (fastapi ≥0.139 монтирует, а не
  копирует — обход рекурсивный, HEAD/OPTIONS выброшены, незнакомый контейнер →
  `TypeError` на `create_app`). Два вывода из ОДНОГО прохода: `pat_allowlist(app)` →
  `app.state.pat_allowlist` (`app.py` ставит ПОСЛЕ последнего `include_router`;
  `pat_auth.py` читает `getattr(..., frozenset())` — без state всё закрыто) и
  `tool_specs(app)` → список инструментов: все read, затем все write, внутри
  группы порядок обхода (роутер за роутером). Порядок не контрактен, но попадает
  в промпт модели.
- `mcp/prose.py` — 31 английский фрагмент, общий для ≥2 инструментов (minor units,
  «id бери из list_accounts», «omit = keep»). Фраза одного инструмента живёт в его
  `@mcp_tool`; фраза двух хендлеров ОДНОГО роутера — модульная константа роутера
  (architecture §2.5, пример `_CHARGED_TO_ACCOUNT` в `routers/transactions.py`).
  stdlib only — роутер импортирует свободно.

## Сборка инструментов (`mcp/tools.py`)
- На старте сервер строит `create_app()` и берёт `app.openapi()` — тот же документ,
  что `openapi.json`; файл не читается, codegen нет, «рассинхрон allowlist с
  контрактом» как класс ошибок исчез.
- `$ref` разворачиваются, `inputSchema` ПЛОСКИЙ: path/query-параметры и
  body-properties на одном уровне; `anyOf:[X,null]` схлопнут → очистить поле через
  MCP нельзя, omit = keep. Целочисленные границы печатаются как int (D1-3).
- `managed_body` — поля, которые сервер выставляет сам и модель не видит:
  `create_transaction.client_id = uuid4` на каждый логический вызов (ретрай
  транспорта → 200 со СТАРОЙ строкой, не дубль).
- Дрейф ловится СПИСКОМ ошибок (`ToolBuildError`): параметр без схемы, `params=`
  на несуществующее поле, поле денежного write без курируемого описания.
- `as_object`/`as_array` — здесь же, читают их `http.py` и `upload_receipt.py`.

## Рантайм
- `mcp/server.py` — `build_server(tools, *, credential, upload)` (ОБЩИЙ для stdio и
  `/mcp`, см. «Удалённый транспорт») и `serve(env)`: конфиг → сборка инструментов →
  `GET /tokens/self`
  (скоуп токена) → публикация по скоупу (`read` → ровно 22 read-инструмента, write
  не видны; `full` → 40, +`upload_receipt` при `BUDGET_UPLOAD_DIR`). Ожидаемые сбои
  старта (`ConfigError`, `OpenApiError`, `ToolBuildError`, отказ introspection) —
  одна фраза в stderr и exit 1, без трейсбека. Весь лог — stderr с префиксом
  `budget-mcp:`; stdout принадлежит транспорту (в пакете нет `print`).
- `mcp/http.py` — httpx, `Authorization: Bearer`, таймаут 30 с, `follow_redirects`
  выключен сознательно; `is_success` (2xx), а не «не 4xx/5xx» — 3xx это отказ.
  `describe_api_error`: TOKEN_INVALID / TOKEN_SCOPE_READONLY /
  TOKEN_ENDPOINT_FORBIDDEN / RATE_LIMITED / `*_NOT_FOUND` (no-oracle не размывается:
  «not found (it does not exist, or it is not yours)») / pydantic-список 422 /
  429 без JSON. Query: bool → `true`/`false`, `quote(safe="")`.
- `mcp/truncate.py` — ответ > 50 KB: самый длинный массив режется с хвоста,
  `_truncated:{shown,total,note}`.
- `mcp/upload_receipt.py` — единственный инструмент НЕ из контракта: путь (не байты)
  → `POST /receipts` → presigned PUT → `GET /receipts/{id}`. Три гейта: нет
  `BUDGET_UPLOAD_DIR` — инструмента нет; `realpath` внутри каталога (симлинк наружу
  отсекается); JPEG по магическим байтам; потолок 10 МБ. Только `full`.
  Блокирующее IO — в `anyio.to_thread`.
- `mcp/__main__.py` — единственная точка входа; console-script нет намеренно.

## Удалённый транспорт `/mcp` (скоуп `mcp-remote`)
- Маршрут — Starlette `Route`, собирается в `oauth/routes.py`; `Mount` ЗАПРЕЩЁН (дал бы
  307 `/mcp` → `/mcp/`, а редирект теряет `Authorization`). Цепочка:
  `AuthenticationMiddleware(BearerAuthBackend(_GrantTokenVerifier, resource_server_url))`
  → `RequireAuthMiddleware(required_scopes=[], resource_metadata_url)` →
  `StreamableHTTPASGIApp`. Анонимный GET и POST → 401 + `WWW-Authenticate: Bearer
  error="invalid_token", error_description="Authentication required",
  resource_metadata="<base>/.well-known/oauth-protected-resource/mcp"` (байты пришпилены в
  `tests/test_mcp_remote.py`). Bearer проверяет `provider.load_access_token` →
  `resolve_access_token_row` — тот же резолвер, что у `pat_auth`; `_GrantTokenVerifier`
  вместо SDK-ного `ProviderTokenVerifier` только из-за инвариантных дженериков.
- `mcp/remote.py` — `build_remote(app)`: инструменты из ЖИВОГО приложения
  (`parse_document(json.loads(openapi_json(app)))` + `tool_specs(app)`),
  `StreamableHTTPSessionManager(stateless=True, json_response=True)`. Stateless-соединение
  «born-ready»: каждый POST — самодостаточный JSON-RPC, ни `initialize`, ни
  `MCP-Protocol-Version` не нужны.
- Креденшл — ПО ЗАПРОСУ и никогда не кэшируется. `build_server(tools, *, credential,
  upload)` зовёт `credential(ctx)` на каждом `tools/list`/`tools/call`; remote берёт его из
  `ctx.request.scope["user"]` (`AuthenticatedUser`: `.access_token.token` — сырой bearer,
  `.scopes[0]` — режим гранта), stdio передаёт константу и ведёт себя как раньше. `None` →
  `isError`-фраза, не трейсбек.
- Вызов инструмента — обычный запрос ВНУТРЬ того же приложения через
  `httpx.AsyncClient(transport=ASGITransport(app, raise_app_exceptions=False),
  base_url="http://budget.internal")`; клиент и `manager.run()` живут в lifespan и
  существуют только при заданном `PUBLIC_BASE_URL`. `raise_app_exceptions=False`
  обязателен — внутренняя 500 должна стать текстом, а не исключением в JSON-RPC. Аудит,
  лимиты и 404-без-оракула производит настоящий путь запроса.
- Удалённо НЕТ: `upload_receipt` (читает ФС сервера = контейнер API) —
  `UploadConfig(directory=None)`, спец-ветки не нужно; `tools/list` не аудируется (паритет
  со stdio); write-инструмент под read-грантом → `Unknown tool "…"`, а не
  `TOKEN_SCOPE_READONLY` (таблица диспетчера строится из режима ТОГО ЖЕ запроса).
- nginx (`apps/web/nginx.conf`): `location = /mcp` и префикс `location /.well-known/oauth-`
  → `api:8000`, у второго `proxy_pass` БЕЗ URI-части (путь уходит дословно); плюс
  `X-Frame-Options: DENY` и `frame-ancestors 'none'` на `location = /index.html`.
  `PUBLIC_BASE_URL` в прод-compose выводится из `SITE_DOMAIN`; `location = /mcp/` отдаёт 404
  (не редирект — 3xx потерял бы `Authorization`).
- DCR (`/oauth/register`) лимитирован `30/hour` на IP: у хостед-Claude это общий egress
  Anthropic, то есть бюджет фактически на весь деплой, а не на пользователя.

## Что НЕ инструмент и почему (рядом с роутом — `# MCP: no`)
PATCH /profile (базовую валюту меняет человек); `delete_goal_item` (каскад по
поддереву и файлам); POST/PATCH /deposits (создание денежной сущности, override
процентов сервера); DELETE /debts/{id} и PATCH/DELETE /debts/{id}/repayments/{rid}
(каскад/правка записанного движения: агент записывает, человек исправляет там, где
видны остаток и баланс); `GET /transactions/export` (стриминг CSV, курировать нечего);
все девять маршрутов statement-imports — «нет» целым модулем, обоснование в его
докстринге, маркеров там нет ни одного (массовые необратимые мутации без экрана
подтверждения); `POST /receipts/{id}/parse` (тратит AI-бюджет — отказ на JWT 401). `@pat_reachable` без инструмента: `POST /receipts`,
`GET /receipts/{id}` (зовёт `upload_receipt`), `GET /tokens/self`.

## Тесты (сторожа, а не дубли)
- `tests/test_pat_auth.py` — `EXPECTED_PAT_ALLOWLIST` (43 пары) и `NEVER_PAT` (30 пар,
  включая четыре маршрута `/oauth` — escalation surface — и три «не инструмент» у `/debts`) сверяются с выведенным из
  декораторов множеством; каждая пара обязана существовать в контракте.
- `tests/test_mcp_exposure.py` — обход монтированных роутеров (пары контракта ⊆
  пройденным парам), незнакомый контейнер валит обход, порядок read→write.
- `tests/test_mcp_tools.py` — оба списка скоупов ПОИМЁННО (растяжка READ/WRITE),
  плоская схема, `managed_body`, курация денежных write-полей, дрейф-ошибки списком.
- `tests/test_mcp_remote.py` — `/mcp` обычными httpx-POST'ами (без SDK-клиента): форма
  401 на GET и POST, `tools/list` 22/40 по режиму гранта, `tools/call` + ровно одна строка
  `pat_audit_log` на грант, write под read, внутренняя 500 → текст, отозванный грант → 401.
- `tests/test_mcp_server.py` — in-memory клиент SDK: `tools/list` по скоупам,
  `tools/call`, truncation, идемпотентность `client_id`, `describe_api_error`
  (пять форм отказа), три гейта upload + 3xx от хранилища. `fixtures/mcp_tools_snapshot.json`
  пинит все 40 инструментов (новый ДОБАВЛЯЕТСЯ в `tools`; `debts` — первый такой, +5);
  его `source.openapi_md5` — provenance исходных 35 с TS-сервера, никем не читается
  и при смене контракта не переписывается.

## Грабли
- Новый эндпоинт без `@mcp_tool`/`@pat_reachable`/`# MCP: no` — не ошибка сборки, а
  молча закрытая дверь; вопрос решается на грумминге (grooming-workflow SKILL.md).
- Потребителей контракта теперь ТРИ (web, mobile, api-client): сервер читает
  `app.openapi()` вживую, дрейф-тестов TS-пакета больше нет — их роль у
  `test_mcp_tools.py`.
- `--extra mcp` больше ничего не доустанавливает (пустой алиас); SDK приходит из
  `dependencies`, так что `ModuleNotFoundError: mcp` теперь означает незасинканное
  окружение, а не забытый флаг.
- `openapi_export.build_export_app` импортирует `create_app` ВНУТРИ функции: `app.py` →
  `mcp/remote.py` → `mcp/server.py` → `openapi_export` замкнулось бы в цикл импорта.
- Инварианты денег: MCP не считает и не конвертирует — `amount_minor` сквозняком,
  конвертация только `convert_currency` (сервер). Живой прогон:
  `.tasks/mcp-decorators/qa-checklist.md` (re-probe).
