# QA Checklist: mcp-server (PLAN 5.6) — grooming artifact, НИЧЕГО не прогоняется сейчас

## Scope
Живой слой поверх S1–S5: PAT-auth по настоящему HTTP, scope/метод/path-гейты, rate
limit, MCP stdio через настоящий Claude Code. Браузерная часть S2 — **web-qa** (я лишь
потребляю выпущенный токен). Мобилка не затрагивается.

**Split rule.** Не дублируем живьём то, что закрывает pytest S1 (`plan.md` ещё не
написан — при появлении сверить номера): hash-lookup, no-oracle `TOKEN_INVALID`
(missing == revoked байт-в-байт), дебаунс `last_used_at`, CHECK `scope`, матрица
метод×scope, «PAT-ветка не ломает JWT-путь», contract-drift. Юниты S3/S4 закрывают:
усечение >50KB, fail-fast на allowlist-пути, генерацию схем. Фильтрация tools по scope
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
  полная строка приходит РОВНО в этом ответе. ⏸

### P1-2 — read с PAT работает + self-introspection
`curl -s -w ' %{http_code}' $API/stats/summary -H "Authorization: Bearer $RO"`, затем
`curl -s -w ' %{http_code}' $API/tokens/self -H "Authorization: Bearer $RO"` и тот же
`/tokens/self` с `$JWT`.
- **Expected**: summary 200 с `currency`; `/tokens/self` с PAT → 200 `{"id":…,"scope":"read"}`
  (ни списка, ни plaintext); с `$JWT` → 404 `{"detail":"TOKEN_NOT_FOUND"}`. ⏸

### P1-3 — write read-токеном → 403
`curl -s -w ' %{http_code}' -X POST $API/transactions -H "Authorization: Bearer $RO" -H 'Content-Type: application/json' -d '{"amount_minor":100,"kind":"expense","occurred_at":"2026-08-19"}'`
- **Expected**: 403 `{"detail":"TOKEN_SCOPE_READONLY"}`, транзакция НЕ создана (GET /transactions?limit=1). ⏸

### P1-4 — отозванный токен → 401 (последняя проба: `$RO` дальше мёртв)
`curl -s -X DELETE $API/tokens/$RO_ID -H "Authorization: Bearer $JWT"`, затем повтор P1-2
- **Expected**: revoke 204; повторный read → 401 `{"detail":"TOKEN_INVALID"}`. ⏸
- Байт-идентичность «отозван == не существует» — **закрыто pytest**.
**STOP**: любая из P1-1..P1-4 не сошлась → остановка S1, эскалация senior-lead.

## STOP-probe S3 — первый живой MCP stdio (2 пробы; `$RO` из P1-4 отозван — выпустить свежий `mk ro`)

### P3-1 — инициализация
`BUDGET_PAT=$RO BUDGET_API_URL=$API node packages/mcp-server/dist/index.js`, на stdin:
`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"qa","version":"0"}}}`
- **Expected**: валидный JSON-RPC result с `serverInfo.name`, stderr без traceback;
  `tools/list` → РОВНО 13 read-инструментов ($RO — read-токен: introspection через
  `/tokens/self` сработала, write-инструменты не опубликованы). ⏸

### P3-2 — один list-инструмент сквозь стек
`tools/call` → `list_categories` с `{}` → непустой JSON-список категорий этого юзера,
`last_used_at` токена обновился. Усечение — **закрыто unit-тестами S3**, живьём не
проверяем. ⏸

## Финальный прогон (один раз в конце скоупа)

### F-1 — PAT-жизненный цикл через веб-UI — **владелец: web-qa**
Создание (радио read/full) → строка показана ОДИН раз и копируется → список с
`last_used` → отзыв → строка остаётся помеченной. На выходе web-qa отдаёт мне живой
full-токен. ⏸ (передано web-qa)

### F-2 — MCP end-to-end через настоящий Claude Code (даёт транзакцию для F-7)
`claude mcp add budget -e BUDGET_PAT=$RW -e BUDGET_API_URL=$API -- node <abs>/packages/mcp-server/dist/index.js`
затем `claude mcp list` → `budget: connected`. Read-запрос: «сколько я потратил в этом
месяце по категориям» → `get_transactions_summary`. Write-запрос: «добавь расход
250.00 EUR, кофе, сегодня» → `create_transaction` с `amount_minor` (не float, без своей
арифметики).
- **Expected**: оба вызова успешны, в create-ответе виден `id`; tools/list = РОВНО 23 (full-токен)
  инструмента из §4 architecture.md, ничего вне таблицы. ⏸

### F-3 — невалидный токен
`curl -s -w ' %{http_code}' $API/transactions -H 'Authorization: Bearer bgt_pat_deadbeefdeadbeef'` → 401 `TOKEN_INVALID`. ⏸

### F-4 — DELETE любым токеном (в т.ч. full)
`curl -s -w ' %{http_code}' -X DELETE $API/limits/$CAT_ID -H "Authorization: Bearer $RW"`
- **Expected**: 403 `TOKEN_ENDPOINT_FORBIDDEN` (DELETE нет в fail-closed allowlist, см. plan.md; код `TOKEN_METHOD_FORBIDDEN` отменён); тот же DELETE с `$JWT` → успех (JWT-путь не задет). ⏸

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
  ни один ответ не 2xx. ⏸

### F-6 — чужой ресурс через PAT → 404
GET `/goals/<id цели qa-mcp2>` с `$RW` → 404 `GOAL_NOT_FOUND` (no-oracle). ⏸

### F-7 — деньги: сумма в веб-UI совпадает, не ×100 (транзакция из F-2)
`amount_minor=25000`, `currency=EUR` → в веб-UI **250,00 €** (не 25 000 €, не 2,50 €);
GET /transactions отдаёт `amount_minor=25000`. ⏸

### F-8 — экспонента 0 (JPY)
Через MCP: `amount_minor=1200`, `currency=JPY` → в UI **1 200 ¥** (не 12 ¥, не 120 000 ¥);
в БД `amount_minor=1200`, `base_amount_minor` — снапшот сервера, MCP не считал. ⏸

### F-9 — rate limit 429 (запускать последним из write-кейсов)
`for i in $(seq 1 25); do curl -s -o /dev/null -w '%{http_code} ' -X POST $API/transactions -H "Authorization: Bearer $RW" -H 'Content-Type: application/json' -d '{"amount_minor":1,"kind":"expense","occurred_at":"2026-08-19"}'; done`
- **Expected**: ≤20 первых → 201, дальше 429 `{"detail":"RATE_LIMITED"}`; read тем же
  токеном в этот момент ещё 200 (ключи раздельные); второй PAT юзера не залочен. ⏸

### F-10 — 422 через MCP (валидация осталась на сервере)
`create_transaction` с `amount_minor: -5` → 422, MCP отдаёт модели читаемую ошибку, а не
молчаливый «успех». ⏸

### F-11 — аудит-таблица (после F-2/F-9, до cleanup)
`psql postgresql://budget:budget@localhost:5443/budget -c "SELECT method, path, status_code,
entity_id FROM pat_audit_log WHERE token_id='<id $RW>' ORDER BY occurred_at DESC LIMIT 5"`
- **Expected**: есть строки и для read, и для write; у POST /transactions 2xx `entity_id`
  = id созданной транзакции (совпадает с F-2/F-7); у JWT-трафика строк нет (проверить
  счётчик до/после пары JWT-запросов). Наполнение полей per-write — **закрыто pytest №12**,
  здесь смотрим только что живой стек реально пишет. ⏸

### F-12 — cleanup: удалить QA-транзакции/цели, отозвать все qa-PAT; `git status
--porcelain` чист, кроме этого файла. ⏸

## Итог прогона
Total 18 (P1 ×4, P3 ×2, F ×12) · Passed — · Failed — · Blocked —. Статус ⏸ NOT RUN
(грумминг). Провал любого TC → ❌ FAIL OVERALL, решает senior-lead.
