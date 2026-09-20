# mcp.md — apps/api/src/budget_api/mcp (stdio MCP-сервер внутри API-пакета)

## Что это
`python -m budget_api.mcp` — локальный MCP-сервер (stdio) для Claude Desktop/Code:
AI-клиент читает и пишет бюджет пользователя через API :8010 с personal access
token'ом. Заменил TS-пакет `packages/mcp-server` (удалён 2026-09-20, скоуп
`mcp-decorators`). Запуск, конфиг клиента, env, troubleshooting — `apps/api/MCP.md`
(руководство пользователя). Здесь — карта для агента.

SDK `mcp` — **extra**, не рантайм-зависимость: `[project.optional-dependencies] mcp`;
образ API (`uv sync --frozen --no-dev`) его не содержит и обязан импортировать
`budget_api.app` без него. Dev-группа тянет `budget-api[mcp]`, чтобы `uv run pytest`
видел SDK. Запуск: `uv run --frozen --extra mcp --directory <abs>/apps/api python -m budget_api.mcp`.

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
- `mcp/server.py` — `serve(env)`: конфиг → сборка инструментов → `GET /tokens/self`
  (скоуп токена) → публикация по скоупу (`read` → ровно 20 read-инструментов, write
  не видны; `full` → 35, +`upload_receipt` при `BUDGET_UPLOAD_DIR`). Ожидаемые сбои
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

## Что НЕ инструмент и почему (рядом с роутом — `# MCP: no`)
PATCH /profile (базовую валюту меняет человек); `delete_goal_item` (каскад по
поддереву и файлам); POST/PATCH /deposits (создание денежной сущности, override
процентов сервера); `GET /transactions/export` (стриминг CSV, курировать нечего);
все девять маршрутов statement-imports — «нет» целым модулем, обоснование в его
докстринге, маркеров там нет ни одного (массовые необратимые мутации без экрана
подтверждения); `POST /receipts/{id}/parse` (тратит AI-бюджет — отказ на JWT 401). `@pat_reachable` без инструмента: `POST /receipts`,
`GET /receipts/{id}` (зовёт `upload_receipt`), `GET /tokens/self`.

## Тесты (сторожа, а не дубли)
- `tests/test_pat_auth.py` — `EXPECTED_PAT_ALLOWLIST` (38 пар) и `NEVER_PAT` (19 пар)
  сверяются с выведенным из декораторов множеством; каждая пара обязана
  существовать в контракте.
- `tests/test_mcp_exposure.py` — обход монтированных роутеров (пары контракта ⊆
  пройденным парам), незнакомый контейнер валит обход, порядок read→write.
- `tests/test_mcp_tools.py` — оба списка скоупов ПОИМЁННО (растяжка READ/WRITE),
  плоская схема, `managed_body`, курация денежных write-полей, дрейф-ошибки списком.
- `tests/test_mcp_server.py` — in-memory клиент SDK: `tools/list` по скоупам,
  `tools/call`, truncation, идемпотентность `client_id`, `describe_api_error`
  (пять форм отказа), три гейта upload + 3xx от хранилища. Фикстура пинит md5
  `openapi.json` = `8594381c51613ad89237be526f9f7b17`: сменился контракт —
  обновляй снимок сознательно.

## Грабли
- Новый эндпоинт без `@mcp_tool`/`@pat_reachable`/`# MCP: no` — не ошибка сборки, а
  молча закрытая дверь; вопрос решается на грумминге (grooming-workflow SKILL.md).
- Потребителей контракта теперь ТРИ (web, mobile, api-client): сервер читает
  `app.openapi()` вживую, дрейф-тестов TS-пакета больше нет — их роль у
  `test_mcp_tools.py`.
- `uv run` без `--extra mcp` на машине без dev-группы → `ModuleNotFoundError: mcp`.
- Инварианты денег: MCP не считает и не конвертирует — `amount_minor` сквозняком,
  конвертация только `convert_currency` (сервер).
- Известные отличия от TS-сервера (на проводе): внутригрупповой порядок
  инструментов; `isError:false` на успехе (TS поле опускал). Поведения клиента
  не меняют. Живой прогон: `.tasks/mcp-decorators/qa-checklist.md` (re-probe).
