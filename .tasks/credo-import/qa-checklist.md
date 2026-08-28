# QA checklist: credo-import — точечные STOP-пробы (qa-engineer, 2026-08-28)

## Что это и чем не является
Точечный прогон живьём (7 проб + 1 добор), НЕ повторение pytest-сьюта.
В программу вошло только то, чего юнит-тест не доказывает: поднялся ли формат в
реестре живого сервера, проходит ли путь загрузка→предпросмотр→apply целиком на
реальном HTTP, и сходятся ли ЦИФРЫ, которые увидит пользователь (остаток счёта
против Closing Balance выписки).

Не вошло (закрыто дешевле): коды 404/403 на чужой сессии — скоупинг по user_id и
no-oracle 404 покрыты pytest'ом роутера; валидация формы multipart и
STATEMENT_FORMAT_UNKNOWN — pytest роутера; «обе колонки Turnover заполнены»,
пин канона `prior:v1`, кавычки в имени магазина на уровне функции — юнит-тесты
парсера; перевод словаря и бейдж непереведённого — зона web-qa.

## Окружение (одноразовое, снесено после прогона)
- Postgres: контейнер `budget-qa-credo-pg`, порт **5490**, база `budget_qa_credo`,
  `alembic upgrade head` → 0014. Живую базу 5443 и контейнеры пользователя не трогал.
- API: `uvicorn` на **8090**, `FX_SCHEDULER_ENABLED=false RECURRING_SCHEDULER_ENABLED=false`.
- Пользователь: `qa-credo@budgetqa.dev`. Логин ОДИН раз, токен переиспользован во всех пробах.
- Счета: `QA Credo USD` (starting_balance 100000 = 1 000.00 USD), `QA Credo GEL`.
- Файлы: синтетический xlsx, собранный openpyxl (деньги — текстовые ячейки с запятой
  тысяч, даты — голые Excel-serial без даты-формата). НАСТОЯЩАЯ выписка НЕ использовалась.
  6 строк: оплата YANDEX.EDA (пара 56.10 BYN), снятие ATM CREDO (пара 100.00 USD =
  валюта счёта), зачисление 1 500.00, конвертация 250.00, комиссия 1.50,
  НЕИЗВЕСТНАЯ грузинская операция `ბანკის უცნობი ოპერაცია` с `SHOP "SANTA-362" BAPB
  30.00 CHF`. Opening 1 000.00 → Closing 2 116.01, Income 1 500.00, Expenses 383.99.

## Пробы

### P-1: формат виден в реестре живого сервера — ✅ PASS
`GET /statement-imports/formats` → `{"formats":["priorbank_csv_v1","credo_xlsx_v1"]}`.

### P-2: загрузка на USD-счёт → 201 и разбор строк — ✅ PASS
`POST /statement-imports` (multipart, format=credo_xlsx_v1) → 201,
`rows_total=6, rows_blocked=0, rows_zero_skipped=0, by_match_status={new:6}`,
`period 2026-08-01…2026-08-28`. В `rows`:
- serial-даты разобраны в 2026-08-05…2026-08-09 (никакого сдвига на 1900-квирк);
- оплата: `merchant=YANDEX.EDA`, `original_amount_minor=5610 / original_currency=BYN`,
  `amount_minor=2015`, `kind=expense`;
- снятие: `merchant=ATM CREDO`, пара в валюте счёта НЕ сохранена (`original_*=null`) —
  конвенция prior соблюдена;
- зачисление и конвертация: `possible_transfer=true`; остальные — false;
- строка с НЕИЗВЕСТНОЙ грузинской операцией ЗАГРУЖЕНА (не 422), `bank_category` =
  оригинальная фраза, кавычки в `SHOP "SANTA-362" BAPB` уцелели, пара 3000 CHF взята.

### P-3: выписка USD на счёт GEL → 422 — ✅ PASS
`{"detail":"STATEMENT_CURRENCY_MISMATCH","statement_currency":"USD","account_currency":"GEL"}`.

### P-4: apply → транзакции и цифры пользователя — ✅ PASS
`POST /apply` → `{"created":6,"skipped":0,"replaced":0,"already_existed":0}`.
`GET /transactions`: 6 шт., `merchant=YANDEX.EDA` (не вся грузинская строка),
суммы 2015/10000/150000/25000/150/1234 в минорных единицах, `occurred_at` совпадают
с датами выписки, пара BYN/CHF на месте (`original_rate` посчитан).
**Сходимость цифр:** `balance_minor` счёта = **211601** = Closing Balance 2 116.01
из Account Details. Лишнего в расходы не попало.

### P-5: повторная загрузка того же файла → идемпотентность отпечатка — ✅ PASS
Вторая загрузка: `by_match_status={exact:6}`, `by_decision={skip:6}`, у каждой строки
ровно 1 кандидат. Повторный apply → `{"created":0,"skipped":6}`; транзакций всё ещё 6,
остаток по-прежнему 211601. Дублей нет.

### P-6: сломанный остаток (сдвинутая колонка) → 422 — ✅ PASS
422 `STATEMENT_PARSE_FAILED`; в логе сервера — строка, на которой разошлось:
`Transactions row 5: balance does not add up — the file says 2122.08, the turnovers give 2129.85`.
Номер строки — тот же, что пользователь видит в Excel.

### P-7: числовые денежные ячейки → 422 — ✅ PASS
Обложка числами: `Account Details Opening Balance: money must be a text cell …(int)`.

### P-7b (добор): числовые деньги ТОЛЬКО в сетке, обложка текстом → 422 — ✅ PASS
`Transactions row 2 Turnover (DB): money must be a text cell …(float)`.
Гейт стоит не только на обложке — из float деньги не берутся нигде.

## Итог
Всего: 8. Passed: 8. Failed: 0. Blocked: 0. **✅ READY FOR REVIEW** (в части бэкенда).

Наблюдение (не дефект, на будущее): при `ParsedRow.merchant=None` apply, как и для
prior, берёт срез описания — у конвертации получился `merchant="Currency Exchange"`.
На нашем формате безопасно (у остальных таких строк описание пустое), но грузинское
описание без известного префикса `გადახდა`/`განაღდება` целиком уедет в merchant.
Появится такая фраза на второй выписке — смотреть здесь.
