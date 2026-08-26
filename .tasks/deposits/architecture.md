# Architecture Plan: deposits — вклады, ручной ввод

## Context
Вклад — отдельная сущность (решение пользователя), но движение денег обязано
остаться существующим transfer-механизмом, а фильтрация агрегатов — единственной
точкой в `tx_totals.py`.

## Вердикт по гипотезе senior-lead
ПРИНЯТА. `Deposit` = таблица метаданных + скрытый 1:1 счёт `AccountType.deposit`.
Это не противоречит решению «отдельная сущность»: для пользователя и API вклад —
своя сущность со своей вкладкой; счёт — внутренняя деталь реализации (ledger).
Перевод счёт↔вклад = обычный transfer на `deposit.account_id`; балансы, валюта,
история, CHECKи 0008 и исключение из агрегатов работают без единой новой строки.
Одно отклонение: капитализация — ОДИН enum, не boolean+enum (см. ниже).

## Database changes (миграция 0012)

### Enum
- `AccountType`: append `deposit` (строго в конец, порядок load-bearing);
  0012 пересобирает CHECK `type_valid` на `('card','cash','deposit')`.
- Новый `DepositCapitalization`: `none | monthly | quarterly | at_maturity`.
  Один столбец вместо boolean+период: исключает невалидную комбинацию
  «капитализации нет, но период задан» без лишнего CHECK. `none` = простой процент.

### Tables
- `deposits`:
  - `id` (UUID PK)
  - `user_id` (UUID, FK users ON DELETE CASCADE, NOT NULL, index)
  - `account_id` (UUID, FK accounts ON DELETE RESTRICT, NOT NULL, UNIQUE) —
    удаления счетов в системе нет (archive-only), RESTRICT фиксирует инвариант
  - `name` (String(100))
  - `rate_percent` (Numeric(8,4), CHECK >= 0) — годовая ставка, Decimal на wire (строка)
  - `capitalization` (String(16), CHECK по enum)
  - `opened_on` (Date NOT NULL) — может быть в прошлом
  - `term_end` (Date NULL; NULL = бессрочный; CHECK `term_end > opened_on`)
  - `tax_rate_percent` (Numeric(5,2) NULL, CHECK 0..100)
  - `accrued_override_minor` (BigInteger NULL) + `accrued_override_as_of` (Date NULL);
    CHECK: оба NULL или оба заданы
  - `archived` (Boolean, default false), `created_at`
  - Валюты НЕТ: единственный источник — валюта связанного счёта.

### Migration steps
1. Пересобрать `type_valid` на accounts (+'deposit').
2. Создать `deposits` со всеми CHECK. Backfill не нужен.

## Поведение счетов типа deposit
- POST `/deposits` создаёт счёт (type=deposit, currency из запроса, starting=0)
  и строку deposits одной транзакцией.
- GET `/accounts` deposit-счета НЕ отдаёт (server-side `type != 'deposit'`) →
  пикеры и любые «итого» чисты by construction; клиентский флаг не нужен.
- GET/PATCH `/accounts/{id}` по deposit-счёту → 404 `ACCOUNT_NOT_FOUND`
  (управление только через /deposits; тот же код — no-oracle).
- POST `/accounts` не принимает type=deposit: схема create пинит `('card','cash')`
  (прецедент — recurring_template пинит kinds).
- expense/income (и recurring-шаблон) на deposit-счёт → 422
  `DEPOSIT_ACCOUNT_TRANSFER_ONLY`. Только transfer — агрегаты чисты без второй
  точки фильтрации (`tx_totals` уже режет transfer).
- Архив вклада = archive deposit + archive его счёта одной транзакцией → переводы
  на него блокирует СУЩЕСТВУЮЩИЙ guard `ACCOUNT_ARCHIVED`.
- История вклада = `GET /transactions?account_id=<deposit.account_id>` (уже
  матчит обе ноги) — DepositRead несёт `account_id`.

## Расчёт процентов — `domain/deposits.py` (pure, no IO)
Вход: ставка Decimal, режим капитализации, opened_on, term_end, валюта (экспонента),
таймлайн `[(date, delta_minor)]` из transfer-легов счёта, `as_of`, опциональный
якорь `(override_as_of, override_minor)`.

- **Day-count: actual/365 fixed.** Одна конвенция: проще, стандарт retail-вкладов
  BY/RU; actual/actual даёт копеечную разницу в ПРОГНОЗЕ ценой ветвления на
  високосных годах. Зафиксировано, в тестах — явно.
- Simple (`none`): сумма по сегментам постоянного тела `principal * rate * days/365`.
- Compound: на каждой границе периода накопленное присоединяется к телу;
  округление до минорных единиц ROUND_HALF_UP в момент капитализации (как банк),
  промежуточно — Decimal без округления.
- Начисление останавливается на `min(as_of, term_end)`.
- Отрицательное тело (снятие больше остатка — ledger это допускает): сегменты с
  телом < 0 дают 0 начисления (`max(principal, 0)`), отрицательных процентов нет.
- Задним числом: таймлайн — реальные даты transfer-ов; пользователь датирует
  первый перевод датой открытия (транзакции в прошлом уже поддержаны). Отдельного
  «начального тела» на вкладе НЕТ — второй источник правды о деньгах запрещён.
- Границы для тестов: високосный год, ставка 0, срок целиком в прошлом,
  пополнение в середине периода капитализации, снятие в минус, override-якорь.

## Ручная правка (решение: прогноз ПРОДОЛЖАЕТ от якоря)
- «Рассчитать на сегодня» — НЕ отдельный эндпоинт: GET /deposits(/{id}) всегда
  несёт серверный `accrued_minor` as_of today. Кнопка показывает его; правка →
  PATCH с `accrued_override_minor` (+ сервер ставит `accrued_override_as_of` = today).
- Прогноз продолжает от якоря: override — фактическое число банка, дальше
  капитализация/начисление идут от него по расписанию. «Замирание» делало бы
  прогноз враньём назавтра. Новый override заменяет старый (истории нет).
- PATCH-семантика проекта: omit=keep, null=clear (пересчёт с нуля от таймлайна).

## Срок
- `term_end` NULLABLE — бессрочный вклад легален (накопительный счёт).
- После term_end: начисление заморожено на дате окончания, computed-поле
  `status: active|matured` в ответе (не хранится). Пролонгация — вне скоупа,
  задел: закрытие = transfer обратно + archive.

## Налог — включаем в MVP
Оценка ~20 строк: одно nullable-поле, одно умножение на чтении. Ответ несёт
`accrued_minor` (gross) и `accrued_after_tax_minor` (NULL при отсутствии ставки).
Клиент деньги не считает — оба поля серверные.

## Напоминание о конце срока — эндпоинт НЕ делаем
Web-вкладка и так получает `GET /deposits` с `term_end` и `status`; блок
«ближайшие сроки» на главной мержит их на клиенте — сравнение ДАТ, не денежная
арифметика, инвариант не нарушен. `/deposits/upcoming` отложен: заводить CTE ради
списка из 1–3 строк, уже имеющегося на клиенте, — преждевременно. Если появится —
объявить ДО `/deposits/{id}` (route-order landmine, как /goals/upcoming).

## Эндпоинты и MCP/PAT allowlist (fail-closed)
- `GET /deposits` — список + balance/accrued. PAT/MCP: **да** (read).
- `GET /deposits/{id}` — деталь. PAT/MCP: **да** (read).
- `POST /deposits` — **нет** в MVP: создание — редкое ручное действие, write через
  PAT не нужен агенту.
- `PATCH /deposits/{id}` — **нет**: несёт override денег, риск > пользы для MCP.
- DELETE нет вовсе (archive через PATCH, паттерн accounts/categories).
- 422 `DEPOSIT_ACCOUNT_TRANSFER_ONLY` затрагивает и transfer-путь /transactions —
  allowlist транзакций не меняется.

## Ошибки
`DEPOSIT_NOT_FOUND` (404 no-oracle, один путь через новый `deposit_access.py` по
образцу account_access; порядок guard'ов: not-found ДО archived),
`DEPOSIT_ARCHIVED` (422 на PATCH), `DEPOSIT_ACCOUNT_TRANSFER_ONLY` (422),
`DEPOSIT_TERM_BEFORE_OPENING` (422). Ставка/налог вне диапазона — стандартный 422.

## Контракт
- `openapi.json` + `schema.d.ts` — одна пара, один коммит; потребители web,
  mobile (заморожен — не трогаем), api-client, mcp-server (allowlist — read GET-ы).
- `rate_percent` на wire — строка Decimal (прецедент `transfer_rate`).
- CORS: новых verbs нет (GET/POST/PATCH уже в списке) — проверить тестом всё равно.

## Trade-offs considered
- Свой механизм движения денег vs transfer на скрытый счёт: второй — ноль нового
  кода в балансах/агрегатах/валюте; первый — второй «кошелёк» (отвергнут в task.md).
- Хранить accrued vs считать на чтении: считаем на чтении (прецедент — балансы
  счетов); хранится ТОЛЬКО ручной якорь.
- boolean+период vs один enum капитализации: один enum, нет невалидных комбинаций.

## What this does NOT decide
- Формулы в коде, точный API-shape DepositRead — backend-engineer.
- UX кнопки «рассчитать», место блока сроков на главной — план web.
- Пролонгация, автоначисления, связь с целями, импорт, мобилка — вне скоупа.

## AMENDMENT (senior-lead gate, принято к исполнению)

1. **Начальное тело вклада — через starting_balance, не через бэкдейт-перевод.**
   Бэкдейт-перевод с существующего счёта задним числом искажает его текущий
   computed-баланс (деньги, которые из приложения никогда не уходили). Поэтому:
   `POST /deposits` принимает опциональный `initial_balance_minor` (default 0,
   ge 0) → пишется в `starting_balance_minor` связанного deposit-счёта (тот же
   «setup fact», что у обычных счетов; второй источник правды не появляется).
   Таймлайн процентов в domain сеется `(opened_on, starting_balance_minor)` +
   transfer-леги. Пополнения/снятия после начала учёта — только transfer.
2. **Имя контрагента в строке перевода на вклад**: deposit-счета исключены из
   `GET /accounts`, поэтому web строит индекс имён из accounts + deposits
   (DepositRead несёт account_id и name) — деталь веб-плана, не сервера.
3. Архив вклада с ненулевым балансом разрешён (консистентно со счетами);
   порядок закрытия (перевод обратно → архив) — копия/подсказка в web UX.
