# review-s1-s2.md — code review скоупа `mcp-decorators` (S1+S2, FULL)

Ревью КОДА, гейты не перезапускались. Проба одна: семантика `httpx.Response.is_error`
и `follow_redirects` (см. MAJOR-1).

## BLOCKER — нет

## MAJOR

### MAJOR-1 — 3xx от хранилища читается как успешная загрузка
`apps/api/src/budget_api/mcp/upload_receipt.py:278` (`if put.is_error:`) и `:190`
(`_fetch_json`).

`httpx.Response.is_error` — это `400 <= status <= 599`. Проверено:
`httpx.Response(307).is_error is False`, `httpx.AsyncClient().follow_redirects is False`.
TS проверял `!response.ok` (успех = 200–299) И `fetch` редиректы СЛЕДУЕТ. Порт совпадает с
TS на 2xx/4xx/5xx и расходится на 3xx: presigned PUT, ответивший 307 (регион S3, прокси
http→https перед MinIO), проходит как выгруженный, поток читает строку обратно и возвращает
`Ok` — ассистент говорит «чек загружен», объекта в хранилище нет, а `receipt_id` уже уехал
в `create_transaction`. Тихая потеря данных, единственное такое место в скоупе.

Тот же класс в `_fetch_json:190`: 3xx от API → не `is_error` → `response.json()` на теле
редиректа → «…a body that is not JSON.» Сообщение врёт про причину, но хотя бы не молчит.

Фикс: `if not put.is_success:` и `if not response.is_success:` (200–299 — как `send()` в
`http.py:174` уже делает; внутри одного PR два разных правила про одно и то же). Отдельно
решить про `follow_redirects=True` на клиенте `server.py:187`: без него порт не эквивалентен
`fetch` ни для API, ни для хранилища, и если «не следуем» — решение, оно должно быть
комментарием рядом с клиентом, а не следствием дефолта httpx. Тест: PUT-хендлер
`MockTransport` с 302 → ожидаем `Err`.

## MINOR

### MINOR-1 — половина стартовых сбоев теряет свою фразу
`apps/api/src/budget_api/mcp/server.py:183` ловит только `(ConfigError, ToolBuildError)`.
`parse_document` (`tools.py`) поднимает `OpenApiError` — это первоклассный ожидаемый сбой
старта (контракт без `paths`), и он улетает трейсбеком вместо предложения оператору;
докстринг `server.py` при этом обещает «Each step fails with a sentence the operator can act
on». В TS `main().catch(...)` был тотальным. Фикс: добавить `OpenApiError` в кортеж (или
поймать `Exception` вокруг блока старта, как TS).

### MINOR-2 — `uv.lock`: что реально приехало в прод-образ API
Безусловно: `httpx2` 2.13 + `httpcore2` + `truststore` (ВТОРОЙ HTTP-стек рядом с httpx
0.28), `sse-starlette` 3.4.11, `opentelemetry-api` 1.44, `jsonschema` 4.26 (+`attrs`,
`referencing`, `rpds-py`, `jsonschema-specifications`), `mcp`/`mcp-types` 2.2.0.
Платформенно закрыты, вопросов нет: `pywin32` (`win32`), `httpx2-jsfetch` (`emscripten`).
Решение «основная зависимость» принято в architecture §3.3 — фиксирую цену (plan §I просил
назвать diff): ради stdio-процесса, который в проде не запускается, образ API получил
второй мажор httpx и SSE-сервер.

### MINOR-3 — вне скоупа: `apps/mobile/tsconfig.json`
Правка, к скоупу отношения не имеющая: из `include` убраны `.expo/types/**/*.ts` и
`expo-env.d.ts` — корни типов Expo; без них `tsc` мобилки теряет декларации роутера.
Гейты S1/S2 мобилку не трогали, поломка (если она есть) всплывёт на `pnpm turbo typecheck`
в S3. Откатить или объяснить.

### MINOR-4 — `docs/backend.md:22` стал неправдой в S1
«механикой fail-closed allowlist (`pat_auth.py` пары просто не добавлены)» — пар в
`pat_auth.py` больше нет. Формально это S3 (plan §A), но соврала дока именно правка S1.
Строка 35 и `docs/README.md:7` ссылаются на `packages/mcp-server` — это честно S3.

### MINOR-5 — вакуумный ассерт
`apps/api/tests/test_mcp_tools.py:138`:
`assert [t.name for t in tools if t.method != "GET"] == WRITE_TOOLS`. `scope_of` определён
как «read если GET иначе write», а строка 137 уже пинит `scope == "write"` по именам —
третий ассерт повторяет второй по построению и не может упасть отдельно. Ровно тот случай,
который запрещён правилом проекта про тесты; удалить. Сама растяжка READ/WRITE (PM-решение
1) работает: новый инструмент не собирается, пока автор не вписал имя в один из списков.

### MINOR-6 — `capsys`-тест не ловит то, что обещает
`apps/api/tests/test_mcp_server.py:344`, докстринг «A banner printed by any import on this
path». Импорты `budget_api.openapi_export` и цепочки роутеров происходят на сборе тестов,
задолго до `capsys`. Реально пинится только вывод во время `build_export_app()` + сборки
инструментов (тоже полезно). Поправить докстринг — либо подпроцесс
`python -c "import budget_api.mcp.server"` с проверкой пустого stdout.

## NIT

1. `tools.py:188,241,306` — тексты ошибок дрейфа разошлись с TS: `{...!r}` вместо
   `JSON.stringify` (`'integer'` vs `"integer"`, `None` vs `undefined`). Зафиксировано
   тестом (`test_mcp_tools.py:263`), в «дословный» список plan §E не входит — оставить
   сознательно или выровнять.
2. `tools.py:319` — `parameter.get("schema") or {}` против `??` в TS: присутствующая, но
   falsy схема молча подменяется на `{}` вместо «expected a schema object».
3. `http.py:236` — `quote(v, safe="")` экранирует `!'()*`, `encodeURIComponent` — нет; на
   проводе эквивалентно, действий не требует. `_query_value` (bool → `true`/`false`) —
   наоборот, необходимая правка против `str(True)`.
4. `exposure.py:68` — `RouteExposure.endpoint` не читает никто; `:41` `RouteContextLike`
   помечен `@runtime_checkable`, но в `isinstance` не используется.
5. `transactions.py:249` и `:837` — «What was charged TO THE ACCOUNT, in the ACCOUNT's
   currency. » продублирована в двух декораторах ОДНОГО роутера. В TS так же, но
   architecture §2.5 требует для этого случая модульную константу.
6. `as_object`/`as_array` живут в `tools.py`, читают их `http.py` и `upload_receipt.py`.

## Что осталось непокрытым (называю, писать не предлагаю)

- 3xx от хранилища и от API (MAJOR-1) — ни одного теста.
- `describe_api_error` целиком: `CODE_MESSAGES`, ветка `*_NOT_FOUND`, список `detail`, 429
  без detail. Это фразы, которые читает пользователь; опечатка в транскрипции невидима до
  живого сбоя. Дешевле всего один параметризованный тест на пять входов.
- Защита от циклического `$ref` (`tools.py:193`) и обе ветки `_resolve_ref`.
- `read_api_config`: срез хвостовых слэшей и дефолт `BUDGET_API_URL`.

## Проверено и претензий нет

Allowlist fail-closed по построению: `pat_auth.py:238` `getattr(..., frozenset())` без
`app.state` даёт пустое множество (403 на всё); `app.py:350` считает множество ПОСЛЕ
последнего `include_router`; немаркированный маршрут пары не даёт; HEAD/OPTIONS исключены
явно (`exposure.py:36`) — HEAD по маркированному GET получает 403 без оракула; незнакомый
контейнер маршрутов → `TypeError` и падение `create_app`. Все 38 маркеров стоят ВПЛОТНУЮ над
`async def` (проверено обходом всех роутеров), включая `POST /receipts` под
`@_limiter_any.limit`. Порядок и коды гейтов, `route_template()` не тронуты; `pat_audit.py`
в `git diff --stat` отсутствует. В пакете нет ни `print`, ни `pyright: ignore`.
`EXPECTED_PAT_ALLOWLIST` = 38, `NEVER_PAT` = 19, каждая пара обязана существовать в
контракте. `prose.py`: число ссылок на КАЖДУЮ из 31 общей константы совпадает с
`allowlist.ts` один в один — инлайн-дублей на месте общих нет. `truncate.py` (компактный
`json.dumps`, тот же цикл), порядок `required`, схлопывание `anyOf`-null, сбор ВСЕХ ошибок,
`managed uuid` один раз на логический вызов, три гейта upload (`resolve(strict=True)`,
`is_inside` с сепаратором, магия JPEG, 10 МБ), снятие блокирующего IO в `anyio.to_thread` —
верны. Фикстура: `openapi_md5` = `8594381c51613ad89237be526f9f7b17` совпадает с текущим
`openapi.json`, 35 инструментов, 20 read.

**Вердикт: ПРИНЯТЬ ПОСЛЕ ФИКСА MAJOR-1** (0 BLOCKER / 1 MAJOR / 6 MINOR / 6 NIT).
MINOR-3 требует ответа до S3, остальные MINOR/NIT — на усмотрение лида.
