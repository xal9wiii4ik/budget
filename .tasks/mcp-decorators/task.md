# task.md — scope `mcp-decorators` (грумминг, кода не писать)

## Решение пользователя (авторитетно)
Правда о том, что доступно токеном и через MCP, живёт в ТРЁХ местах:
`apps/api/src/budget_api/pat_auth.py` (`PAT_ALLOWLIST`), `packages/mcp-server/src/allowlist.ts`
(инструменты: имя, метод, путь, scope, описание, описания параметров, `managedBody`) и правило
грумминга «каждый эндпоинт отвечает про MCP». Становится ОДНО: **декоратор на обработчике
маршрута FastAPI**, из которого выводятся и allowlist, и набор MCP-инструментов.
MCP-сервер переезжает на Python (официальный `mcp` SDK), живёт в `apps/api`, стартует отдельным
процессом по stdio, ходит в API по тому же PAT. `packages/mcp-server` удаляется ТОЛЬКО после
живой пробы нового сервера.

## Правила имплементации (жёсткие)
- `apps/api/openapi.json` не меняется ни на байт (md5 до: `8594381c51613ad89237be526f9f7b17`).
  Значит: метаданные декоратора НЕ попадают в контракт; новых эндпоинтов нет.
- `pat_audit.py` не трогать. Новых инструментов не добавлять. Не коммитить.
- Четыре группы маршрутов остаются «не в MCP», причина — в коде рядом с маршрутом:
  импорт выписок (все 9 маршрутов), вклады POST/PATCH, DELETE пунктов плана, PATCH профиля.
  Плюс исторические: `/transactions/export`, `/receipts/{id}/parse`, `/advisor`, `/users`,
  `/auth`, `/tokens` кроме `GET /self`, все DELETE кроме транзакции.

## Факты, установленные лидом пробами (не пересобирать заново)
1. **Инструментов 35, не 33** (20 read + 15 write): `allowlist.ts` в `src/` (allowlist.test.ts
   ожидает 35). `docs/mcp.md` («33 = 18+15») устарел. Собранный `dist/` (26.08) СТАРЕЕ `src/`
   (27.08, deposits): Claude Desktop сейчас реально видит 33. Снимок делать из `src/` после
   `pnpm --filter @budget/mcp-server build`.
2. **`PAT_ALLOWLIST` = 38 пар** = 35 инструментов + 3 пары без инструмента:
   `GET /tokens/self` (introspection при старте), `POST /receipts`, `GET /receipts/{receipt_id}`
   (их зовёт рукописный `upload_receipt`). Декоратор обязан уметь «доступен токену, но не
   инструмент».
3. **Python SDK `mcp`**: под Python 3.12 резолвится **2.2.0** (мажор 2.x: `FastMCP` переименован
   в `MCPServer`, низкоуровневый `Server(name, version=, on_list_tools=cb, on_call_tool=cb)`
   принимает колбэки в конструкторе; `types.Tool(name, description, input_schema=<raw dict>)`
   уходит на провод как `inputSchema`; `mcp.server.stdio.stdio_server()`;
   `mcp.shared.memory.create_client_server_memory_streams()` + `mcp.client.session.ClientSession`
   дают in-memory клиент для тестов — ПРОВЕРЕНО дымовым прогоном: list_tools/call_tool работают,
   входные аргументы сервером НЕ валидируются по схеме (как и в TS-low-level — 422 отдаёт API).
   С `mcp<2` резолвится 1.30.0 (декораторный API `@server.list_tools()`).
4. **Обход маршрутов FastAPI 0.139.2**: `app.routes` = 4 `Route` (docs) + 19 `_IncludedRouter`
   (приватный класс, атрибуты `include_context.prefix`, `original_router`,
   `effective_route_contexts()` → список контекстов с `path_format` (ПОЛНЫЙ шаблон с префиксом),
   `methods`, `endpoint`, `original_route`). Всего 78 пар (метод, путь); `PAT_ALLOWLIST` ⊆ них.
   `pat_auth.route_template()` уже читает `scope["fastapi"]["effective_route_context"].path_format`.
5. **`openapi_export.build_export_app()`** герметичен (dummy settings, без .env/БД/сети);
   `openapi_json(app)` = канон файла (`sort_keys=True`). ВНИМАНИЕ: `app.openapi()` в памяти
   отдаёт properties в порядке полей pydantic, файл — по алфавиту; TS-генератор читает ФАЙЛ.
   Для побайтового равенства схем Python-генератор должен брать `json.loads(openapi_json(app))`.
6. `@router.get/post/...` FastAPI возвращает ТУ ЖЕ функцию → атрибут-маркер на функции виден
   через `route.endpoint` при любом порядке декораторов.
7. Claude Desktop сейчас: `mcpServers.budget = {command: node, args: [<abs>/packages/mcp-server/
   dist/index.js], env: {BUDGET_API_URL, BUDGET_PAT}}`. В Claude Code `budget` НЕ добавлен
   (`claude mcp list` — только чужой fibery).
8. `uv` в PATH GUI-приложений (Claude Desktop) НЕ гарантирован — в конфиге нужен абсолютный путь.
9. Причина, по которой исходный TS-сервер не импортировал приложение: он на TypeScript; чтение
   `openapi.json` в рантайме выбрали, чтобы не плодить второй генерируемый артефакт
   (architecture §5 исходного скоупа). Для Python-сервера это ограничение не действует.

## Что должен ответить план (пункты 1–6 из брифа пользователя)
1. Форма декоратора; вывод (а) `PAT_ALLOWLIST` (frozenset становится вычисляемым, старый литерал —
   снимком в тесте, `TestAllowlistContract` → равенство), (б) инструментов с JSON-схемами из
   openapi того же приложения (как `tools.ts`/`openapi.ts`); маршрут без декоратора = недоступен
   токеном и невидим в MCP, fail-closed по построению.
2. Где живёт сервер (`apps/api/src/budget_api/mcp/`), команда запуска, зависимость `mcp` и версия;
   источник списка инструментов — импорт приложения vs запрос к работающему API (оценить оба).
3. Обратная совместимость ДОКАЗЫВАЕТСЯ: снимок TS-сервера (35 имён, схемы, описания байт-в-байт,
   read/full) — фикстура ДО правок; тест нового сервера сравнивает; `PAT_ALLOWLIST` до/после —
   равенство множеств; `openapi.json` md5 до/после; конфиг Claude Desktop — старая запись живёт
   до удаления TS.
4. `upload_receipt` — те же три гейта (каталог из `BUDGET_UPLOAD_DIR`, `realpath`-вложенность,
   магические байты JPEG, потолок 10 МБ), перенос `uploadReceipt.test.ts` по смыслу.
5. Судьба `packages/mcp-server`, `docs/mcp.md`, `docs/backend.md`, правила грумминга.
6. Команда, порядок, оценка в агент-минутах, риски (SDK 2.x и Python 3.12, двойной запуск
   в переходный период, дрейф-тесты mcp-server).

## Читать (по указателям, не картографировать)
`docs/backend.md`, `docs/mcp.md`, `docs/conventions.md`, `packages/mcp-server/README.md`,
`packages/mcp-server/src/{allowlist,tools,openapi,http,truncate,index,uploadReceipt}.ts` и их
тесты, `apps/api/src/budget_api/{pat_auth,openapi_export}.py`, `apps/api/tests/test_pat_auth.py`
(`TestAllowlistContract`), `apps/api/src/budget_api/routers/{profile,tokens,receipts}.py`,
`.tasks/mcp-server/{architecture,grooming-review}.md`.
