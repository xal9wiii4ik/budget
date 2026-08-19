# QA Checklist: mcp-server (PLAN 5.6) — grooming artifact, НИЧЕГО не прогоняется сейчас

## Scope
Живой слой поверх S1–S5: PAT-auth по настоящему HTTP, scope/метод/path-гейты, rate
limit, MCP stdio через настоящий Claude Code. Браузерная часть S2 — **web-qa** (я лишь
потребляю выпущенный токен). Мобилка не затрагивается.

**Split rule.** Не дублируем живьём то, что закрывает pytest S1 (`plan.md` ещё не
написан — при появлении сверить номера): hash-lookup, no-oracle `TOKEN_INVALID`
(missing == revoked байт-в-байт), дебаунс `last_used_at`, CHECK `scope`, матрица
метод×scope, «PAT-ветка не ломает JWT-путь», contract-drift. Юниты S3/S4 закрывают:
усечение >50KB, fail-fast на allowlist-пути, генерацию схем (вкл. исключение `client_id`
из inputSchema). Идемпотентность `client_id` (повтор ⇒ одна строка, 200) — **закрыто
pytest B-1** (`.tasks/mobile-offline/plan.md`), живьём не гоняем. Фильтрация tools по scope
(через `GET /tokens/self`) проверяется живьём в P3-1/F-2.

**Окружение.** API :8010 (`FX_SCHEDULER_ENABLED=false RECURRING_SCHEDULER_ENABLED=false`),
БД 5443. Юзеры `qa-mcp@budgetqa.dev` и `qa-mcp2@budgetqa.dev` / `Qa!Test1234`.
**LOGIN ONCE** в начале прогона, дальше переиспользуем `$JWT`.

```bash
API=http://localhost:8010
JWT=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'username=qa-mcp@budgetqa.dev' --data-urlencode 'password=Qa!Test1234' | jq -r .access_token)
```

## STOP-probe S1 — первый живой PAT (4 пробы, mid-scope, не полный прогон)

### P1-1 — выпуск токена ТОЛЬКО сессией (порождает `$RW`/`$RO` для P1-2..P1-4, P3, F)
```bash
mk(){ curl -s -X POST $API/tokens -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' -d "{\"name\":\"qa-$1\",\"scope\":\"$2\"}"; }
RW=$(mk rw full | jq -r .token); RO_J=$(mk ro read); RO=$(echo $RO_J|jq -r .token); RO_ID=$(echo $RO_J|jq -r .id)
```
- **Expected**: 201, тело = `token` (префикс `bgt_pat_`) + `id`, `scope`, `created_at`;
  полная строка приходит РОВНО в этом ответе. ✅ (2026-08-19)
- **Факт**: оба POST → 201, тело `{id,name,scope,created_at,token:"bgt_pat_…"}`;
  `GET /tokens` отдаёт только метаданные (`last_used_at`,`revoked_at`), plaintext в списке
  отсутствует (grep по строке токена → 0 совпадений).

### P1-2 — read с PAT работает + self-introspection
`curl -s -w ' %{http_code}' $API/stats/summary -H "Authorization: Bearer $RO"`, затем
`curl -s -w ' %{http_code}' $API/tokens/self -H "Authorization: Bearer $RO"` и тот же
`/tokens/self` с `$JWT`.
- **Expected**: summary 200 с `currency`; `/tokens/self` с PAT → 200 `{"id":…,"scope":"read"}`
  (ни списка, ни plaintext); с `$JWT` → 404 `{"detail":"TOKEN_NOT_FOUND"}`. ✅ (2026-08-19)
- **Факт**: `/stats/summary` требует обязательный `period` (команда в чеклисте была без него:
  без параметра 422 `period Field required` — валидация, не дефект PAT); с
  `?period=month&month=2026-08` → 200 `{"period":…,"currency":"RUB","income_minor":0,…}`.
  `/tokens/self` с PAT → 200 `{"id":"b3406f13…","scope":"read"}`; с `$JWT` → 404
  `{"detail":"TOKEN_NOT_FOUND"}`.

### P1-3 — write read-токеном → 403
`curl -s -w ' %{http_code}' -X POST $API/transactions -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"amount_minor":100,"kind":"expense","occurred_at":"2026-08-19"}'`
- **Expected**: 403 `{"detail":"TOKEN_SCOPE_READONLY"}`, транзакция НЕ создана (GET /transactions?limit=1). ✅ (2026-08-19)
- **Факт**: 403 `{"detail":"TOKEN_SCOPE_READONLY"}`; `GET /transactions?limit=1` и с PAT, и с
  JWT → 200 `{"items":[],"total":0}` — запись не прошла.

### P1-4 — отозванный токен → 401 (последняя проба: `$RO` дальше мёртв)
`curl -s -X DELETE $API/tokens/$RO_ID -H "Authorization: Bearer $JWT"`, затем повтор P1-2
- **Expected**: revoke 204; повторный read → 401 `{"detail":"TOKEN_INVALID"}`. ✅ (2026-08-19)
- **Факт**: `DELETE /tokens/<RO_ID>` → 204 (пустое тело); повторный `/stats/summary` отозванным
  → 401 `{"detail":"TOKEN_INVALID"}`; `/tokens/self` тем же токеном → 401 `TOKEN_INVALID`.
- Байт-идентичность «отозван == не существует» — **закрыто pytest**.
**STOP**: любая из P1-1..P1-4 не сошлась → остановка S1, эскалация senior-lead.
**Итог STOP-probe S1 (2026-08-19)**: 4/4 ✅, стоп-правило не сработало, S1 разблокирован.
Прогон на API :8010 (схедулеры off, миграция `0007` применена на dev-БД 5443), юзер
`qa-mcp@budgetqa.dev` (создан этим прогоном). Оба выпущенных PAT отозваны, поднятый
API-процесс остановлен. Остальные TC (P3/F) — ⏸ NOT RUN.

## STOP-probe S3 — первый живой MCP stdio (2 пробы; `$RO` из P1-4 отозван — выпустить свежий `mk ro`)

### P3-1 — инициализация
`BUDGET_PAT=$RO BUDGET_API_URL=$API node packages/mcp-server/dist/index.js`, на stdin:
`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"qa","version":"0"}}}`
- **Expected**: валидный JSON-RPC result с `serverInfo.name`, stderr без traceback;
  `tools/list` → РОВНО 13 read-инструментов ($RO — read-токен: introspection через
  `/tokens/self` сработала, write-инструменты не опубликованы). ✅ (2026-08-19)
- **Факт**: `initialize` → `protocolVersion 2024-11-05`, `serverInfo {name:"budget",
  version:"0.1.0"}`; stderr — ровно одна строка `budget-mcp: ready — 13 tools, token
  scope "read", API http://localhost:8010`, трейсбеков нет; `tools/list` = 13 имён,
  их множество совпадает с read-строками §4 architecture.md байт-в-байт (машинный diff пуст).

### P3-2 — один list-инструмент сквозь стек
`tools/call` → `list_categories` с `{}` → непустой JSON-список категорий этого юзера,
`last_used_at` токена обновился. Усечение — **закрыто unit-тестами S3**, живьём не
проверяем. ✅ (2026-08-19)
- **Факт**: `tools/call list_categories {}` → `isError` отсутствует, в `content[0].text`
  JSON-массив системных категорий юзера (Жильё/Здоровье/Кафе…); `last_used_at` токена
  `ded6ee07-…` из NULL стал `2026-08-19 13:24:56Z`.

## Финальный прогон (один раз в конце скоупа)

### F-1 — PAT-жизненный цикл через веб-UI — **владелец: web-qa**
Создание (радио read/full) → строка показана ОДИН раз и копируется → список с
`last_used` → отзыв → строка остаётся помеченной. На выходе web-qa отдаёт мне живой
full-токен. ✅ (2026-08-19, web)
- **Факт**: `/settings`, юзер `qa-mcp@budgetqa.dev`. Создание без правки радио →
  `qa-web-ro` со scope `read` (default read подтверждён и визуально: «View only»
  отмечено); второй токен `qa-web-full` со scope `full` через клик по радио →
  POST 201, `id=7c90954b-da05-4a43-874a-cd6d13d18d6c` (живой full-токен для F-2/F-13).
- Панель успеха: readonly-строка `bgt_pat_…`, кнопка «Copy» → «Copied» +
  live-region «Token copied to the clipboard», красный блок «Save it now — we will
  never show this string again» РАНЬШЕ кнопки «Done». Esc и × при поднятой панели
  не закрывают её (защита от потери строки) — как в plan-web.md.
- **Утечек нет**: строка отсутствует в console (`read_console_messages` — ноль
  ошибок за прогон, кроме пяти 401 от протухшей чужой сессии ДО входа), в URL
  (навигации/квери-параметров не было), в ответах сети кроме двух POST /tokens —
  GET /tokens отдаёт только `id/name/scope/created_at/last_used_at/revoked_at`.
  Уход на `/transactions` и возврат на `/settings` строку не воскрешает.
- Отзыв `qa-web-ro`: ConfirmDialog («Revoke "qa-web-ro"? Anything using this token
  stops working immediately…», красная кнопка + Cancel) → DELETE 204 (preflight
  OPTIONS 200) → строка ОСТАЛАСЬ в списке, приглушена, бейдж «Revoked 19 авг.
  2026 г., 16:40», кнопки отзыва нет; активные сверху, отозванные снизу; список
  обновился без перезагрузки.
- Отозван также `qa-webrevoke` (id `6b724be2-…`, 16:41 локального = 13:41Z) — по
  заявке API-QA под проверку «отзыв действует немедленно».
- **Минорный дефект (a11y)**: после закрытия панели «Done» фокус НЕ возвращается
  на кнопку «New token» (после закрытия обычного модала по Esc — возвращается,
  фокус-кольцо видно). Причина по коду: `TokenFormModal` рендерит ДВА разных
  `<Modal>`, и второй запоминает уже исчезающий элемент. Клавиатурный юзер после
  создания токена оказывается на `<body>`. Не блокер.

### F-2 — MCP end-to-end через настоящий Claude Code (даёт транзакцию для F-7)
`claude mcp add budget -e BUDGET_PAT=$RW -e BUDGET_API_URL=$API -- node <abs>/packages/mcp-server/dist/index.js`
затем `claude mcp list` → `budget: connected`. Read-запрос: «сколько я потратил в этом
месяце по категориям» → `get_transactions_summary`. Write-запрос: «добавь расход
250.00 EUR, кофе, сегодня» → `create_transaction` с `amount_minor` (не float, без своей
арифметики).
- **Expected**: оба вызова успешны, в create-ответе виден `id`; tools/list = РОВНО 24 (full-токен, вкл. delete_transaction)
  инструмента из §4 architecture.md, ничего вне таблицы. ✅ (2026-08-19)
- **[ОТКЛОНЕНИЕ, санкционировано PM 2026-08-19]**: транспорт проверен сырым stdio
  JSON-RPC (протокол `2024-11-05`, `initialize` → `notifications/initialized` →
  `tools/list` → `tools/call`) против `packages/mcp-server/dist/index.js` обоими
  режимами токена, БЕЗ вложенного Claude Code (`claude mcp add`/`claude mcp list` не
  запускались). Содержание TC сохранено полностью.
- **Факт**: full-токеном `tools/list` = РОВНО 24 имени, машинный diff с таблицей §4 пуст
  (ничего вне таблицы, ничего не потеряно); `get_transactions_summary {"month":"2026-08"}`
  → JSON `{month,currency:"RUB",income_minor,expense_minor,net_minor,by_category,
  unconverted_count}`; `create_transaction {amount_minor:25000, currency:"EUR",
  kind:"expense", occurred_at:"2026-08-19", merchant/note:"кофе"}` → в ответе
  `id=b6458adf-1db8-4dc0-9e91-3421af5a508a`, `amount_minor=25000`,
  `base_amount_minor=2452895` / `base_currency=RUB` (снапшот посчитал сервер).
  В `inputSchema` create_transaction поля `client_id` нет (генерит пакет).

### F-3 — невалидный токен
`curl -s -w ' %{http_code}' $API/transactions -H 'Authorization: Bearer bgt_pat_deadbeefdeadbeef'` → 401 `TOKEN_INVALID`. ✅ (2026-08-19)
- **Факт**: 401 `{"detail":"TOKEN_INVALID"}`; строки в `pat_audit_log` нет (ограничение
  по §6 — вешать `token_id` не на что).

### F-4 — DELETE любым токеном (в т.ч. full)
`curl -s -w ' %{http_code}' -X DELETE $API/limits/$CAT_ID -H "Authorization: Bearer $RW"`
- **Expected**: 403 `TOKEN_ENDPOINT_FORBIDDEN` (DELETE нет в fail-closed allowlist, см. plan.md; код `TOKEN_METHOD_FORBIDDEN` отменён); тот же DELETE с `$JWT` → успех (JWT-путь не задет). ✅ (2026-08-19)
- **Факт**: лимит предварительно поставлен `PUT /limits/<cat>` под `$JWT` (200). DELETE
  тем же путём с `$RW` → 403 `{"detail":"TOKEN_ENDPOINT_FORBIDDEN"}`; тот же DELETE с
  `$JWT` → 204, лимит удалён. В аудите строка `DELETE /limits/{category_id} 403`.

### F-5 — анти-эскалация и path-денайлист (`$RW` во всех четырёх)
```bash
H="Authorization: Bearer $RW"; J='Content-Type: application/json'
curl -s -w ' %{http_code}' -X POST $API/tokens -H "$H" -H "$J" -d '{"name":"evil","scope":"full"}'
curl -s -w ' %{http_code}' $API/tokens -H "$H"
curl -s -w ' %{http_code}' "$API/transactions/export?format=csv" -H "$H"
curl -s -w ' %{http_code}' -X PATCH $API/users/me -H "$H" -H "$J" -d '{"email":"pwn@x.dev"}'
```
- **Expected**: `/tokens` POST и GET-список → 401 (PAT-ветки там нет); при этом
  `GET $API/tokens/self -H "$H"` → 200 `{"id":…,"scope":"full"}` — единственное
  разрешённое исключение;
  `/transactions/export` → 403 `TOKEN_ENDPOINT_FORBIDDEN`; `/users/me` PATCH → 401;
  ни один ответ не 2xx. ✅ (2026-08-19)
- **Факт**: `POST /tokens` → 401 `{"detail":"Unauthorized"}`; `GET /tokens` → 401
  `{"detail":"Unauthorized"}`; `GET /transactions/export?format=csv` → 403
  `{"detail":"TOKEN_ENDPOINT_FORBIDDEN"}`; `PATCH /users/me {"email":"pwn@x.dev"}` → 401
  `{"detail":"Unauthorized"}` (email юзера не изменился); `GET /tokens/self` → 200
  `{"id":"1681c28f-…","scope":"full"}` — единственный 2xx из пяти.

### F-6 — чужой ресурс через PAT → 404
GET `/goals/<id цели qa-mcp2>` с `$RW` → 404 `GOAL_NOT_FOUND` (no-oracle). ✅ (2026-08-19)
- **Факт**: цель `98cc3d45-…` создана под `qa-mcp2`; `GET /goals/98cc3d45-…` с `$RW`
  (токен qa-mcp) → 404 `{"detail":"GOAL_NOT_FOUND"}`, и ровно такое же тело/код у
  несуществующего UUID `00000000-0000-4000-8000-000000000000` — оракула нет.

### F-7 — деньги: сумма в веб-UI совпадает, не ×100 (транзакция из F-2)
`amount_minor=25000`, `currency=EUR` → в веб-UI **250,00 €** (не 25 000 €, не 2,50 €);
GET /transactions отдаёт `amount_minor=25000`. ✅ (2026-08-19, web)
- **Факт**: `/transactions`, август 2026 — строка «кофе» отрисована как `-250,00 €`
  с серверной конвертацией `≈ -24 528,95 ₽`; в ответе GET /transactions у
  `b6458adf-1db8-4dc0-9e91-3421af5a508a` `amount_minor=25000`,
  `base_amount_minor=2452895`, `base_currency=RUB`.

### F-8 — экспонента 0 (JPY)
Через MCP: `amount_minor=1200`, `currency=JPY` → в UI **1 200 ¥** (не 12 ¥, не 120 000 ¥);
в БД `amount_minor=1200`, `base_amount_minor` — снапшот сервера, MCP не считал. ✅ (2026-08-19, web)
- **Факт**: строка «JPY test» (`33e3a68e-fe1f-41df-8019-052e9073ae53`) отрисована
  как `-1 200 ¥`, в ответе `amount_minor=1200`, `base_amount_minor=null` — курса
  JPY→RUB нет, поэтому транзакция честно исключена из итогов месяца и UI пишет
  «1 transaction has no exchange rate and is not included in these totals»
  (клиентской арифметики нет).

### F-9 — rate limit 429 (запускать последним из write-кейсов)
`for i in $(seq 1 25); do curl -s -o /dev/null -w '%{http_code} ' -X POST $API/transactions -H "Authorization: Bearer $RW" -H 'Content-Type: application/json' -d '{"amount_minor":1,"kind":"expense","occurred_at":"2026-08-19"}'; done`
- **Expected**: ≤20 первых → 201, дальше 429 `{"detail":"RATE_LIMITED"}`; read тем же
  токеном в этот момент ещё 200 (ключи раздельные); второй PAT юзера не залочен. ✅ (2026-08-19)
- **Факт**: `201 ×17`, затем `429 ×8` + контрольный 26-й → 429 `{"detail":"RATE_LIMITED"}`.
  17, а не 20, потому что в то же 60-секундное окно попали три write-вызова предыдущих
  TC (включая DELETE /limits, отбитый 403: rate-limit по §6 стоит ПЕРЕД allowlist и
  бюджет расходует) — суммарно ровно 20 write за окно, т.е. лимит соблюдён.
  `GET /transactions?limit=1` тем же `$RW` во время лока → 200 (ключи read/write
  раздельные); `GET /categories` read-токеном → 200; `POST /transactions` вторым
  full-токеном юзера (`qa-webrevoke`) → 201 — лок пер-токенный.

### F-10 — 422 через MCP (валидация осталась на сервере)
`create_transaction` с `amount_minor: -5` → 422, MCP отдаёт модели читаемую ошибку, а не
молчаливый «успех». ✅ (2026-08-19)
- **Факт**: JSON-RPC result `isError:true`, текст
  `The Budget API rejected the arguments:\n  - body.amount_minor: Input should be greater
  than or equal to 1`. В `pat_audit_log` есть строка `POST /transactions 422` — запрос
  реально дошёл до сервера, валидация серверная, MCP её не подменяет и не глушит.

### F-11 — аудит-таблица (после F-2/F-9, до F-13/cleanup)
`psql postgresql://budget:budget@localhost:5443/budget -c "SELECT method, path, status_code,
entity_id FROM pat_audit_log WHERE token_id='<id $RW>' ORDER BY occurred_at DESC LIMIT 5"`
- **Expected**: есть строки и для read, и для write; у POST /transactions 2xx `entity_id`
  = id созданной транзакции (совпадает с F-2/F-7); у JWT-трафика строк нет (проверить
  счётчик до/после пары JWT-запросов). Наполнение полей per-write — **закрыто pytest №12**,
  здесь смотрим только что живой стек реально пишет. ✅ (2026-08-19)
- **Факт**: на токен `qa-rw-final` — 50 строк, есть и read (`GET /transactions`,
  `/transactions/summary`, `/goals/{goal_id}`, `/tokens/self`), и write
  (`POST /transactions` 201×23 / 200×1 / 422×1 / 429×9, `DELETE …` 204/404/403).
  У `POST /transactions 201` первой строки `entity_id = b6458adf-…` — id транзакции
  из F-2/F-7; у идемпотентного повтора (200) тот же `entity_id`, что у оригинала;
  у 422/429 `entity_id` NULL. `path` — шаблон роута, не сырой URL.
  JWT-трафик: `GET /transactions` + `POST /transactions` под `$JWT` не добавили
  ни одной строки (74 → 74).

### F-12 — delete_transaction недоступен read-токену
Свежий `mk ro` (P1-4 отозвал старый). В MCP с этим токеном: tools/list — 13 инструментов,
`delete_transaction` ОТСУТСТВУЕТ. Затем напрямую:
`curl -s -w ' %{http_code}' -X DELETE $API/transactions/<id из F-2> -H "Authorization: Bearer $RO2"`
- **Expected**: инструмент не опубликован read-токену; прямой вызов → 403
  `{"detail":"TOKEN_SCOPE_READONLY"}` (пара в allowlist, но метод требует full);
  транзакция жива (GET). ✅ (2026-08-19)
- **Факт**: `tools/list` свежим read-токеном (`qa-ro-final`) = 13 инструментов,
  `delete_transaction` отсутствует (как и все прочие write); прямой
  `DELETE /transactions/<victim>` этим токеном → 403 `{"detail":"TOKEN_SCOPE_READONLY"}`,
  транзакция после этого ещё есть в `GET /transactions`. Дополнительно (PM-экстра 1):
  `POST /transactions` и `PATCH /transactions/{id}` тем же read-токеном → оба 403
  `TOKEN_SCOPE_READONLY`; в БД ничего не создано и не изменено.

### F-13 — delete_transaction full-токеном: аудит + no-oracle на повторе
`curl -s -w ' %{http_code}' -X DELETE $API/transactions/<id из F-2> -H "Authorization: Bearer $RW"`,
повторить тот же вызов, затем строка аудита:
`psql … -c "SELECT status_code, entity_id FROM pat_audit_log WHERE method='DELETE' ORDER BY occurred_at DESC LIMIT 2"`
- **Expected**: первый DELETE → 204, транзакции больше нет в GET /transactions; аудит-строка
  с `entity_id` = удалённый id (взят из ПУТИ — у 204 тела нет); повторный DELETE того же id →
  404 `{"detail":"TRANSACTION_NOT_FOUND"}` байт-в-байт как для чужого/несуществующего
  (no-oracle; матрица закрыта pytest №13, здесь смотрим живой повтор). ✅ (2026-08-19)
- **[ОТКЛОНЕНИЕ, указание PM]**: жертвой стала ОТДЕЛЬНАЯ транзакция
  `e9016821-8cb2-41c9-9103-55ab1641f6c4` (создана через MCP, 5000 RUB, note `victim-f13`),
  а не транзакция из F-2 — EUR/JPY-транзакции оставлены живыми для F-7/F-8 (web-qa).
- **Факт**: DELETE → 204 (пустое тело); количество транзакций юзера 6 → 5 — удалилась
  РОВНО одна; в `GET /transactions?limit=100` id больше не встречается; повтор того же
  DELETE → 404 `{"detail":"TRANSACTION_NOT_FOUND"}`, и то же самое тело/код у
  несуществующего UUID. Аудит: `DELETE /transactions/{transaction_id} 204
  entity_id=e9016821-…` (взят из пути), следом две 404-строки (повтор и
  несуществующий id) и более ранняя 403-строка от read-токена.

### F-14 — cleanup: удалить QA-транзакции/цели, отозвать все qa-PAT; `git status
--porcelain` чист, кроме этого файла. ✅ (2026-08-19)
- **Факт**: отозваны сессией владельца `qa-ro-final`, `qa-rw-final`, `smoke full`,
  `smoke read` (все 204); `qa-webrevoke` к этому моменту уже был отозван web-qa через
  UI (повторный DELETE → 404, как и положено no-oracle). Активных PAT у всех
  `qa-*`-пользователей — **0** (14 строк, все с `revoked_at`).
- Удалены все 24 транзакции прогона у `qa-mcp` (EUR 250,00 `b6458adf-…`, JPY 1200
  `33e3a68e-…`, `dup-probe` ×2, `idem-probe`, `f9-burst` ×17, `f9-other-token`,
  `jwt-audit-probe`) и цель `qa2 goal` у `qa-mcp2`; лимит категории снят ещё в F-4.
  Итог: транзакций и целей у `qa-mcp`/`qa-mcp2` — **0**. Строки `pat_audit_log`
  оставлены намеренно: это журнал, отзыв токена его не стирает (retention — ручной
  prune по §6). Фикстуры других агентов (`qa-web-*`, `qa-sim-*`, `qa-mobile-*`) не тронуты.
- `git status --porcelain` не содержит следов прогона (артефакты скоупа уже в
  коммитах `84283b0`/`8129bca`; в дереве остались только чужие изменения —
  `.claude/scheduled_tasks.lock`, `.claude/skills/*`, `skills-lock.json`).

## PM extras (final run) — доп. требования PM 2026-08-19 (фаза A)

Прогон: API :8010 (uvicorn из этого репо, pid 90513, код свежее правок S1–S5),
БД 5443, MCP `packages/mcp-server/dist/index.js` (dist новее всех `src/*.ts`).
Токены этого прогона: `qa-rw-final` (full, `1681c28f-…`), `qa-ro-final` (read,
`ded6ee07-…`), `qa-webrevoke` (full, `6b724be2-…` — оставлен ЖИВЫМ для web-qa).

### PM-1 — read-токен не пишет ничем ✅
`tools/list` read-токеном = РОВНО 13 read-инструментов, множество имён совпадает с
read-строками §4 (машинный diff пуст), write-инструментов нет вовсе. Прямыми curl'ами
тем же токеном: `POST /transactions` → 403 `TOKEN_SCOPE_READONLY`,
`PATCH /transactions/{id}` → 403 `TOKEN_SCOPE_READONLY`, `DELETE /transactions/{id}` →
403 `TOKEN_SCOPE_READONLY` (см. F-12). Ни одной новой/изменённой строки в БД.

### PM-2 — удаление ровно одной строки ✅
См. F-13: 204 → count юзера 6→5 (ровно одна), аудит `entity_id` = удалённый id,
повтор → 404 `TRANSACTION_NOT_FOUND` (байт-в-байт как несуществующий), read-токеном
DELETE → 403.

### PM-3 — защита от дублей по деньгам ✅ (оба случая)
- **(a) два ПОСЛЕДОВАТЕЛЬНЫХ `tools/call create_transaction`** с одинаковыми
  аргументами (`777 RUB, expense, 2026-08-19, dup-probe`) в одной MCP-сессии → ДВЕ
  разные транзакции: `516f7227-1d5c-4719-98e4-265fedfe82bb` и
  `343d0c18-cf95-42be-8f87-07d9f174de40`. Пакет генерит `client_id` на каждый
  логический вызов — два вызова пользователя не схлопываются в один.
- **(b) повтор ОДНОГО логического вызова**: `POST /transactions` с одним и тем же
  `client_id=02fad42f-8886-4948-a8c1-32ef767aa7d7` дважды → первый 201
  `id=b2aef780-2c31-4e1f-8852-b5751b3a22d8`, второй 200 с ТЕМ ЖЕ id и тем же
  `created_at`; `SELECT count(*) … WHERE client_id=…` → 1.

### PM-4 — аудит пишет отказы ✅
`pat_audit_log` по токенам этого прогона:
`DELETE /limits/{category_id} 403` (F-4), `GET /transactions/export 403` (F-5),
`POST|PATCH|DELETE /transactions 403` под read-токеном (F-12/PM-1),
`POST /transactions 429 ×9` (F-9), плюс 422 из F-10. У всех корректные
`token_id`/`method`/`path` (шаблон роута, не сырой URL). 401-отказы (F-3) не пишутся —
задокументированное ограничение §6. JWT-трафик не пишется вовсе (74 → 74 строк).

### PM-5 — plaintext токена нигде не светится ✅
- (a) БД: `SELECT count(*) FROM pat_audit_log WHERE path LIKE '%<хвост>%'` → 0; шире —
  `CAST(pat_audit_log AS text) LIKE '%<хвост>%'` → 0, то же для
  `personal_access_tokens` (там только `token_hash`) и для `transactions` → 0.
- (b) лог API-процесса (stdout+stderr, 131 строка): `grep -c bgt_pat_` → 0,
  `grep -c '<хвост токена>'` → 0.
- (c) `GET /tokens` под `$JWT`: `{"items":[{id,name,scope,created_at,last_used_at,
  revoked_at}]}` — полей `token`/`plaintext` нет, `grep bgt_pat_` по телу → 0.

### PM-6 — JPY (экспонента 0) через MCP ⚠ (данные окружения, не дефект кода)
`create_transaction {amount_minor:1200, currency:"JPY"}` → 201,
`id=33e3a68e-fe1f-41df-8019-052e9073ae53`; в БД `amount_minor=1200` (сервер ничего не
масштабировал) — это главное. НО `base_amount_minor`/`base_currency` = NULL: продукт
хранит только 6 канонических пар (USD/EUR/RUB/BYN, `services/fx_jobs.py`), курса JPY в
`exchange_rates` нет вообще, и `auto_snapshot` по контракту D5 возвращает
`(None, None)`, когда курса нет. Транзакция при этом честно попадает в
`get_transactions_summary` как `unconverted_count: 1` и не искажает агрегат.
Т.е. «base заполнен сервером» на JPY недостижимо в этом окружении by design —
не баг MCP/PAT. UI-часть (1 200 ¥, поведение неконвертированной строки) — за web-qa.

### Что оставлено для фаз B/C
- EUR 250,00 → `b6458adf-1db8-4dc0-9e91-3421af5a508a` (F-7, web-qa) — ЖИВА.
- JPY 1200 → `33e3a68e-fe1f-41df-8019-052e9073ae53` (F-8, web-qa) — ЖИВА.
- Живой full-токен `qa-webrevoke` id `6b724be2-e8ae-4796-aca1-bf7c653116a2` — web-qa
  отзывает его через UI, затем проверяется немедленность 401 (plaintext у qa-агента).
- Мусор под фазу C: ~20 транзакций `f9-burst` (по 1 minor), `dup-probe` ×2,
  `idem-probe`, `jwt-audit-probe`, `f9-other-token`; токены `qa-rw-final`,
  `qa-ro-final`, старые `smoke read`/`smoke full`; цель `qa2 goal` у `qa-mcp2`.
- API-процесс НЕ остановлен, транзакции qa-юзера НЕ чищены (по указанию PM).

## Итог прогона
Total 20 (P1 ×4, P3 ×2, F ×14) · Passed 4 (P1-1..P1-4) · Failed 0 · Blocked 0 ·
Не запускались 16 (P3 ×2, F ×14 — ждут S3/S5). Статус: STOP-probe S1 ✅ PASSED,
скоуп в целом ⏸ IN PROGRESS. Провал любого TC → ❌ FAIL OVERALL, решает senior-lead.
