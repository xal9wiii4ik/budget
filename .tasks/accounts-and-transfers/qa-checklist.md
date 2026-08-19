# QA Checklist: accounts-and-transfers

## Scope
API-уровень (:8010): `/accounts`, `kind=transfer` в `/transactions`, вычисляемые
остатки, исключение перевода из агрегатов, PAT-allowlist. НЕ покрывает: web (W1/W2 —
web-qa), мобилку (MOB — mobile-qa), UI-хелпер направления из A3.

## Программа после реза PM (2026-08-19)
Директива PM: не перепроверять curl'ом то, что доказано зелёным pytest'ом. Живой
HTTP оставлен только там, где pytest бессилен: реальный boot, реальный сквозной
маршрут, семь PM-проверок и свежая фича B3.
**Осталось 12 сценариев** (L-1, L-2, PM-3..PM-7, B3-a..e) — против 40 TC исходной
Секции D. Вычеркнутые 28 перечислены поимённо в «Реестре вычеркнутого» ниже, у
каждого — чем закрыт. Прогон, состоявшийся ДО реза, засчитан как есть: сценарии
ниже несут фактические результаты, повторно не переигрывались.

## Preconditions (LOGIN ONCE)
- Сервер: `FX_SCHEDULER_ENABLED=false RECURRING_SCHEDULER_ENABLED=false`, порт 8010.
- `qa-acc-a@budgetqa.dev` / `qa-acc-b@budgetqa.dev` / `Qa!Test1234`: логин ОДИН раз
  в начале прогона, токены в `$TA`/`$TB`, переиспользуются во ВСЕХ сценариях.
- Базовая валюта пользователя A — RUB (важно для чтения base-снапшотов и агрегатов).


## Живой смоук (то, чего pytest не доказывает: реальный процесс и реальный HTTP)

### L-1 — сервер поднят и отвечает по-настоящему
- `GET /health` → 200; `GET /openapi.json` → 200 и байт-в-байт равен
  `apps/api/openapi.json` (живая схема == закоммиченная).
- **Статус: ✅** (health 200, openapi 200; побайтное равенство подтверждено).

### L-2 — ОДИН сквозной сценарий на живом HTTP = PM-проверки 1 и 2
Две карты → пополнил → потратил → перевёл → остатки + статистика. Отдельно PM-1/PM-2
не дублируются: это они и есть.
- Счета: `USD_CARD` (USD, старт 100000), `BYN_CARD` (BYN, старт 0), `RUB_CASH`
  (RUB, старт 20000).
- Движения: income 50000 USD; expense 500 USD; expense 1500 RUB; transfer
  10000 USD → 33000 BYN.
- **PM-2 «остаток до копейки»**: независимый пересчёт всех слагаемых по выгрузке
  `/transactions` сверен со `balance_minor` из `/accounts` по 10 счетам —
  расхождений нет ни на одну минорную единицу.
  Наблюдалось: USD_CARD 100000+50000−500−10000 = **139500** ✅, BYN_CARD
  0+33000 = **33000** ✅, RUB_CASH 20000−1500 = **18500** ✅.
- **PM-1 «перевод не трата на всех ШЕСТИ поверхностях»** — перевод 100.00 USD /
  330.00 BYN не проник ни в одну денежную сумму:
  1. `GET /transactions/summary?month=2026-08` → income 4230455, expense **43805**
     (= 42305 конвертированные 5 USD + 1500 RUB), перевода нет; `unconverted_count` 0.
  2. `GET /stats/summary?period=month&month=2026-08` → те же 4230455 / **43805**,
     `by_category` без строки перевода, `previous` нули.
  3. `GET /stats/monthly` → точка 2026-08: expense **43805**, net 4186650.
  4. `GET /limits?month=2026-08` → `items` без вклада перевода.
  5. `GET /stats/top-merchants` → перевод не появился (0 позиций).
  6. `GET /goals` → `free_balance_minor` переводом не сдвинут.
  Плюс исходный прогон делал этот же diff в два раунда (текущий и прошлый месяц) —
  diff пуст, включая `by_bucket`/`by_category`/`unconverted_count`.
- **Статус: ✅**

## Семь PM-проверок (1 и 2 — внутри L-2; ниже 3-7)

### PM-3 — одна операция видна с двух сторон
`GET /transactions?account_id=$USD` и `?account_id=$BYN` отдают ОДИН И ТОТ ЖЕ id
перевода (обе ноги = история счёта); `?kind=transfer` отдаёт только переводы;
без фильтра дублей нет (13 строк / 13 уникальных id).
- **Статус: ✅**

### PM-4 — курс перевода
`transfer_rate` в ответе: 10000 USD → 33000 BYN = `3.3`; 10000 USD → 15000 JPY =
`150` (JPY exponent 0 — нигде ×100); PATCH любой ноги пересчитывает курс
(1.5 → 4 → 400); одинаковые валюты дают `"1"`, а не null (решение A2).
- **Статус: ✅**

### PM-5 — чужой счёт не нащупывается (ОДНА живая проба, не четыре)
`POST /transactions` с `account_id` чужого счёта vs со случайным UUID → 404
`ACCOUNT_NOT_FOUND`, `diff -i` по всему ответу вместе с заголовками пуст.
Остальные три поверхности (counter_account_id, PATCH /accounts, фильтр списка) —
параметризованный pytest P-8, живьём не дублируются.
- **Статус: ✅**

### PM-6 — архивный счёт
Запись на архивный счёт обеими ролями (`account_id` и `counter_account_id`) → 422
`ACCOUNT_ARCHIVED`; история архивного читается (`?account_id=$OLD` → 2 строки),
счёт виден в `GET /accounts?include_archived=true` с верным балансом 5500;
разархивация `PATCH {archived:false}` возвращает право записи.
- **Статус: ✅**

### PM-7 — CSV
`GET /transactions/export`: строка перевода ПРИСУТСТВУЕТ, колонки
`account,counter_account,counter_amount` заполнены, `counter_amount` в СВОЕЙ валюте
(BYN `330.00`, JPY `15000` без десятичных), ячейки base/category у перевода пусты.
Перепроверено живьём при уборке — заголовок и строка перевода те же.
- **Статус: ✅**

## B3 — PATCH /recurring/{id}, перенос шаблона на другой счёт (свежая фича)
Живой HTTP-проход по новому маршруту; pytest по B3 PM гоняет отдельно.
- **B3-a** перенос на счёт другой валюты (USD→BYN) → 200, `currency` перештампована
  в `BYN`, `next_due_on` не тронут. **✅**
  _Заметка (info, не дефект):_ при перештамповке `amount_minor` НЕ пересчитывается —
  перенос на JPY даёт `¥25000` вместо `$250`. Это принятое решение plan-b3 «Риски»;
  клиенту нужно предупреждение в UI.
- **B3-b** `account_id: null` → 422 `ACCOUNT_REQUIRED`. **✅**
- **B3-c** чужой vs несуществующий счёт → 404 `ACCOUNT_NOT_FOUND`, `diff -i` по
  всему ответу с заголовками пуст. **✅**
- **B3-d** архивный счёт → 422 `ACCOUNT_ARCHIVED`, шаблон не изменён. **✅**
- **B3-e** новый счёт + старая валюта → 422 `ACCOUNT_CURRENCY_MISMATCH`, ничего не
  применено. **✅**


## Реестр вычеркнутого (28 TC исходной Секции D)
Каждая строка — чем закрыто. Это не потеря покрытия, а отказ от третьей проверки
того же.

| TC | Чем закрыто |
|---|---|
| TC-1 accounts CRUD / omit=keep / DELETE 405 | `test_accounts.py::TestAccountCrud::test_create_reports_opening_balance_and_patch_keeps_omitted_fields`; DELETE-маршрута нет в контракте — drift-тест `test_openapi_export.py`; happy-path счетов проходит внутри L-2 |
| TC-2 микс движений на счёте | свёрнут в L-2 (PM-2) |
| TC-3 JPY exponent 0 | `test_accounts.py::TestBalance::test_balance_sums_every_leg_at_its_own_account` (P-1); rate на JPY — PM-4 |
| TC-4 PATCH starting_balance_minor | `test_accounts.py::TestBalance::test_patching_the_opening_balance_shifts_the_computed_one` |
| TC-5 валидация полей счёта (422) | схемная валидация pytest — `TestAccountCrud`; PM: валидацию полей не переигрываем |
| TC-6 пустое состояние | `test_accounts.py::test_new_user_has_no_accounts` |
| TC-7 transfer с category_id | `test_transfers.py::TestCreateTransfer::test_malformed_transfers_are_422_not_500` |
| TC-8 counter-пара / counter-поля на expense | там же + `test_counter_fields_on_a_non_transfer_are_rejected` |
| TC-9 same-account, границы 0/−1/2^40 | `test_malformed_transfers_are_422_not_500` + `TestDatabaseInvariants::test_half_transfers_are_unrepresentable` |
| TC-10 base-пара на переводе | `TestCreateTransfer::test_transfer_stamps_both_legs_and_carries_no_snapshot` |
| TC-11 PATCH сумм / смена kind | `TestPatchTransfer::test_editing_either_leg_recomputes_the_rate_and_both_balances` + `test_changing_the_kind_across_transfer_is_refused` |
| TC-12 DELETE transfer откатывает балансы | баланс вычисляемый, не хранимый — `TestBalance` (строка исчезла ⇒ слагаемое исчезло) |
| TC-13 идемпотентность client_id | P-6: `test_transaction_idempotency.py::TestReplay`/`TestRace` + `test_transfers.py::test_replaying_a_transfer_moves_the_money_once` |
| TC-14 stats/summary | свёрнут в PM-1 (L-2), поверхность 2; pytest `TestTransfersAreInvisibleToAggregates::test_stats_summary_ignores_transfers` |
| TC-15 stats/monthly | свёрнут в PM-1, поверхность 3; pytest `test_stats_monthly_ignores_transfers` |
| TC-16 transactions/summary | свёрнут в PM-1, поверхность 1; pytest `test_transactions_summary_ignores_transfers` |
| TC-17 limits.spent | свёрнут в PM-1, поверхность 4; pytest `test_limits_ignore_transfers` |
| TC-18 top-merchants | свёрнут в PM-1, поверхность 5 |
| TC-19 goals free_balance | свёрнут в PM-1, поверхность 6; pytest `test_goals_free_balance_ignores_transfers` |
| TC-20 advisor | 🚫 без ANTHROPIC_API_KEY (503 `AI_NOT_CONFIGURED` подтверждён); покрытие — P-4: advisor едет на тот же `tx_totals` |
| TC-21 CSV | свёрнут в PM-7; pytest `TestTransferExport::test_export_carries_both_accounts_and_the_arriving_amount` |
| TC-22 фильтр по счёту (обе ноги) | свёрнут в PM-3; pytest `TestAccountFilter::test_account_filter_matches_either_leg` |
| TC-23 ACCOUNT_CURRENCY_MISMATCH | `test_transfers.py` (3 вхождения кода) |
| TC-24 currency immutable | `test_accounts.py::TestAccountCrud::test_currency_is_immutable` |
| TC-25 PATCH account_id, перештамп + base | P-7: `TestPatchTransfer::test_moving_a_row_to_a_foreign_currency_account_restamps_it` |
| TC-26..TC-29 no-oracle (4 поверхности) | P-8/P-9: `TestNoOracle::test_foreign_and_missing_account_answer_identically` + `TestTransferGuardOrder::test_foreign_and_missing_accounts_answer_identically`; живьём осталась ОДНА проба PM-5 |
| TC-30..TC-32 архив (3 TC) | свёрнуты в ОДНУ пробу PM-6; pytest `test_writing_to_an_archived_own_account_is_rejected`, `test_own_archived_target_is_rejected_as_archived`, `test_list_hides_archived_until_asked_and_still_reports_its_balance` |
| TC-33..TC-36 PAT-матрица | `test_pat_auth.py` (класс на три пары `/accounts`: full листает/создаёт/правит, read — только листает, не-allowlist → `TOKEN_ENDPOINT_FORBIDDEN`) + STOP-пробы S3-1/S3-2 середины скоупа |
| TC-37 регрессия expense/income | сквозной income+expense внутри L-2 + `test_transactions.py` |
| TC-38 auth 401 | `test_accounts.py::TestAccountCrud::test_requires_auth` + `test_auth.py` |
| TC-39 recurring: transfer-шаблон 422, account_id | `test_recurring_api.py` + STOP-проба S2-3 |
| TC-40 контракт | drift-тест `test_openapi_export.py::test_committed_schema_matches_current_app`; живой `/openapi.json` остался частью L-1 |
| B3-f / B3-g (доп.) | f — оставлен заметкой под B3-a (принятый риск plan-b3); g — `test_recurring_api.py::TestPatchAccountMove::test_move_restamps_currency_from_the_target_account` |

## STOP-пробы середины скоупа (историческая запись, не переигрывались)
- **Секция A (после B1)**: S1-1 миграция+boot, S1-2 перевод happy, S1-3 валюта+
  same-account, S1-4 no-oracle, S1-5 регрессия kind_valid — все ✅.
- **Секция B (после B2/M1)**: S2-1 агрегаты не сдвинулись, S2-2 CSV+фильтр,
  S2-3 recurring требует счёт, S3-1 write-PAT, S3-2 read-PAT+fail-closed — все ✅.

## Секция C — pytest-темы (owner: backend-engineer)
P-1..P-10 (формула остатка, transfer_rate, CHECK-инварианты БД, contrast
`tx_totals`, goals/limits, идемпотентность, перештамп при PATCH account_id,
no-oracle параметризованно, guard order, контрактный drift). Верифицируются
зелёным `make test` за оркестратором; curl'ом не переигрываются.


## Итог (2026-08-19, программа после реза PM)
- **Сценариев в программе: 12** (L-1, L-2, PM-3..PM-7, B3-a..e). Вычеркнуто 28 TC —
  каждый с указанием, чем закрыт (реестр выше).
- **Passed: 12** · **Failed: 0** · **Blocked: 0**
  (TC-20/advisor больше не сценарий — вычеркнут в реестр как 🚫 без ключа, покрытие P-4;
  TC-35/fail-closed вычеркнут в реестр: живьём подтверждён на 4 не-allowlist маршрутах,
  собственной пробы `GET|DELETE /accounts/{id}` не существует — таких маршрутов нет.)
- **Семь PM-проверок**: 1 «перевод не трата» ✅ (6 поверхностей) · 2 «остаток до
  копейки» ✅ (10 счетов, независимый пересчёт == сервер) · 3 «одна операция с двух
  сторон» ✅ · 4 «курс перевода» ✅ · 5 «чужой счёт не нащупывается» ✅ (одна проба) ·
  6 «архивный счёт» ✅ · 7 «CSV» ✅
- **Уборка**: выполнена и проверена — у обоих QA-пользователей 0 активных счетов,
  0 транзакций, 0 живых PAT. (Прошлый прогон оставил хвост от STOP-проб: 4 транзакции
  и 3 активных счёта у A — снесены сейчас.)
- **Вердикт: ✅ READY FOR REVIEW**
