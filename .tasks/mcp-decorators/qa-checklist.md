# QA Checklist: mcp-decorators

> Прогон 2026-09-20 (QA): блоки 1 и 2 отработаны на `budget_qa_mcpdec` / API 8021.
> Блок 3 (FINAL) не запускался — не его время. Драйвер stdio адаптирован (см. ниже).

## Scope
Только то, чего снимок+pytest доказать не могут: **Python-сервер реально поднимается по
stdio и отдаёт тот же набор инструментов, что собранный TS**, выведенный из декораторов
allowlist ведёт себя на живом HTTP как литерал, а после удаления `packages/mcp-server`
монорепо и Claude Desktop не разваливаются.
**НЕ гоняем живьём (закрыто иначе):** равенство 35 имён/описаний/inputSchema и read/full —
pytest по фикстуре-снимку; 38 пар `PAT_ALLOWLIST` — снимок + `TestAllowlistContract`; md5
`openapi.json` — тест; fail-closed маршрута без декоратора — pytest; ветки трёх гейтов
`upload_receipt` (10 МБ, магия, realpath) — перенесённый `uploadReceipt.test.ts`; усечение
>50KB, маппинг ошибок API→tool-error, отсутствие `client_id` в схеме — юниты; no-oracle,
скоупинг по user_id, 422, rate limit — pytest и прогон `mcp-server` 2026-08-19.

## Окружение пробы (рабочие 8010/5443-`budget` и чужие 5433/8000/8081/5173 — не трогать)
Своя БД и свой порт (PM 2026-08-27: контейнер применяет миграции при старте, чужая ревизия
в `budget` = лежащее приложение).
```bash
QADB=budget_qa_mcpdec; API=http://localhost:8021   # дроп БД — прерогатива оркестратора
createdb -h localhost -p 5443 -U budget $QADB; DB=postgresql+asyncpg://budget:budget@localhost:5443/$QADB
cd apps/api && DATABASE_URL=$DB uv run alembic upgrade head
DATABASE_URL=$DB FX_SCHEDULER_ENABLED=false RECURRING_SCHEDULER_ENABLED=false uv run uvicorn budget_api.app:create_app --factory --port 8021 &
```
**LOGIN ONCE:** `qa-mcpdec@budgetqa.dev` / `Qa!Test1234` → `$JWT` (register+login один раз),
дальше только PAT; `C='Content-Type: application/json'`. Драйвер stdio (scratchpad,
`mcpprobe.py <tag> -- <cmd…>`, кадры со stdin):
```python
import subprocess, sys
cmd = sys.argv[sys.argv.index('--') + 1:]; tag = sys.argv[1]
fr = [l for l in sys.stdin.read().splitlines() if l.strip()] or ['{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}']
hs = ['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"qa","version":"0"}}}',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}']  # без нотификации сервер не отвечает на tools/list
p = subprocess.run(cmd, input="\n".join(hs + fr) + "\n", capture_output=True, text=True, timeout=60)
open(tag + ".out", "w").write(p.stdout); open(tag + ".err", "w").write(p.stderr)   # кадры / лог
```
**ПРАВКА ДРАЙВЕРА (прогон 2026-09-20, дефект драйвера, не сервера):** `subprocess.run`
закрывает stdin сразу после записи, и ОБА сервера завершают сессию по EOF раньше, чем
отвечают на `tools/list` — в `.out` оставался один кадр `initialize`. Рабочая версия
(`scratchpad/mcpprobe.py`) поднимает процесс через `Popen`, держит stdin ОТКРЫТЫМ, шлёт
`initialize` → ждёт ответ `id:1` → `notifications/initialized` → кадры, читает stdout в
потоке, пока не придут все ожидаемые `id`, и только потом закрывает stdin. Python-сервер
отвечает своим `protocolVersion` `2025-06-18` (TS — `2024-11-05`); сравнивался, как и
велит рецепт, ТОЛЬКО массив `tools`.
Серверы (обоим env `BUDGET_API_URL=$API`, `BUDGET_PAT=…`): TS — `node packages/mcp-server/
dist/index.js` (сначала `pnpm --filter @budget/mcp-server build`: `dist/` от 26.08 старее
`src/`); Python — `uv --directory apps/api run python -m budget_api.mcp`. protocolVersion
шлём одинаковый, TS вправе ответить своим `2024-11-05` — сравниваем ТОЛЬКО массив `tools`:
```bash
tools(){ jq -c 'select(.id==2)|.result.tools|sort_by(.name)' $1.out | jq -S .; }
diff <(tools ts) <(tools py) && echo IDENTICAL
```

## Блок 1 — STOP-probe (mid-scope, сразу как Python-сервер заработал; минуты)
Любая из D1-* не сошлась → стоп, TS не удаляем, эскалация senior-lead.
### D1-1 — подготовка (порождает `$RO`/`$RW` для D1-2…D1-7 и A-1…A-5) — STOP-probe
`mk(){ curl -s -X POST $API/tokens -H "Authorization: Bearer $JWT" -H "$C" -d "{\"name\":\"qa-$1\",\"scope\":\"$2\"}" | jq -r .token; }`, затем `RO=$(mk ro read); RW=$(mk rw full); mkdir -p /tmp/qa-mcp-up`.
- **Expected**: оба 201 с `bgt_pat_…`; `pnpm --filter @budget/mcp-server build` зелёный.
- **Status**: ✅ pass (2026-09-20). Юзер `qa-mcpdec@budgetqa.dev` зарегистрирован (201,
  `62754757-…`), логин ОДИН раз (`/auth/login` — форма, не JSON: 422 на JSON-теле — это
  контракт OAuth2-формы, не дефект). Токены: `qa-ro` read `5d7ac933-cde8-43bd-b5e0-814cf75e2f3c`
  201, `qa-rw` full `bc4f09cb-abd0-478b-82d3-c9f1c824b5b0` 201, оба с префиксом `bgt_pat_`.
  Сборка TS: `tsc -p tsconfig.build.json` без вывода, `dist/index.js` пересобран (15:23).
### D1-2 — `tools/list` read-токеном: TS ≡ Python — STOP-probe
`BUDGET_PAT=$RO`, **без** `BUDGET_UPLOAD_DIR`, оба сервера, diff по рецепту выше.
- **Expected**: у обоих ровно **20** инструментов, все read; `diff` пуст (имена, описания,
  `inputSchema` побайтово); write-имён и `upload_receipt` нет.
- **Status**: ✅ pass. TS 20, Python 20, `diff` → `IDENTICAL` (пусто). Имён на
  `create_/update_/delete_/upload_` — 0. stderr Python: `ready — 20 tools, token scope "read"`.
### D1-3 — `tools/list` full-токеном и публикация `upload_receipt` — STOP-probe
Три прогона на каждом сервере: (а) `$RW` без `BUDGET_UPLOAD_DIR`; (б) `$RW` с `BUDGET_UPLOAD_DIR=/tmp/qa-mcp-up`; (в) `$RO` с тем же каталогом.
- **Expected**: (а) 35 = 20 read + 15 write, diff пуст; (б) 36, единственная дельта к (а) —
  `upload_receipt`, diff TS↔Python пуст; (в) снова 20 — каталог read-токену тула не даёт.
- **Status**: ❌ fail по букве ожидания (счётчики сошлись, байты — нет). **STOP-условие
  сработало: TS-пакет НЕ удалять до решения senior-lead.**
  - Счётчики: (а) TS 35 / Python 35 (20 read + 15 write), (б) TS 36 / Python 36, дельта к (а)
    РОВНО `upload_receipt`, (в) TS 20 / Python 20 — каталог read-токену тула не даёт. (в) diff
    пуст: `IDENTICAL`.
  - Но (а) и (б): `diff` НЕ пуст — 116 строк, 58 пар, все одного вида — целочисленные границы
    в схемах write-инструментов Python отдаёт как JSON-float:
    ```
    9,10c9,10
    <           "maximum": 999999999999999,
    <           "minimum": -999999999999999,
    ---
    >           "maximum": 999999999999999.0,
    >           "minimum": -999999999999999.0,
    ```
    (`<` — TS, `>` — Python; так же `minimum: 1/1.0` ×22, `0/0.0` ×4, `maximum: 365/365.0`,
    `31/31.0`, `6/6.0`). На проводе это видно в сыром кадре: `"maximum":999999999999999.0` у
    Python против `"maximum":999999999999999` у TS.
  - Природа: в `apps/api/openapi.json` литерал — `999999999999999.0` (26 вхождений), то есть
    **Python побайтово верен файлу контракта, а TS нормализует число через `JSON.stringify`**
    (JS печатает целое значение без `.0`). Семантически схемы равны: после приведения
    float-с-целым-значением к int diff по (а) и (б) — `IDENTICAL`.
  - Почему pytest это не ловит: `TestSnapshot` сравнивает распакованные объекты, а в Python
    `999999999999999 == 999999999999999.0` истинно — фикстура снимка хранит int, сборка даёт
    float, тест зелёный. Живой diff — единственное место, где разница видна.
  - Решение (оставить как есть / привести к int) — за senior-lead; QA код не трогает.
### D1-4 — `tools/call` сквозь стек (Python) — STOP-probe
Кадры: `get_profile {}` и `list_transactions {"limit":5}`.
- **Expected**: без `isError`; `get_profile` — базовая валюта юзера; `list_transactions` —
  объект со списком (пустой на свежей БД = норма); `last_used_at` PAT перестал быть NULL.
- **Status**: ✅ pass. `isError:false` у обоих. `get_profile` →
  `{"base_currency":"RUB","monthly_income_minor":null,"country":null,"language":null}`;
  `list_transactions` → `{"items":[],"total":0}` (свежая БД). `personal_access_tokens.last_used_at`
  у обоих токенов НЕ NULL (`qa-ro` 13:25:11Z). В `pat_audit_log` — `GET /profile` 200 и
  `GET /transactions` 200, плюс `GET /tokens/self` 200 от старта сервера.
### D1-5 — `create_transaction`: managed body живой (аудит + `client_id`) — STOP-probe
`list_accounts`/`list_categories` за id, затем один `create_transaction` (`expense`, minor
units). В `$QADB`: `SELECT client_id FROM transactions ORDER BY created_at DESC LIMIT 1;`
и `SELECT method,path,status_code FROM pat_audit_log ORDER BY occurred_at DESC LIMIT 3;`
- **Expected**: строка создана; `client_id` НЕ NULL, хотя модель его не слала (в схеме его
  нет — D1-3) — генерация пережила переезд; в аудите РОВНО одна строка `POST /transactions`
  201, путь — шаблон, не URL.
- **Status**: ✅ pass. У свежего юзера счетов нет, поэтому счёт заведён тем же стеком:
  `create_account` → 201, `bef3bcec-…` (RUB, cash). Затем `create_transaction`
  (expense, 12345 minor, категория `c861af3a-…` «Жильё») → `isError:false`, id `ee295b55-…`.
  SQL: `client_id = 42970990-a31a-4aa9-8b12-ba3c4fb1a6dd` (НЕ NULL), при том что в
  `inputSchema` инструмента поля `client_id` нет вовсе. Аудит: `count(*) where
  method='POST' and path='/transactions'` = **1**, путь записан шаблоном.
### D1-6 — `upload_receipt`: happy path + один отказ (Python) — STOP-probe
`BUDGET_UPLOAD_DIR=/tmp/qa-mcp-up`, внутри настоящий JPEG; рядом `ln -s /etc/hosts /tmp/qa-mcp-up/evil.jpg` (или PNG, переименованный в `.jpg`).
- **Expected**: happy — без `isError`, строка чека с `id`, в аудите пара `POST /receipts` +
  `GET /receipts/{receipt_id}`; отказ — `isError:true` и НИ ОДНОЙ новой строки в аудите.
- **Status**: 🚫 blocked (happy path) / ✅ отказ. **MinIO не поднят**: `budget-minio-1` в
  `docker ps -a` — `Exited (137) 25 hours ago`, `curl http://localhost:9010/minio/health/live`
  → код `000` (соединение не установлено); поднимать контейнеры QA не вправе.
  - happy: `upload_receipt {"path":"good.jpg"}` (настоящий JPEG 1.3 МБ, `file` подтверждает) →
    `isError:true`, текст: `Could not upload the image to storage: All connection attempts
    failed` — presigned PUT в MinIO. До этого шага стек отработал: в аудите появилась
    `POST /receipts 201`, `GET /receipts/{receipt_id}` (ожидаемо) не наступил. Прогнать
    до конца можно только при живом MinIO.
  - отказ: `ln -s /etc/hosts /tmp/qa-mcp-up/evil.jpg` → `isError:true`, `"evil.jpg" resolves
    outside the allowed upload folder (/private/tmp/qa-mcp-up)` — гейт `realpath` сработал,
    новых строк в `pat_audit_log` отказ не породил (было 20 после happy, стало 20).
### D1-7 — гигиена stdout — STOP-probe
`while read l; do echo "$l" | jq -e . >/dev/null || echo "JUNK: $l"; done < py.out` (на
выводах D1-2 и D1-4).
- **Expected**: каждая строка stdout — валидный JSON-RPC кадр; ни `print`, ни баннера `uv`;
  весь лог, включая «ready — N tools», в `py.err`. Лишняя строка убивает транспорт.
- **Status**: ✅ pass. Проверены stdout ВСЕХ семи python-прогонов (D1-2, D1-3 а/б/в, D1-4,
  D1-5, D1-6): каждая непустая строка парсится как JSON и несёт `"jsonrpc":"2.0"`, мусорных
  строк 0. (Шелловый `while read | jq` из рецепта даёт ложный JUNK на кадре в 19 КБ — это
  `echo` в цикле, а не сервер; перепроверено построчным парсером Python.) В stderr ровно одна
  строка на прогон: `budget-mcp: ready — 20|35|36 tools, token scope …, uploads off|<dir>`;
  баннера `uv` в stdout нет.

## Блок 2 — allowlist из декораторов == старый, на живом HTTP (mid-scope, после декоратора)
Токены из D1-1, без перелогина; `H(){ echo "Authorization: Bearer $1"; }`.
### A-1 — read-токен: GET проходит, write отбивается — mid-scope
```bash
curl -s -w ' %{http_code}' $API/profile -H "$(H $RO)"
curl -s -w ' %{http_code}' "$API/transactions?limit=1" -H "$(H $RO)"
curl -s -w ' %{http_code}' -X POST $API/categories -H "$(H $RO)" -H "$C" -d '{"name":"qa"}'
```
- **Expected**: 200, 200, 403 `TOKEN_SCOPE_READONLY` — пара в allowlist есть, отказ по scope.
- **Status**: ✅ pass. `GET /profile` 200 (тело профиля), `GET /transactions?limit=1` 200
  (видна транзакция из D1-5), `POST /categories` → 403 `{"detail":"TOKEN_SCOPE_READONLY"}` —
  отказ именно по scope, а не по маршруту.
### A-2 — full-токен: намеренно «никогда» — вклады и DELETE пункта плана — mid-scope
```bash
curl -s -w ' %{http_code}' -X POST $API/deposits -H "$(H $RW)" -H "$C" -d '{}'
curl -s -w ' %{http_code}' -X DELETE $API/goals/00000000-0000-0000-0000-000000000001/items/00000000-0000-0000-0000-000000000002 -H "$(H $RW)"
```
- **Expected**: оба 403 `TOKEN_ENDPOINT_FORBIDDEN` — гейт пути срабатывает до scope и до
  хендлера, поэтому выдуманные UUID дают 403, а не 404.
- **Status**: ✅ pass. `POST /deposits` → 403 `{"detail":"TOKEN_ENDPOINT_FORBIDDEN"}`;
  `DELETE /goals/0000…0001/items/0000…0002` → 403 то же тело. Выдуманные UUID дали 403, не
  404 и не 422 — гейт пути впереди хендлера.
### A-3 — full-токен: исторические исключения (экспорт, импорт выписок) — mid-scope
`curl -s -w ' %{http_code}' "$API/transactions/export?period=month&month=2026-09" -H "$(H $RW)"`
и `curl -s -w ' %{http_code}' $API/statement-imports -H "$(H $RW)"`.
- **Expected**: оба 403 `TOKEN_ENDPOINT_FORBIDDEN`; тело CSV не начало течь.
- **Status**: ✅ pass (с поправкой к рецепту). `GET /transactions/export?period=month&month=2026-09`
  → 403 `{"detail":"TOKEN_ENDPOINT_FORBIDDEN"}`, CSV не потёк (тело — только JSON ошибки).
  **Поправка**: `GET /statement-imports` из рецепта даёт 405 `Method Not Allowed` — маршрут
  существует только как `POST` (см. `openapi.json`), 405 отдаёт роутинг до всякой авторизации,
  дефекта здесь нет. Перепроверено правильными методами: `POST /statement-imports` → 403
  `TOKEN_ENDPOINT_FORBIDDEN`, `GET /statement-imports/formats` → 403 то же. Импорт выписок
  закрыт и на чтение, и на запись.
### A-4 — `PATCH /profile`: роутер расщеплён по методу — mid-scope
`curl -s -w ' %{http_code}' -X PATCH $API/profile -H "$(H $RW)" -H "$C" -d '{"base_currency":"USD"}'`
- **Expected**: **401**, не 403 — JWT-only, отказ на разборе токена; GET `/profile` тем же
  токеном 200 (A-1), расщепление по методу уцелело.
- **Status**: ✅ pass. `PATCH /profile` PAT-токеном `$RW` → **401** `{"detail":"Unauthorized"}`
  (не 403), тогда как `GET /profile` тем же классом токена в A-1 отдаёт 200: роутер
  по-прежнему расщеплён по методу.
### A-5 — множество не сжалось: разрешённая запись проходит — mid-scope
`POST /categories` и `PATCH /goals/{goal_id}` (цель этого же прогона) токеном `$RW`.
- **Expected**: 201 и 200. Прочие TC блока ловят «разрешили лишнее», этот — «потеряли нужное».
- **Status**: ✅ pass. `POST /categories` (`qa-mcpdec-cat`) → **201**, id `52939e92-…`;
  `POST /goals` → 201 `e2ea3889-…`, затем `PATCH /goals/e2ea3889-…` → **200**, имя сменилось
  на `qa-goal-renamed`. Разрешённая запись проходит — множество не сжалось.

## Блок 3 — FINAL (после удаления `packages/mcp-server`)
### F-1 — Claude Desktop на Python-входе — FINAL, владелец: оркестратор/пользователь
`~/Library/Application Support/Claude/claude_desktop_config.json`: `command` = **абсолютный**
путь к `uv` (в PATH GUI-приложений его нет), `args` = `["--directory","<abs>/apps/api","run",
"python","-m","budget_api.mcp"]`, env `BUDGET_API_URL`/`BUDGET_PAT`; полный рестарт клиента.
- **Expected**: `budget` в «connected», инструментов 35 (36 с `BUDGET_UPLOAD_DIR`) — ровно
  цифра D1-3; в `~/Library/Logs/Claude/mcp-server-budget.log` ни трейсбеков, ни «uv: not found».
- **Status**: ⏸ pending
### F-2 — один read и один write диалогом — FINAL
«Покажи траты за сентябрь» и «добавь расход 100 на кофе» на qa-юзере.
- **Expected**: read вернул цифры сервера (клиент не считал сам); write создал РОВНО одну
  строку, видную повторным read; в `pat_audit_log` по строке на вызов.
- **Status**: ⏸ pending
### F-3 — монорепо без пакета — FINAL
`pnpm install && pnpm turbo lint typecheck test`.
- **Expected**: зелено; в графе turbo нет `@budget/mcp-server` и никто не тянет его в
  зависимостях; `pnpm openapi` по-прежнему собирает обе половины контракта.
- **Status**: ⏸ pending
### F-4 — следов не осталось — FINAL
`git grep -n "mcp-server" -- . ':!docs' ':!.tasks'`, `git status --porcelain`.
- **Expected**: совпадения только в доках/артефактах (история), не в коде/конфигах/скриптах;
  `docs/mcp.md` описывает Python-сервер и цифру 35, а не 33; дерево без мусора пробы.
- **Status**: ⏸ pending
### F-5 — уборка и доклад — FINAL
Отозвать `$RO`/`$RW`, погасить API на 8021, удалить `/tmp/qa-mcp-up`.
- **Expected**: БД `budget_qa_mcpdec` ОСТАВЛЕНА и названа оркестратору (дроп — его решение);
  рабочая `budget` и порты 8010/5173 за прогон не тронуты ни разу.
- **Status**: ⏸ pending

## Итог прогона (блоки 1–2, 2026-09-20; блок 3 не запускался)
Всего в чеклисте: 17. **Прогнано 12** (STOP-probe 7 + allowlist 5).
**Passed: 10** (D1-1, D1-2, D1-4, D1-5, D1-7, A-1…A-5) /
**Failed: 1** (D1-3 — счётчики и дельта верны, но байтовый diff TS↔Python не пуст:
58 целочисленных границ Python печатает как float; семантически схемы равны, после
нормализации float→int diff пуст) /
**Blocked: 1** (D1-6 happy path — MinIO 9010 не запущен; отказная ветка пройдена) /
Не запускалось: 5 (F-1…F-5, блок FINAL — ⏸ по решению оркестратора).

**Статус: ❌ FAIL OVERALL по букве STOP-правила — `packages/mcp-server` НЕ удалять,
пока senior-lead не решил по D1-3.** Функционального регресса не найдено: новый сервер
поднимается по stdio, публикует 20/35/36 инструментов ровно по scope и каталогу, зовёт API
сквозь стек, сохраняет `client_id` и аудит, держит stdout чистым и отбивает symlink-путь.

**Окружение прогона (для оркестратора):** БД **`budget_qa_mcpdec`** на 5443 ОСТАВЛЕНА —
дроп его прерогатива. API на 8021 погашен, оба stdio-сервера завершены, `/tmp/qa-mcp-up`
удалён, токены `qa-ro`/`qa-rw` отозваны. Рабочая `budget`, порты 8010/5173/5433/8000/8081
и `docker-compose` не тронуты (MinIO намеренно НЕ поднимался).
