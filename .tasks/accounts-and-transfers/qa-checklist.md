# QA Checklist: accounts-and-transfers

## Scope
API-уровень (:8010): `/accounts`, `kind=transfer` в `/transactions`, вычисляемые
остатки, исключение перевода из агрегатов, PAT-allowlist. НЕ покрывает: web (W1/W2 —
web-qa), мобилку (MOB — mobile-qa), UI-хелпер направления из A3.
Каденция (senior-lead): полный прогон Секции D — ОДИН раз в конце скоупа; в середине
только STOP-пробы ниже. Тесты пишутся ПОСЛЕ имплементации, здесь только план.

## Preconditions (готовятся один раз, LOGIN ONCE)
- Сервер: `FX_SCHEDULER_ENABLED=false RECURRING_SCHEDULER_ENABLED=false`, порт 8010.
- Пользователи `qa-acc-a@budgetqa.dev` / `qa-acc-b@budgetqa.dev` / `Qa!Test1234`:
  LOGIN ONCE в начале прогона, токены в `$TA`/`$TB`, переиспользуются во ВСЕХ TC
  (кроме TC-38 — он про auth). Все id счетов/транзакций — в переменные (`jq -r .id`).
- Счета A: `USD_CARD`(USD/card/start 100000), `BYN_CARD`(BYN/card/0),
  `JPY_CASH`(JPY/cash/10000 — exponent 0, это ¥10000), `OLD`(archived); у B: `B_CARD`(USD).


## Секция A — STOP-пробы после B1 (миграция + новая денежная поверхность), 5 шт.
_Прогнаны в середине скоупа (S1-1..S1-5 ✅), в финальном прогоне не повторялись._
Сразу после B1, до старта B2/M1/W1.
- **S1-1 (миграция + boot)**: сервер поднялся; `POST /accounts` (USD, start 100000)
  → 201; `GET /accounts` → `balance_minor == starting_balance_minor == 100000`;
  архивный счёт присутствует в списке (archived-inclusive).
- **S1-2 (перевод happy)**: transfer USD_CARD 10000 → BYN_CARD 33000 → 201, в ответе
  `category_id`/`base_amount_minor`/`base_currency` = null, `transfer_rate` ≈ `3.3`;
  `GET /accounts`: 90000 и 33000.
- **S1-3 (валюта + same-account)**: `currency:"EUR"` на USD_CARD → 422
  `ACCOUNT_CURRENCY_MISMATCH`; counter == account → 422 `SAME_ACCOUNT_TRANSFER`;
  без `currency` → 201 со штампом от счёта.
- **S1-4 (no-oracle)**: чужой `account_id` (счёт B) vs случайный UUID → байт-идентичные
  404 `ACCOUNT_NOT_FOUND` (`diff` пуст); то же для `counter_account_id`.
- **S1-5 (регрессия kind_valid)**: expense/income создаются как раньше (base-пара на
  месте), `kind:"bogus"` → 422 — CHECK принял ровно третье значение.

## Секция B — STOP-пробы после B2 и M1
_Прогнаны в середине скоупа (S2-1..S2-3, S3-1..S3-2 ✅), в финальном прогоне не повторялись._
**B2 — да** (обоснование): здесь «перевод не трата» впервые наблюдаем; ошибка фильтра
в `tx_totals` тихо портит 6 read-поверхностей, поверх которых W1/W2/MOB строят экраны.
3 пробы:
- **S2-1**: снимок `/stats/summary` + `/transactions/summary` → создать перевод →
  снимок снова → `diff` пуст (включая `unconverted_count`, `by_bucket`/`by_category`).
- **S2-2**: `/transactions/export` содержит строку перевода и колонки
  `account,counter_account,counter_amount`; `?account_id=$BYN` отдаёт counter-ногу.
- **S2-3**: `POST /recurring` без `account_id` → 422; с ним → 201 и материализованная
  транзакция несёт тот же `account_id`.

**M1 — да, нужны** (новая auth-поверхность, fail-closed allowlist). 2 пробы:
- **S3-1**: write-PAT → `GET/POST /accounts` и `PATCH /accounts/{id}` 200/201.
- **S3-2**: read-PAT → `POST /accounts` 403 `TOKEN_SCOPE_READONLY`; не-allowlist
  маршрут (`DELETE /accounts/{id}`) любым PAT → 403 `TOKEN_ENDPOINT_FORBIDDEN`.


## Секция C — pytest-темы (owner: backend-engineer; QA верифицирует зелёным прогоном)
_Статус: ЗАКРЫТО PYTEST (P-1..P-10) — curl'ом не переигрывалось, прогон `make test` за оркестратором._
- P-1 Формула остатка: все 4 слагаемых сразу, отрицательный старт, счёт и как source
  и как target; JPY (exponent 0) — без ×100.
- P-2 `transfer_rate` на известных парах (10000 USD → 33000 BYN = 3.3; 10000 USD →
  15000 JPY = 150), квантование ROUND_HALF_UP, Decimal-строка.
- P-3 CHECK-инварианты §3 на уровне БД (обход схемы: прямой insert) — все 5.
- P-4 `tx_totals` contrast: те же данные с transfer и без дают ИДЕНТИЧНЫЕ
  `converted_totals`/`monthly`/`merchant`/`_bucket_three_rows`.
- P-5 goal free balance и `limits.spent` не меняются от перевода.
- P-6 Идемпотентность `client_id` для transfer, включая recovery-ветку IntegrityError.
- P-7 PATCH `account_id` транзакции: перештамповка currency + пересчёт base-снапшота.
- P-8 no-oracle параметризованно: account_id, counter_account_id, PATCH /accounts —
  байт-идентичные тела «чужой vs несуществующий».
- P-9 Guard order: чужой АРХИВНЫЙ счёт → `ACCOUNT_NOT_FOUND`, не `ACCOUNT_ARCHIVED`.
- P-10 Контрактный drift-тест пары openapi.json + schema.d.ts (уже существует).

## Секция D — полный сквозной curl-чеклист (конец скоупа)
Формат: **TC-N** — шаг → ожидание, статус ⏸ pending. Порядок значим: TC-1..TC-5
создают счета, остальные TC используют их id.

### Счета и остатки (B1)
- **TC-1** POST/GET/PATCH /accounts happy → 201/200; omit=keep не сбрасывает поля;
  `DELETE /accounts/{id}` → 405. ✅
- **TC-2** Микс на USD_CARD: +income 50000, −expense 20000, −transfer 10000 → 120000; BYN_CARD +33000. ✅ 100000+50000−20000−10000=120000, BYN 33000.
- **TC-3** JPY_CASH (exp 0): старт ¥10000; transfer USD 10000 → JPY 15000 → 25000, rate 150, нигде ×100. ✅ JPY 10000+15000=25000, rate `150`, ×100 нигде.
- **TC-4** PATCH `starting_balance_minor` (в т.ч. −5000) → `balance_minor` сдвинулся ровно на дельту. ✅ 0→−5000→+7000→0: balance 33000→28000→40000→33000.
- **TC-5** Валидация: без name/currency/type → 422; `"usd"` → 422; type `"btc"` → 422;
  name 101 символ → 422; unicode/эмодзи на 100 символов → 201. ✅ +пусто/`USDD`/float → 422; 100 симв. эмодзи → 201.
- **TC-6** Пустое состояние: у свежесозданного пользователя `GET /accounts` → `[]`. ✅ `[]` и с `include_archived=true`, `/transactions` `{items:[],total:0}`.

### Инварианты перевода (B1)
- **TC-7** transfer с `category_id` → 422 (не 500). ✅ код `TRANSFER_CATEGORY_FORBIDDEN`.
- **TC-8** без counter-пары → 422 `TRANSFER_FIELDS_REQUIRED`; counter-поля на expense → 422 `COUNTER_FIELDS_WITHOUT_TRANSFER`. ✅ включая половинчатую пару (только counter_account / только counter_amount).
- **TC-9** same-account → 422 `SAME_ACCOUNT_TRANSFER`; counter_amount 0/−1 → 422; 2^40 → 201, баланс верен. ✅ 0/−1 → 422 (`ge=1`), 2^40 → 201 балансы верны, 1e15 → 422 (`le`).
- **TC-10** transfer с присланной base-парой → 422; в GET base-пара всегда null. ✅ код `TRANSFER_BASE_AMOUNT_FORBIDDEN`; присланный `counter_currency` игнорируется (штамп от счёта).
- **TC-11** PATCH сумм независимо → rate пересчитан, балансы сошлись; PATCH `kind` transfer↔expense → 422 `KIND_CHANGE_UNSUPPORTED`. ✅ rate 1.5→4→400; смена `counter_account_id` перештамповывает `counter_currency`.
- **TC-12** DELETE transfer → оба баланса вернулись к значениям до создания. ✅ USD 108000→110000, JPY 33000→25000; повторный DELETE → 404.
- **TC-13** Два POST transfer с одним `client_id` → тот же `id`, балансы сдвинулись ОДИН раз;
  третий с тем же client_id и другими суммами → исходная строка, балансы не тронуты. ✅ один id на 3 POST (201/200/200), балансы сдвинулись один раз, в списке 1 строка.

### Перевод — не трата (B2, критично)
Приём: снимок агрегата до → создать transfer → снимок после → `diff` пуст.
- **TC-14** `GET /stats/summary` (incl. `by_category`, `unconverted_count`). ✅ diff пуст (2 раунда: текущий месяц и прошлый).
- **TC-15** `GET /stats/monthly`. ✅ diff пуст.
- **TC-16** `GET /transactions/summary`. ✅ diff пуст.
- **TC-17** `GET /limits` — `spent` не изменился. ✅ `spent_minor` не изменился (лимит на «Жильё», 2026-07 и 2026-08).
- **TC-18** `GET /stats/top-merchants` — перевод с заполненным merchant не появился. ✅ перевод с `merchant` в items не появился.
- **TC-19** `GET /goals` — `free_balance_minor` не изменился. ✅ `free_balance_minor` 5063005 до и после июльского перевода (неврождённый ноль).
- **TC-20** `POST /advisor/ask`: без ANTHROPIC_API_KEY ожидаем 503 `AI_NOT_CONFIGURED`
  ⇒ TC заранее 🚫 blocked, реальное покрытие — P-4 (advisor едет на tx_totals). 🚫 blocked: нет ANTHROPIC_API_KEY, подтверждено 503 `AI_NOT_CONFIGURED`; покрытие — P-4.
- **TC-21** CSV `/transactions/export`: строка перевода ЕСТЬ, колонки account/counter_account/counter_amount, base-ячейки пусты. ✅ counter_amount в СВОЕЙ валюте: JPY `15000`/`7500` без десятичных, BYN `330.00`; base/category-ячейки пусты.
- **TC-22** `?account_id=$USD` отдаёт перевод как source-ногу, `?account_id=$BYN` — как counter
  (обе ноги = история счёта); `?kind=transfer` отдаёт только переводы. ✅ один и тот же id с обеих сторон, без фильтра 13 строк / 13 уникальных id.

### Валюта и счёт транзакции (B1)
- **TC-23** mismatch на expense и на transfer → 422 `ACCOUNT_CURRENCY_MISMATCH`; опущена → штамп от счёта. ✅ на expense и на transfer (source); опущенная — штамп от счёта.
- **TC-24** PATCH /accounts с `currency` → 422 `ACCOUNT_CURRENCY_IMMUTABLE`. ✅ в т.ч. PATCH тем же значением `USD` → тоже 422.
- **TC-25** PATCH `account_id` (USD-расход → BYN_CARD): currency стал BYN, base-снапшот пересчитан, балансы сошлись. ✅ currency USD→BYN, base 1692182→561608, балансы ±20000; `account_id`+чужая currency → 422.

### No-oracle и авторизация (B1)
- **TC-26** POST: чужой `account_id` vs случайный UUID → байт-идентичный 404 `ACCOUNT_NOT_FOUND` (сверять `-i` целиком). ✅ `diff -i` по всему ответу с заголовками пуст.
- **TC-27** То же для `counter_account_id` (отдельный кейс: чужой счёт как приёмник). ✅
- **TC-28** PATCH /accounts/{чужой} vs {случайный} → идентичные 404. ✅
- **TC-29** `GET /transactions?account_id=` чужой vs случайный → одинаковый ответ, без различия. ✅ и то же для `/transactions/export?account_id=`.

### Архив (B1)
- **TC-30** Запись на архивный как `account_id` → 422 `ACCOUNT_ARCHIVED`; как `counter_account_id` → тоже 422. ✅ обе роли + PATCH существующей транзакции на архивный счёт → 422.
- **TC-31** История архивного (`?account_id=$OLD`) читается, счёт в `GET /accounts` с верным балансом. ✅ история 2 строки (расход + входящий перевод), баланс 5500 при `include_archived=true`.
- **TC-32** Разархивация PATCH `archived:false` → запись снова разрешена. ✅

### PAT / MCP (M1)
- **TC-33** write-PAT: GET 200, POST 201, PATCH 200 на /accounts; `POST /transactions` transfer 201. ✅
- **TC-34** read-PAT: GET /accounts 200; POST/PATCH /accounts и POST /transactions → 403 `TOKEN_SCOPE_READONLY`. ✅
- **TC-35** fail-closed: `DELETE|GET /accounts/{id}` под PAT → 403 `TOKEN_ENDPOINT_FORBIDDEN`, отказ в `pat_audit_log`. ⚠️ fail-closed подтверждён на 4 СУЩЕСТВУЮЩИХ не-allowlist маршрутах (export/recurring/limits/goals DELETE) → 403 + строки в `pat_audit_log`. Проба из чеклиста мимо: `GET|DELETE /accounts/{id}` таких маршрутов нет вообще → 405 Method Not Allowed до зависимости (оракула нет: 405 одинаков без токена).
- **TC-36** Старый PAT получает ровно те же три пары, не больше; `GET /tokens/self` — scope неизменен. ✅ `/tokens/self` отдаёт scope full/read без изменений.

### Регрессия и контракт
- **TC-37** expense/income: create/PATCH/DELETE, base-снапшот, вклад в `/stats/summary` — как до скоупа. ✅ create/PATCH/override/null-recompute/DELETE; `/stats/summary` вернулся к байтовому baseline.
- **TC-38** Auth (один раз на роутер): `GET /accounts` без токена / с битым / с просроченным → 401. ✅ без токена / битый / чужая схема / протухшая подпись → 401 `Unauthorized`; фейковый PAT → 401 `TOKEN_INVALID`.
- **TC-39** recurring: шаблон `kind:"transfer"` → 422 (v1 не поддерживает); expense материализуется с account_id. ✅ `RECURRING_TRANSFER_UNSUPPORTED`; чужой счёт 404, архивный 422; шаблон несёт `account_id`+`currency`. Материализация — S2-3/pytest (шедулеры выключены).
- **TC-40** Контракт: `/openapi.json` содержит `/accounts`, `transfer_rate`, counter-поля; drift-тест зелёный. ✅ live `/openapi.json` == `apps/api/openapi.json` побайтно; `schema.d.ts` несёт `transfer_rate`/`counter_currency`/`balance_minor`; пара в git чистая; CORS-preflight PATCH /accounts 200.

### B3-пробы (PATCH /recurring/{id} — перенос шаблона на другой счёт, plan-b3.md)
- **B3-a** перенос на счёт другой валюты (USD→BYN) → 200, `currency` перештампована в `BYN`, `next_due_on` не тронут. ✅
- **B3-b** `account_id: null` → 422 `ACCOUNT_REQUIRED`. ✅
- **B3-c** чужой vs несуществующий счёт → 404 `ACCOUNT_NOT_FOUND`, `diff -i` по всему ответу с заголовками пуст. ✅
- **B3-d** архивный счёт → 422 `ACCOUNT_ARCHIVED`, шаблон не изменён. ✅
- **B3-e** новый счёт + старая валюта → 422 `ACCOUNT_CURRENCY_MISMATCH`, ничего не применено. ✅
- **B3-f** (доп.) перенос на JPY (exponent 0) → 200, `currency:"JPY"`, `amount_minor` НЕ пересчитан (25000 → ¥25000 вместо $250) — принятое решение plan-b3 «Риски», клиенту нужно предупреждение. ✅ (info)
- **B3-g** (доп.) новый счёт + СОВПАДАЮЩАЯ валюта → 200. ✅


## Итог прогона (2026-08-19, финальный API-прогон, curl @ :8010)
- Всего Секция D: 40 TC (+7 B3-проб). Секции A/B прогнаны в середине скоупа, Секция C закрыта pytest.
- **Passed: 38** (TC-1..TC-19, TC-21..TC-34, TC-36..TC-40)
- **Warned: 1** — TC-35 (fail-closed доказан на других маршрутах; проба чеклиста нерелевантна, см. запись)
- **Blocked: 1** — TC-20 (нет ANTHROPIC_API_KEY; 503 `AI_NOT_CONFIGURED` подтверждён, покрытие через P-4)
- **Failed: 0**
- Семь проверок PM: 1 «перевод не трата» ✅ (6 поверхностей × 2 раунда, diff пуст) · 2 «остатки сходятся» ✅ (10 счетов, ручной расчёт == независимый пересчёт == сервер) · 3 «одна операция с двух сторон» ✅ · 4 «курс перевода» ✅ (одинаковые валюты дают `"1"`, а не null — по A2) · 5 «чужой счёт не нащупывается» ✅ · 6 «архивный счёт» ✅ · 7 «CSV» ✅
- Уборка: все созданные транзакции/шаблоны удалены, счета архивированы, PAT-токены отозваны.
- **Вердикт: ✅ READY FOR REVIEW**
