# Architecture Plan: mcp-decorators — allowlist и инструменты MCP из декоратора на маршруте

Факты и правила — в `task.md`, здесь только решения. Кода нет.

## 1. Контекст
Три источника правды (`PAT_ALLOWLIST`, `allowlist.ts`, правило грумминга) → один: маркер на
обработчике FastAPI. Из него выводятся (а) allowlist гейта, (б) MCP-инструменты. Сервер MCP
переезжает в `apps/api` (Python, `mcp` 2.x). Контракт не меняется ни на байт.

## 2. Декоратор и реестр (A)

### 2.1 Форма
```python
@mcp_tool(name="create_transaction", description=..., params={...}, managed_body={"client_id": "uuid"})
@pat_reachable(reason="upload_receipt создаёт строку сам; инструментом не является")
```
- `method`/`path` — НЕ аргументы: берутся из сопоставленного маршрута при обходе. Дрейфовать нечему.
- `scope` — НЕ аргумент (эскиз пользователя со `scope=` отклонён): `read` ⇔ метод GET, иначе
  `write`. Все 35 инструментов совпадают с этим правилом (снимок §4 докажет это на равенстве
  поля `scope`), а гейт уже решает по `_WRITE_METHODS`. Третья колонка могла бы разойтись с
  гейтом — «read»-инструмент на POST опубликовался бы read-токену и ловил 403 в цикле; ровно от
  этого защищает `tools_for_scope`. Появится не-GET read — это отдельное решение, не knob.
- `params` — только имена, которые операция реально принимает; `managed_body` — только имена из
  тела; нарушение — ошибка сборки (§2.4), не молчаливый пропуск. Значение managed: `"uuid"`.
- Три пары без инструмента (`GET /tokens/self`, `POST /receipts`, `GET /receipts/{receipt_id}`)
  — `@pat_reachable(reason=...)`. Не `@mcp_tool` без инструмента: декоратор с именем «tool»,
  не дающий инструмента, врёт читателю в точке, где важно заметить «токену да, модели нет».
  «Один декоратор» соблюдён по смыслу: ОДИН атрибут `__mcp_exposure__`, ОДИН dataclass
  `Exposure(tool: ToolSpec | None, reason: str | None)`, ОДИН обход, ОДИН модуль; второе имя —
  второй конструктор того же объекта. `reason` обязателен только у `pat_reachable`.
- Повторное навешивание на одну функцию → `TypeError` при импорте (детерминированная ошибка
  программиста; это не реестр).
- Ставится ВПЛОТНУЮ над `async def` (самым внутренним). `functools.wraps` копирует `__dict__`,
  поэтому маркер переживает `@_limiter_any.limit` в receipts.py; `@router.*` возвращает ту же
  функцию (факт 6). Пара `POST /receipts` в тесте равенства пинит это.
- Байтовое правило: метаданные живут ТОЛЬКО на функции. Никаких `openapi_extra`, никаких правок
  докстрингов обработчиков (докстринг = description операции в контракте).

### 2.2 Реестр = обход, не глобальный список
`budget_api/mcp/exposure.py`: `collect(app) -> tuple[RouteExposure, ...]`,
`RouteExposure = (method, path_format, endpoint, exposure)`. Обход `app.routes`:
- `starlette.routing.Route` (и `APIRoute`) → одна запись на метод, путь уже полный;
- объект с `effective_route_contexts()` → по контексту: `path_format`, `methods`, `endpoint`;
- всё остальное (`Mount`, `WebSocketRoute`, неизвестный класс) → `TypeError`. Fail-closed на
  апгрейде FastAPI: незнакомый контейнер валит `create_app`, а не молча теряет пары.
- Приватный `_IncludedRouter` НЕ импортируется: duck-typing через `typing.Protocol`
  (`effective_route_contexts`, `path_format`, `methods`, `endpoint`) — pyright strict
  (`reportPrivateUsage`) и меньшая связка с приватным именем.
- Два вывода: `pat_allowlist(app) -> frozenset[(method, path_format)]` (все маркеры) и
  `tool_specs(app)` (только с `tool`, в порядке обхода).
- Вызов: в `create_app` после последнего `include_router`, синхронно (как `app.state.settings`,
  НЕ в lifespan): `app.state.pat_allowlist = pat_allowlist(app)`. Любое тестовое приложение
  получает его автоматически. Метод берётся из `methods` контекста как есть (HEAD пары не даёт).
- Второй tripwire на апгрейд (известный тип, новая семантика): множество пар из
  `openapi()["paths"]` ⊆ множества ВСЕХ пар обхода (не только маркированных).

### 2.3 Гейт в рантайме
`current_user_jwt_or_pat`: `PAT_ALLOWLIST` → `request.app.state.pat_allowlist`. Одна замена
имени; порядок гейтов, коды, `route_template()`, семантика шаблона для аудита — нетронуты.
Отклонённая альтернатива (маркер на `effective_route_context.endpoint`, без множества):
проверка на первом запросе вместо старта; второй приватный атрибут (`endpoint`) + fallback на
`scope["route"].endpoint` для app-level маршрутов; и всё равно нужен обход для теста и сервера
— то есть две реализации одной истины. Множество: одна деривация, три потребителя (гейт,
тест, сервер).

### 2.4 Прочее в pat_auth / тестах
- `PAT_ALLOWLIST` из `pat_auth.py` удаляется; докстринг модуля (п. 4 и абзац про «MCP package»)
  переписывается: «пары выводятся из маркеров, см. `mcp/exposure.py`».
- 38-парный литерал → `EXPECTED_PAT_ALLOWLIST` в `tests/test_pat_auth.py`. `TestAllowlistContract`:
  (1) прежний тест членства в openapi — по `app.state.pat_allowlist`; (2) равенство с
  `EXPECTED_PAT_ALLOWLIST`; (3) `NEVER_PAT` — список пар, которых нет: `POST/PATCH /deposits`,
  `DELETE /goals/{goal_id}/items/{item_id}`, `PATCH /profile`, 9 `/statement-imports*`,
  `GET /transactions/export`, `POST /receipts/{receipt_id}/parse`, `POST|GET /tokens`,
  `DELETE /tokens/{token_id}` — каждая пара ОБЯЗАНА существовать в openapi (опечатка в негативном
  списке не проходит молча) и отсутствовать в выведенном множестве.
- Комментарии «почему нет» переезжают к маршрутам: над `create_deposit`/`update_deposit`,
  над `delete_goal_item`, в докстринг `statement_imports` (один абзац на 9 маршрутов),
  над `export`/`parse`; `PATCH /profile` уже объяснён в докстринге роутера. Формат первой
  строки един: `# MCP: нет — <причина>`. JWT-only роутеры (`auth`, `users`, `tokens` кроме self,
  `advisor`) без зависимости `current_user_jwt_or_pat` — одна фраза в докстринге `pat_auth.py`.

### 2.5 Где живёт английская проза
- `budget_api/mcp/prose.py` — всё, что используют ≥2 инструмента: `LIMIT`, `OFFSET`, `PERIOD`,
  `MONTH`…`TO`, `MINOR_UNITS`, `CURRENCY_IN`, `CATEGORY_ID`, `ACCOUNT_ID`, `CURRENCY_FROM_ACCOUNT`,
  `KEEP`, `ORIGINAL_PAIR`/`ORIGINAL_AMOUNT`/`ORIGINAL_CURRENCY`, `RECEIPT_ID` и остальные
  константы верха `allowlist.ts` — байт-в-байт.
- Текст одного инструмента — ВНУТРИ вызова декоратора (отклонение от позиции лида «константа
  над обработчиком»): декоратор и есть правда, отдельная константа — лишнее имя и лишний
  переход глазами. Исключение: текст, общий для двух обработчиков ОДНОГО роутера, —
  модульная константа в этом роутере.
- Направление: `routers/* → budget_api.mcp.decorator, budget_api.mcp.prose`. Оба листа
  импортируют только stdlib; никогда — SDK `mcp`, `budget_api.app`, модели, сервисы.

## 3. Python-сервер (B)

### 3.1 Пакет `apps/api/src/budget_api/mcp/`
| модуль | ответственность | импортирует |
|---|---|---|
| `__init__.py` | пусто (импорт пакета не тянет SDK/приложение) | — |
| `decorator.py` | `Exposure`, `ToolSpec` (frozen), `mcp_tool`, `pat_reachable` | stdlib |
| `prose.py` | общие фрагменты описаний | stdlib |
| `exposure.py` | обход `app.routes` → `pat_allowlist`, `tool_specs` | fastapi/starlette типы, `decorator` |
| `tools.py` | порт `tools.ts`: flatten, inline `$ref`, схлопывание `anyOf`-null, `BuiltTool`, `ToolBuildError` (ошибки СОБИРАЮТСЯ), `tools_for_scope` | `decorator` |
| `http.py` | httpx.AsyncClient, `Bearer`, таймаут 30 с, аргументы → path/query/body, managed `uuid4()` на логический вызов, маппинг ошибок (тексты `http.ts`), `fetch_token_self` | `tools` |
| `truncate.py` | правило 50 000 байт, `_truncated` | stdlib |
| `upload_receipt.py` | три гейта, 10 МБ, имя/описание/схема инструмента байт-в-байт из TS | `http` |
| `server.py` | `main()`: env → `build_export_app()` → `json.loads(openapi_json(app))` → `tool_specs` → `build_tools` → upload-конфиг → `GET /tokens/self` → фильтр по scope → `Server(name="budget", version=__version__, on_list_tools, on_call_tool)` → `stdio_server()` | SDK, `openapi_export`, всё выше |
| `__main__.py` | `asyncio.run(main())` | `server` |

Порядок инструментов = порядок обхода (монтирование × объявление), не порядок таблицы TS;
семантики нет, снимок сравнивается по имени. Порядок `required` внутри инструмента —
значим и воспроизводится: параметры в порядке `parameters`, затем body-свойства в порядке
`properties` ФАЙЛА (алфавит из `sort_keys`), `required` = «в порядке properties, если имя в
`required` тела» — как в `tools.ts`, не как в массиве `required` контракта.
stdout принадлежит транспорту: логи только в stderr (`_configure_logging` уже ставит
`StreamHandler()` = stderr); `print` в пакете запрещён.

### 3.2 Источник списка инструментов: импорт приложения
- Метаданные (имя, описание, `params`, `managed_body`) есть ТОЛЬКО на функциях — их не дать
  через `/openapi.json` работающего API, не нарушив байтовое правило. Значит импорт роутеров
  неизбежен в любом варианте; вопрос лишь, откуда брать схемы.
- Работающий API: + не грузит приложение; − сетевой шаг до первого `list_tools`, − рассинхрон
  «код, который импортировал сервер» ≠ «код, который крутится на :8010» (инструмент без пары
  или пара без инструмента, невидимо), − `app.openapi()` в памяти отдаёт properties в порядке
  pydantic (факт 5) — файл алфавитный.
- Импорт: одна правда в одном процессе, герметично (факт 5), схемы = байты файла через
  `json.loads(openapi_json(app))`. Цена: sqlalchemy/anthropic/minio/apscheduler на импорте,
  ~1–2 с один раз на старт stdio — приемлемо, Claude стартует сервер один раз на сессию.
- Сборка инструментов на старте API НЕ делается: `create_app` выводит только пары (дёшево, без
  `openapi()`); дрейф `params`/`managed_body` ловят pytest и старт MCP-сервера.

### 3.3 Зависимость и запуск
- `mcp>=2.2,<3` — ОСНОВНАЯ зависимость `budget-api`. Не extra: `uv run` синхронизирует набор по
  умолчанию и снёс бы несинхронизированный extra; команда запуска не должна нести `--extra`.
  Не `<2`: прошлый мажор, 2.2 проверена дымом (факт 3); низкоуровневый `Server` с сырым
  `input_schema: dict` — ровно то, что делал TS через `setRequestHandler`. Новые транзитивные
  пакеты (`httpx-sse`, `sse-starlette`, …) — зафиксировать в отчёте по diff `uv.lock`.
- Claude Desktop:
  `{"command": "/abs/path/uv", "args": ["run", "--directory", "/abs/apps/api", "python", "-m",
  "budget_api.mcp"], "env": {"BUDGET_PAT": "...", "BUDGET_API_URL": "http://localhost:8010"}}`.
  Claude Code: `claude mcp add budget-py -e BUDGET_PAT=… -- /abs/path/uv run --directory
  /abs/apps/api python -m budget_api.mcp`. Путь к `uv` абсолютный (факт 8); `--frozen` —
  на усмотрение инженера.
- Env: `BUDGET_PAT` (обязателен), `BUDGET_API_URL` (default `http://localhost:8010`),
  `BUDGET_UPLOAD_DIR` (нет = инструмента нет). `BUDGET_OPENAPI_PATH` исчезает.

## 4. Доказательство совместимости — структура (C)
- Фикстура `apps/api/tests/fixtures/mcp_tools_snapshot.json`, снимается ОДИН раз ДО правок из
  `dist/` после `pnpm --filter @budget/mcp-server build` одноразовым node-скриптом в
  scratchpad (не коммитится; коммитится фикстура). Содержимое: `{"source": {"openapi_md5",
  "git_sha"}, "tools": [BuiltTool verbatim × 35: name, description, scope, method, path,
  inputSchema, pathParams, queryParams, bodyProps, managedBody], "upload_tool": {name,
  description, inputSchema}}`. TS verbatim, без нормализации при снятии.
- `tests/test_mcp_tools.py`: `{t.name: t.as_snapshot()}` == `{name: tool}` из фикстуры для
  всех 35 (dict-равенство: порядок ключей неважен, порядок списков `required`/`pathParams`
  значим); единственная нормализация в тесте — регистр `method`. Плюс тройка upload-инструмента.
  Совпадение `scope` для 35 = доказательство, что `scope=` выводим.
- `EXPECTED_PAT_ALLOWLIST` — §2.4. md5 `openapi.json` — ручной гейт закрытия (`md5`) поверх
  существующего дрейф-теста экспорта; нового теста не нужно.
- Claude Desktop: `budget` (node) остаётся; добавляется `budget-py`; после живой пробы
  `budget` удаляется и `budget-py` переименовывается в `budget` одной правкой (имя внутри
  процесса всегда `budget`).

## 5. Судьба `packages/mcp-server` (D)
- Подзадача удаления — ПОСЛЕ живой пробы: `git rm -r packages/mcp-server`; `turbo.json`
  строки 36–42; `pnpm-workspace.yaml` — glob, править нечего (проверить); root `package.json`
  — если есть скрипт на пакет; `.claude/agents/senior-lead.md` §«Смена контракта…»: потребителей
  ТРИ, дрейф-сторож MCP теперь в pytest `apps/api` и попадает в общий гейт; `docs/README.md`
  строка 7 (`mcp.md` = `apps/api/src/budget_api/mcp/`).
- Тесты — что выживает как pytest (по смыслу, не построчно):
  - `allowlist.test`: «каждое поле money-write курировано» (create/update_transaction,
    create/update_goal_item, add_goal_contribution, set_category_limit — описание ≠ контрактному),
    «PATCH никогда не требует опциональное», «client_id скрыт и managed», «read-токен видит
    ровно read-инструменты» — ДА. «ровно 35», «deposits только read», «required сохранён» —
    поглощены снимком и `NEVER_PAT`.
  - `tools.test`: коллизия имён параметр/тело, managed-дрейф (нет в теле / не string),
    сбор ВСЕХ ошибок, схлопывание `anyOf`-null — ДА, на синтетическом мини-документе.
    Flatten/inline happy-path — поглощён снимком.
  - `http.test`: «свой client_id на каждый логический вызов» — ДА; остальное — нет.
  - `truncate.test`: 4 теста — ДА (мелкие, поведение ломается).
  - `uploadReceipt.test`: все 7 по смыслу — ДА (task.md п. 4).
  - Новый: in-memory клиент (факт 3) — `list_tools` для `full`+upload_dir даёт 36 имён,
    `call_tool` неизвестного имени → `isError`. Один тест, заменяет SDK-glue.
  - Умирают с пакетом: `openapi.ts`-загрузчик, `BUDGET_OPENAPI_PATH`, резолв пути от `dist/`.
- `README.md` пакета → секция «Гайд пользователя» в `docs/mcp.md` (выпуск токена, оба конфига,
  SQL к `pat_audit_log`); ссылка из `docs/backend.md` (`pat_audit.py`) переезжает туда.
- `docs/mcp.md` → «MCP из декоратора»: правила маркера (§2.1), деривация, пакет (§3.1), запуск,
  снимок и тесты, гайд. `docs/backend.md`: bullet `pat_auth.py` (множество из `app.state`),
  `/tokens`, `/receipts` (`@pat_reachable`), новый bullet `mcp/`.
- Правило грумминга (`grooming-workflow/SKILL.md` §«Каждый новый эндпоинт…»): «на каждом новом
  обработчике либо `@mcp_tool(...)` (scope виден по методу, описание курируется на грумминге),
  либо `@pat_reachable(reason=)`, либо `# MCP: нет — <причина>` над `async def`. Новое поле
  существующего инструмента → строка в `params` того же декоратора; сторож —
  `apps/api/tests/test_mcp_tools.py`, общий pytest-гейт».

## 6. Направление зависимостей и инварианты (E)
```
routers/*  ──►  mcp.decorator, mcp.prose        (листья, stdlib)
app.py     ──►  mcp.exposure ──► mcp.decorator  (обход при create_app → app.state.pat_allowlist)
pat_auth   ──►  request.app.state               (mcp.* НЕ импортирует)
mcp.server ──►  SDK mcp, openapi_export ──► app ──► routers ──► mcp.decorator   (цикла нет: __init__ пуст)
mcp.tools / http / truncate / upload_receipt  ──► decorator / tools   (чистые, без app и SDK)
```
Деньги/user_id/no-oracle не затронуты: меняется только ИСТОЧНИК множества пар, не порядок
гейтов и не коды; равенство с 38 парами доказывает тот же периметр; сервер передаёт тела
сквозняком (арифметики нет, как в TS), 404 остаётся «not found (missing or not yours)»;
`pat_audit.py` и `route_template()` не правятся.

## 7. Риски по убыванию (F)
1. **Приватный API FastAPI в обходе** — ловится дважды: `TypeError` на незнакомом типе
   (§2.2) + тест «все пары openapi ⊆ пары обхода». Апгрейд FastAPI валит suite, не гейт.
2. **`mcp` 2.x свежий** — низкоуровневый `Server`, узкая поверхность (list/call + stdio);
   pin `<3`; дым уже пройден.
3. **Импорт приложения в stdio-процессе** — любой stdout при импорте рвёт JSON-RPC. Тест:
   `build_export_app()` + сборка инструментов пишут в stdout ноль байт (capsys). ~1–2 с старта.
4. **`uv` не в PATH GUI** — абсолютный путь в конфиге; строка в гайде.
5. **pyright strict vs типы SDK** — `Protocol` для обхода; для SDK при нужде точечный
   `# pyright: ignore[...]` с причиной, не глобальное ослабление.
6. **Объём прозы в роутерах** (~150 строк в transactions.py) — общее в `prose.py`; цена
   принята: правда рядом с кодом дороже компактности.
7. **Двойной запуск** — два сервера, один токен, общий rate limit (60/20 в минуту на токен):
   на время пробы в клиенте включён ОДИН из них; после пробы TS удаляется (§4).

## 8. Что здесь НЕ решено
Точная сигнатура `Protocol` обхода; форма `as_snapshot()`; респонсы ошибок httpx
(`MockTransport` vs respx); `--frozen`; текст `reason` у трёх `pat_reachable`; разбиение на
подзадачи и оценки — лид и backend-engineer.
