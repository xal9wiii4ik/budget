# Implementation Plan: mcp-decorators — allowlist и MCP-инструменты из декоратора

Факты — `task.md`, решения — `architecture.md`, пробы — `qa-checklist.md`. Здесь только КАК.

## Approach
Маркер `__mcp_exposure__` на функции-обработчике; один обход `app.routes` в `create_app` даёт
(а) `app.state.pat_allowlist` для гейта, (б) `ToolSpec`-и для сервера. Схемы строятся портом
`tools.ts` из `json.loads(openapi_json(build_export_app()))` — байты ФАЙЛА (факт 5), не
`app.openapi()`. Совместимость доказывается снимком собранного TS (§S0) до первой правки.
Порядок: снимок → декоратор+обход+маркеры → сервер+тесты+STOP-probe → удаление TS и доки.
**S1 и S2 — одна непрерывная линия одного инженера**: контекст общий, чистые модули S2 зависят
только от формы `ToolSpec`, а граница стоила бы перечитывания роутеров заново.

## A. Разбиение
### S0 — снимок TS (первый шаг S1, ДО любой правки; скрипт в scratchpad, не коммитится)
`pnpm --filter @budget/mcp-server build` (dist от 26.08 старее src — факт 1), затем `snap.mjs`:
```js
import {readFileSync, writeFileSync} from 'node:fs'; import {createHash} from 'node:crypto';
const P='/Users/nikitazaretski/work/budget/packages/mcp-server/dist/';
const {ALLOWLIST}=await import(P+'allowlist.js'); const {loadOpenApiDocument}=await import(P+'openapi.js');
const {buildTools}=await import(P+'tools.js'); const U=await import(P+'uploadReceipt.js');
const tools=buildTools(loadOpenApiDocument({}),ALLOWLIST);
const read=tools.filter(t=>t.scope==='read').length;
if(tools.length!==35||read!==20) throw new Error(`got ${tools.length}/${read}, want 35/20`);
const raw=readFileSync('apps/api/openapi.json'); const h=a=>createHash(a).update(raw).digest('hex');
writeFileSync('apps/api/tests/fixtures/mcp_tools_snapshot.json', JSON.stringify({source:{openapi_md5:h('md5'),
 openapi_sha256:h('sha256'),git_sha:process.env.GIT_SHA??''},tools,upload_tool:{name:U.UPLOAD_TOOL_NAME,
 description:U.UPLOAD_TOOL_DESCRIPTION,inputSchema:U.UPLOAD_TOOL_INPUT_SCHEMA}},null,2)+'\n');
```
Проверка глазами: `jq '.tools|length, ([.tools[]|select(.scope=="read")]|length)'` → `35, 20`;
`.source.openapi_md5 == 8594381c51613ad89237be526f9f7b17`. Коммитится только фикстура.

### S1 (FULL) — декоратор, обход, 38 маркеров, гейт
`mcp/decorator.py`, `mcp/prose.py`, `mcp/exposure.py`; вызов обхода в `create_app`; `pat_auth.py`
на `app.state.pat_allowlist` (литерал удалён, докстринг п.4 переписан); 35 `@mcp_tool` + 3
`@pat_reachable` + 6 комментариев `# MCP: no — …` по карте §B; тесты §F. `POST /receipts` под
`@_limiter_any.limit` покрыт равенством 38 пар — отдельного теста не надо. `openapi.json` не
меняется: пинит существующий дрейф-тест экспорта плюс md5 руками.

### S2 (FULL) — Python-сервер (продолжение S1 тем же инженером)
`mcp/{tools,http,truncate,upload_receipt,server,__main__}.py`; `pyproject`: `mcp>=2.2,<3` в
ОСНОВНЫЕ зависимости, `uv lock`. `[project.scripts]` — НЕТ: единственная точка входа
`python -m budget_api.mcp` (так в architecture §3.3, в qa-checklist и в конфиге Claude);
console-script работал бы только внутри venv и дал бы вторую команду для синхронизации.
Тесты §F, затем STOP-probe D1-1…D1-7 (qa-engineer).

### S3 (STANDARD) — удаление TS и доки (после зелёного блока 1)
`git rm -r packages/mcp-server`; `turbo.json` строки 36–42 (оба блока `@budget/mcp-server#*`);
`pnpm-workspace.yaml` (glob — проверить, что править нечего) и root `package.json` (скрипты).
Доки: `docs/mcp.md` переписать ≤150 («MCP из декоратора»: маркер, деривация, пакет, запуск,
снимок, тесты, ссылка на MCP.md); `docs/backend.md` — bullet `pat_auth.py` (множество из
`app.state`), `/tokens` и `/receipts` = `@pat_reachable`, новый bullet `mcp/`;
`docs/README.md` строка 7 → `mcp.md (apps/api/src/budget_api/mcp/)`; PLAN.md строка 54
(24 → 35 инструментов, пакет → `apps/api`). **Оверрайд лида:** гайд пользователя =
`apps/api/MCP.md` (≤200 строк, из `packages/mcp-server/README.md`, команды новые), НЕ секция в
`docs/mcp.md`. `.claude/**` и `skills_change.md` инженер НЕ правит — даёт тексты ниже, применяет
оркестратор на закрытии. Затем FINAL F-1…F-5.
**Тексты для оркестратора.** `grooming-workflow/SKILL.md` §222, замена абзацев «Форма ответа…» и
«Так же для новых ПОЛЕЙ…»: «Форма ответа для КАЖДОГО нового маршрута — маркер В КОДЕ, вплотную
над `async def`: `@mcp_tool(name=…, description=…)` (scope выводится из метода: GET = `read`,
иначе нужен `full`), либо `@pat_reachable(reason=…)` — токену доступно, инструментом не
является, либо комментарий `# MCP: no — <причина>`. Немаркированный маршрут недоступен токену по
построению (fail-closed) и невидим в MCP. Новое ПОЛЕ существующего маршрута всплывает в
инструменте автоматически: курируемое описание — строкой в `params=` того же декоратора. Сторож —
`apps/api/tests/test_mcp_tools.py`, он в общем pytest-гейте `apps/api`.»
`senior-lead.md` §206: «потребителей ЧЕТЫРЕ» → «ТРИ (`apps/web`, `apps/mobile`,
`packages/api-client`); дрейф-сторож MCP переехал в pytest `apps/api` (`test_mcp_tools.py`) и
ловится общим гейтом бэкенда — отдельный прогон не нужен».
`skills_change.md` — запись «2026-09-… — MCP-маркер вместо трёх источников правды»: что (форма
маркера, сторож в pytest, `packages/mcp-server` удалён), почему (три источника расходились:
`PAT_ALLOWLIST`, `allowlist.ts`, правило грумминга).

## B. Карта маркеров (путь = ПОЛНЫЙ шаблон; метод и путь берутся из маршрута, не из аргументов)
- `transactions.py`: `list_transactions`→list_transactions GET /transactions · `summary`→get_transactions_summary GET /transactions/summary · `create_transaction`→create_transaction POST /transactions (`managed_body={"client_id":"uuid"}`) · `update_transaction`→update_transaction PATCH /transactions/{transaction_id} · `delete_transaction`→delete_transaction DELETE /transactions/{transaction_id} · `export_transactions` → `# MCP: no — streaming CSV, nothing to curate`
- `categories.py`: `list_categories`→list_categories GET /categories · `create_category`→create_category POST /categories · `update_category`→update_category PATCH /categories/{category_id}
- `accounts.py`: `list_accounts`→list_accounts GET /accounts · `create_account`→create_account POST /accounts · `update_account`→update_account PATCH /accounts/{account_id}
- `deposits.py`: `list_deposits`→list_deposits GET /deposits · `get_deposit`→get_deposit GET /deposits/{deposit_id} · `create_deposit`/`update_deposit` → `# MCP: no — …` (минт денежной сущности с теневым счётом / override серверной цифры процентов)
- `goals.py`: `list_goals`→list_goals GET /goals · `get_goal`→get_goal GET /goals/{goal_id} · `goal_progress`→get_goal_progress …/progress · `list_contributions`→list_goal_contributions …/contributions · `create_goal`→create_goal POST /goals · `update_goal`→update_goal PATCH /goals/{goal_id} · `create_contribution`→add_goal_contribution POST /goals/{goal_id}/contributions
- `goal_items.py`: `list_goal_items`→get_goal_plan GET /goals/{goal_id}/items · `list_upcoming_deadlines`→list_upcoming_goal_deadlines GET /goals/upcoming · `create_goal_item`→create_goal_item POST /goals/{goal_id}/items · `update_goal_item`→update_goal_item PATCH /goals/{goal_id}/items/{item_id} · `delete_goal_item` → `# MCP: no — cascades over the subtree and the user's files`
- `limits.py`: `list_limits`→list_limits GET /limits · `set_limit`→set_category_limit PUT /limits/{category_id}
- `recurring.py`: `list_templates`→list_recurring GET /recurring · `list_upcoming`→list_upcoming_recurring GET /recurring/upcoming · `create_template`→create_recurring POST /recurring · `update_template`→update_recurring PATCH /recurring/{template_id}
- `stats.py`: `stats_summary`→get_stats_summary · `stats_monthly`→get_stats_monthly · `stats_top_merchants`→get_top_merchants (GET /stats/summary|/monthly|/top-merchants)
- `fx.py`: `convert`→convert_currency GET /fx/convert
- `profile.py`: `read_profile`→get_profile GET /profile; `update_profile` → `# MCP: no — cascading base-currency change, app decision` (уже объяснён в докстринге роутера)
- `receipts.py`: `create_receipt` → `@pat_reachable(reason="upload_receipt creates the row itself; it is not a tool")` · `get_receipt` → `@pat_reachable(reason="upload_receipt reads the row back; it is not a tool")` · `parse_receipt` → `# MCP: no — spends the user's AI budget`
- `tokens.py`: `read_token_self` → `@pat_reachable(reason="startup introspection: the server asks its own scope; not a tool")`; остальные `/tokens` — JWT-only, без маркера
- `statement_imports.py`: один абзац в докстринге МОДУЛЯ на все 9 маршрутов (комментарий над каждым — шум)
- `auth`, `users`, `advisor`, `goal_item_files`, `health` — маркеров нет (нет `current_user_jwt_or_pat`); одна фраза про это в докстринге `pat_auth.py`

## C. Файлы и формы данных
**S1.** `mcp/__init__.py` — пусто (импорт пакета не тянет ни SDK, ни приложение).
`mcp/decorator.py` — `ManagedBodyValue = Literal["uuid"]`; `ToolSpec(frozen)`: `name: str`,
`description: str`, `params: Mapping[str,str]`, `managed_body: Mapping[str,ManagedBodyValue]`
(обе — `MappingProxyType`, по умолчанию пустые); `Exposure(frozen)`: `tool: ToolSpec|None`,
`reason: str|None`; `mcp_tool(*, name, description, params=None, managed_body=None)` и
`pat_reachable(*, reason)` ставят `fn.__mcp_exposure__` (повторное навешивание → `TypeError`);
`exposure_of(fn) -> Exposure|None`.
`mcp/prose.py` — общие константы верха `allowlist.ts` (LIMIT, OFFSET, PERIOD, MONTH…TO,
MINOR_UNITS, CURRENCY_IN, CATEGORY_ID, ACCOUNT_ID, CURRENCY_FROM_ACCOUNT, KEEP, ORIGINAL_PAIR/
AMOUNT/CURRENCY, RECEIPT_ID, COUNTRY, TX_*, GOAL_ITEM_*, REMIND_SWITCH) — байт-в-байт. Текст
одного инструмента — внутри вызова декоратора (architecture §2.5).
`mcp/exposure.py` — `RouteLike`/`RouterLike` (`typing.Protocol`, приватный `_IncludedRouter` не
импортируется); `RouteExposure(frozen)`: `method`, `path`, `endpoint`, `exposure`;
`walk(app) -> tuple[tuple[str,str],...]` (ВСЕ пары, для tripwire), `collect(app)`,
`pat_allowlist(app) -> frozenset[tuple[str,str]]`, `tool_specs(app)`. HEAD/OPTIONS исключаются
ЯВНО: таких операций нет ни в контракте, ни в 38-парном литерале, иначе поверхность токена тихо
шире прокомментированного множества. Незнакомый тип маршрута → `TypeError` (fail-closed).
`app.py` — после последнего `include_router`: `app.state.pat_allowlist = pat_allowlist(app)`
(синхронно, не в lifespan) + две строки комментария. `pat_auth.py` — `PAT_ALLOWLIST` удалён, гейт
читает `request.app.state.pat_allowlist`; порядок гейтов, коды, `route_template()` не тронуты.
**S2.** `mcp/tools.py` — `BuiltTool(frozen)`: `name, description, scope: Literal["read","write"],
method, path, input_schema: dict[str,Any], path_params/query_params/body_props: tuple[str,...],
managed_body: Mapping[str,str]`; `as_snapshot()` → ключи TS-регистра `{"name","description",
"scope","method": method.lower(),"path","inputSchema","pathParams": list(…),"queryParams": list(…),
"bodyProps": list(…),"managedBody": dict(…)}` — регистр метода единственная нормализация;
`ToolBuildError(Exception)` с `errors: tuple[str,...]`; `build_tools(document, specs)`,
`tools_for_scope(tools, scope)`. `mcp/http.py` — `ApiConfig`, `ConfigError`, `read_api_config`,
`ApiResult = Ok(data) | Err(message)`, `describe_api_error`, `build_request_body`, `call_tool`,
`fetch_token_self`, один `httpx.AsyncClient` на процесс. `mcp/truncate.py` — `THRESHOLD_BYTES=
50_000`, `TRUNCATION_NOTE` (байт-в-байт), `truncate_response`. `mcp/upload_receipt.py` —
`MAX_UPLOAD_BYTES`, `UploadConfig`, `read_upload_config`, `is_jpeg`, `is_inside`,
`resolve_upload_path`, `upload_receipt`, `UPLOAD_TOOL_*` (имя/описание/схема байт-в-байт).
`mcp/server.py` — `main()`; `mcp/__main__.py` — `asyncio.run(main())`.
`tests/fixtures/mcp_tools_snapshot.json` — из S0.

## D. Порт `tools.ts` — чек-лист верности (документ = `json.loads(openapi_json(build_export_app()))`)
- `title` удаляется ВСЕГДА, на каждом уровне; рекурсия в `properties` и в `items`.
- `$ref` инлайнится; у компонента выбрасываются `title` и `description`, ключи ССЫЛАЮЩЕГОСЯ узла
  накладываются сверху и побеждают; повторный `$ref` в цепочке → ошибка «circular».
- Резолвится только `#/components/schemas/*`; иной префикс или неизвестное имя → ошибка.
- `anyOf`: ветки `{"type":"null"}` отбрасываются; осталась одна → схлопывание в неё с сохранением
  ключей-соседей; осталось >1, но меньше исходного → ПЕРЕЗАПИСЬ `anyOf` нормализованными
  ветками (частичный случай); не изменилось — не трогаем.
- `format/pattern/enum/minimum/maximum/default` переживают — никакого whitelist-фильтра.
- `description` параметра ставится в схему ТОЛЬКО если у схемы своего нет.
- `params=` перезаписывает `description` уже собранного свойства; имя, которого операция не
  принимает → ошибка. Коллизия «параметр ↔ свойство тела» → ошибка с обеими сторонами в тексте.
- `in` ∉ {path, query} → ошибка; кривая запись параметра → ошибка; тело без
  `application/json`-схемы или не объект → ошибка.
- `managed_body`: свойство НЕ попадает ни в схему, ни в `body_props`; `uuid` требует
  `type == "string"`, иначе ошибка; имя, которого в теле нет → ошибка.
- Дубликат имени инструмента → ошибка, инструмент пропускается.
- Порядок `required`: параметры в порядке `parameters`, затем свойства тела в порядке
  `properties` ФАЙЛА (алфавит из `sort_keys`), фильтр по множеству `required` тела. НЕ порядок
  массива `required` контракта и НЕ сортировка.
- `scope` = `read` при GET, иначе `write` (architecture §2.1). ВСЕ ошибки собираются, одно
  исключение в конце, шапка сообщения — из TS дословно.

## E. `http.py` / `server.py` — поведение
Порядок старта: `read_api_config(os.environ)` → `build_export_app()` →
`json.loads(openapi_json(app))` → `tool_specs(app)` → `build_tools` → `read_upload_config` →
`fetch_token_self` → `tools_for_scope` → `Server(name="budget", version="0.1.0", on_list_tools=,
on_call_tool=)` → `stdio_server()` → строка в stderr `budget-mcp: ready — N tools, token scope
"…", API …, uploads …`. Любой сбой старта → одно сообщение в stderr и `exit(1)`.
Дословно из TS (это читает пользователь): «BUDGET_PAT is not set — …», «BUDGET_UPLOAD_DIR must be
an absolute path, got "…"», «BUDGET_UPLOAD_DIR points at "…", which does not exist.», «GET
/tokens/self did not answer with {id, scope} — …», шапка `ToolBuildError`, все сообщения
`upload_receipt`.
Маппинг ошибок: `TOKEN_INVALID`/`TOKEN_SCOPE_READONLY`/`TOKEN_ENDPOINT_FORBIDDEN`/`RATE_LIMITED`
— по таблице TS; `*_NOT_FOUND` → «<code>: not found (it does not exist, or it is not yours).»;
прочий строковый detail → «The Budget API rejected the call (HTTP N): …»; список detail → «The
Budget API rejected the arguments:\n  - loc: msg»; 429 без detail → RATE_LIMITED; иначе «The
Budget API returned HTTP N: …» (тело ≤500 символов, пустое → «(empty body)»). Транспорт/таймаут →
«…did not answer within 30s.» / «Cannot reach the Budget API at … — is the server running?».
Таймауты: 30 с на вызовы API (включая `POST /receipts` и `GET /receipts/{id}`), 60 с на PUT в
хранилище. `call_tool`: пустой path-параметр → `Missing required argument "…"`; `None` в query
пропускается; managed uuid генерируется ОДИН раз на логический вызов в `build_request_body`;
отсутствующий аргумент тела остаётся отсутствующим (для PATCH это «keep»). Ответ: `Err` →
`is_error=True` + текст; `Ok` → `json.dumps(truncate_response(data))` одним text-блоком;
неизвестное имя → `is_error=True`, `Unknown tool "…".`. `upload_receipt` публикуется только при
`scope == "full"` И заданном каталоге. Логи только в stderr, `print` в пакете запрещён.

## F. Тесты (одна строка — что ломается, если красный)
`tests/test_mcp_exposure.py` (S1): `openapi_pairs_are_a_subset_of_walked_pairs` — апгрейд FastAPI
поменял семантику обхода и часть маршрутов невидима; `unknown_route_container_raises` — кто-то
смягчил fail-closed, незнакомый контейнер теряется молча.
`tests/test_pat_auth.py::TestAllowlistContract` (S1): равенство с `EXPECTED_PAT_ALLOWLIST` (38) —
маркер потерян/лишний/не пережил `functools.wraps` (`POST /receipts`) или путь без префикса;
существующий `…_exists_in_the_exported_openapi` на `app.state` — маршрут переименован, пара
повисла; `never_pat_pairs_exist_and_stay_unreachable` — «никогда»-пара просочилась, и каждая пара
списка обязана быть в openapi (опечатка в негативном списке видна сразу).
`tests/test_mcp_tools.py` (S2): `tools_match_the_typescript_snapshot` — расхождение имени,
описания, схемы, scope или порядка `required`/`pathParams` с тем, что клиент видел вчера;
`upload_tool_matches_the_snapshot` — то же для рукописного инструмента;
`every_money_write_field_is_curated` — контракт вырастил денежное поле без описания, модель
угадывает; `patch_never_requires_an_optional_field` — нормализация сделала nullable обязательным;
`client_id_is_managed_and_invisible` — ключ идемпотентности стал видимым или потерялся;
`read_token_sees_only_read_tools` — read-токену опубликовали write. На синтетическом мини-
документе: `collects_every_error_at_once` (коллизия + header-параметр + managed-дрейф + дубликат
имени в ОДНОМ исключении), `managed_property_must_be_a_string`, `managed_name_absent_in_body`,
`curated_param_unknown_to_the_operation`, `anyof_null_collapse_including_the_partial_case`.
Happy-path flatten/inline поглощён снимком — отдельных тестов нет.
`tests/test_mcp_server.py` (S2): `managed_uuid_is_generated_per_logical_call` — общий `client_id`
превратил бы вторую транзакцию в реплей первой; truncate ×4 (под порогом не трогаем, режется
самый длинный массив, голый массив → `{items,_truncated}`, один элемент остаётся всегда);
upload ×7 по смыслу из `uploadReceipt.test.ts` (магия JPEG на PNG-с-.jpg и на обрезанном
заголовке; `is_inside` не пускает соседа `uploads-evil`; каталог не задан → инструмента нет;
относительный `BUDGET_UPLOAD_DIR` → ошибка старта; `..` наружу; симлинк наружу; нет файла →
внятный ответ, а не падение); `in_memory_client_lists_and_calls`
(`create_client_server_memory_streams` + `ClientSession`: 36 имён при full+каталог, неизвестное
имя → `isError`) — склейка с SDK; `building_the_app_and_tools_writes_nothing_to_stdout` (capsys,
оверрайд лида) — любой `print`/баннер на импорте рвёт JSON-RPC, и это видно только у пользователя.
Ответы API мокаются `httpx.MockTransport` — новых зависимостей не появляется.

## G. Гейты
Каждая подзадача: `cd apps/api && uv run ruff check . && uv run ruff format --check .`,
`uv run pyright`, `uv run pytest`. Прогоны pytest СЕРИАЛИЗОВАНЫ — одна полная сюита за раз на
тестовой БД, параллельно с чужим прогоном не запускать. S0 и закрытие: `md5 apps/api/openapi.json`
= `8594381c51613ad89237be526f9f7b17` до и после. S3 дополнительно: `pnpm install && pnpm turbo
lint typecheck test` из корня. `make` в проекте нет — команды as is.

## H. Оценки (агент-минуты: письмо / гейты / верификация+фиксы)
S0 — 10 / 2 / 5, ~15–25k токенов. S1 — 90 / 20 / 30 (циклы ожидаю на префиксах путей,
`Protocol` под pyright, порядке декораторов у `POST /receipts`), ~180–260k. S2 — 120 / 25 / 45
(циклы: порядок `required`, схлопывание `anyOf`, типы SDK под pyright; STOP-probe — отдельная
роль), ~220–320k. S3 — 40 / 25 / 20 (`pnpm turbo` после удаления, объём доков), ~80–140k.
Итого ~430 агент-минут плюс живые пробы QA.

## I. Риски, которыми владею (сверх architecture §7)
- `uv.lock`: `mcp` тянет `httpx-sse`, `sse-starlette` и соседей — `uv lock` один раз, diff назвать
  в отчёте; влияние на прод-образ ловят `uv run pytest` и старт API на 8021 в пробе.
- pyright strict против типов SDK (`types.Tool`, сигнатуры колбэков) — точечный
  `# pyright: ignore[…]` с причиной; глобальных послаблений в `pyproject` не делаем.
- `Protocol` обхода: возвраты `effective_route_contexts()` для pyright Unknown → один `cast` в
  `exposure.py`, а не `Any` по всему модулю.
- Порядок `required` — самая вероятная причина красного снимка; при расхождении сверяем с TS, а не
  «нормализуем» тест.
- Документные `Route` приложения несут `HEAD` — исключение HEAD/OPTIONS обязательно, иначе
  равенство 38 пар падает на ровном месте.
- Объём прозы: `ruff format` переносит длинные строки — перенос не должен менять байты (неявная
  конкатенация строковых литералов).
- `--frozen` в командах ЗАПУСКА клиента — ДА: `uv run --frozen --directory <abs>/apps/api python
  -m budget_api.mcp`. GUI-запуск не должен ни переписывать `uv.lock` в рабочем дереве, ни висеть
  на резолве за captive-сетью, а расхождение окружения с локом обязано падать внятной ошибкой на
  старте, а не тихо ставить другую версию `mcp` под инструментами, которые модель уже видит.
  В командах разработчика и QA `--frozen` НЕ используем — там новая зависимость обязана доехать.

## J. Не меняем
Байты `apps/api/openapi.json`; `pat_audit.py`; `route_template()`; порядок гейтов
`current_user_jwt_or_pat` и их коды (`TOKEN_INVALID`/`RATE_LIMITED`/`TOKEN_ENDPOINT_FORBIDDEN`/
`TOKEN_SCOPE_READONLY`); четыре группы «никогда не MCP» (импорт выписок ×9, вклады POST/PATCH,
DELETE пункта плана, PATCH профиля) и исторические исключения; число инструментов 35 (20 read +
15 write) — новых не добавляем. Все новые комментарии, `reason=` и маркеры `# MCP: no — …` —
по-английски (RUF003).

## Open questions
Блокирующих нет. Тексты трёх `reason=` даны в §B и правятся на ревью без последствий.
