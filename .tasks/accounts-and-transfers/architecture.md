# Architecture Plan: accounts-and-transfers

## Context
Ввести счета (карта/кэш) и третий вид операции — перевод между счетами с двумя
суммами (фактический курс пользователя). Данные обнуляются (решение PM),
`account_id` NOT NULL сразу, миграции истории нет. Ключевой вопрос — представление
перевода в БД и поимённое исключение переводов из всех денежных агрегатов.

## Решения

### 1. Модель `accounts`
**Вердикт**: своя таблица, паттерн категорий (boolean `archived`, НЕ archived_at —
у категорий в коде именно `archived: bool`, следуем реальному паттерну).
- `id` UUID PK; `user_id` UUID NOT NULL FK users CASCADE, index (системных счетов нет — NOT NULL, в отличие от категорий).
- `name` String(100); `currency` String(3), CHECK `^[A-Z]{3}$` (паттерн transactions).
- `type` String(16), CHECK из нового `AccountType(StrEnum)` в enums.py: `card`, `cash` (definition order load-bearing, комментарий как у остальных).
- `starting_balance_minor` BigInteger, в минорных единицах валюты СЧЁТА; без sign-CHECK (карта легально стартует в минусе).
- `archived` Boolean default false; `created_at`.
- Без unique(user_id, name) — у категорий его нет, не изобретаем.
- Доступ: `account_access.py` по образцу `category_access.py` — один code path, foreign/missing → `None` → 404 `ACCOUNT_NOT_FOUND` (no-oracle). Guard order: not-found раньше `ACCOUNT_ARCHIVED` (422 на запись).
- Отвергнуто: `archived_at` timestamp — расходится с фактическим паттерном категорий без выгоды.

### 2. Остаток: ВЫЧИСЛЯЕМЫЙ
**Вердикт**: считается на чтении одним SQL, не хранится.
- Хранимый остаток = dual-write на каждом create/PATCH/DELETE транзакции (включая
  идемпотентный replay, recurring-материализацию, recovery-ветку IntegrityError) —
  ровно тот класс багов, от которого проект бежит. Per-user объёмы малы (прецедент D13).
- Формула per account: `starting_balance_minor + Σ income(account_id) − Σ expense(account_id) − Σ amount_minor(transfer, account_id) + Σ counter_amount_minor(transfer, counter_account_id)`. Все слагаемые в валюте счёта (см. §4) — никакой конвертации.
- Где на wire: поле `balance_minor` в `AccountRead`; `GET /accounts` отдаёт список с остатками (одна grouped-выборка на всех). Отдельного эндпоинта остатка нет.
- Отвергнуто: хранимая колонка + триггеры/сервис — преждевременно, ломается на replay-ветках.

### 3. Перевод: ОДНА строка с двумя счетами
**Вердикт**: `kind='transfer'`, поля на transactions: `account_id` (источник, существующее NOT NULL), `counter_account_id` UUID FK nullable, `counter_amount_minor` BigInteger nullable.
- Атомарность бесплатно: create/PATCH/DELETE — одна строка, нет linked-pair, нет
  осиротевшей ноги, client_id-идемпотентность работает без изменений.
- Список: одна строка = один элемент UI («A → B»), не нужно склеивать пары.
- PATCH: обычная строчная семантика (omit=keep); обе суммы правятся независимо
  (фактический курс — производная, не хранится).
- Математика остатков: source читает `amount_minor`, target — `counter_amount_minor` (§2).
- CHECK-инварианты (в модели + миграции):
  - `kind='transfer'` ⇒ `category_id IS NULL` AND `counter_account_id IS NOT NULL` AND `counter_amount_minor IS NOT NULL`;
  - `kind!='transfer'` ⇒ `counter_account_id IS NULL` AND `counter_amount_minor IS NULL`;
  - `counter_account_id != account_id`; `counter_amount_minor > 0`;
  - `kind='transfer'` ⇒ base-пара NULL (§5).
- `TransactionKind.transfer` добавляется ТРЕТЬИМ (append после income — definition
  order load-bearing); миграция пересобирает `kind_valid` CHECK в `IN ('expense','income','transfer')`.
- FK `account_id`/`counter_account_id`: `ondelete=CASCADE` — счёт hard-удаляется
  только каскадом от user, где транзакции гибнут и так; RESTRICT ломал бы каскад user-delete.
- Отвергнуто: две связанные строки — нужны transfer_group_id, парная консистентность на PATCH/DELETE, дедупликация в списках и агрегатах; сплошные минусы при нулевых плюсах на наших объёмах.

### 4. Валюта транзакции == валюта счёта: ФОРСИРОВАТЬ
**Вердикт**: сервер штампует `tx.currency` из счёта; присланная валюта, не равная
валюте счёта, — 422 `ACCOUNT_CURRENCY_MISMATCH`. Для transfer: `amount_minor` в
валюте source, `counter_amount_minor` в валюте target (currency обеих ног — производная от счетов).
- Иначе остаток счёта — мультивалютная сумма, т.е. конвертация на каждом чтении и
  нечестные числа; форсирование делает §2 чистой целочисленной арифметикой.
- `currency` СЧЁТА иммутабельна на PATCH (нет каскадного пересчёта транзакций);
  смена валюты = архив + новый счёт. PATCH `account_id` транзакции: перештамповать
  currency от нового счёта и пересчитать base-снапшот (как смена currency сейчас).
- Помечено как открытый вопрос OQ-1 (кандидат по брифу), рекомендация — форсировать.
- Отвергнуто: свободная валюта на строке + конвертация в валюту счёта — вторая FX-механика и «остаток по курсу», PM просил честные числа.

### 5. Base-снапшот у переводов: NULL для обеих ног
**Вердикт**: transfer не участвует ни в одном агрегате (§6), снапшот некому читать;
`auto_snapshot` для transfer не вызывается, CHECK из §3 делает это непредставимым.
- Отвергнуто: снапшот source-ноги «на будущее для net worth» — спекулятивная гибкость; появится net-worth-скоуп — добавит.

### 6. Исключение transfer из агрегатов — поимённо

Центральное изменение ОДНО: `services/tx_totals.py` — фильтр
`Transaction.kind != TransactionKind.transfer.value` в grouped-pass всех трёх серий
и в `_bucket_three_rows` (иначе transfer попадёт в `by_bucket` и в `unconverted_count`).
Все всадники tx_totals чистятся автоматически.

| Файл | Функция | Изменение |
|---|---|---|
| services/tx_totals.py | `converted_totals`, `monthly_converted_totals`, `merchant_converted_totals`, `_bucket_three_rows` | + фильтр kind != transfer (одно общее место, как `_effective_base_minor`) |
| routers/stats.py | summary/monthly/top-merchants | НЕТ изменений (едут на tx_totals); top-merchants и так `kind=expense` |
| routers/limits.py | `list_limits` | НЕТ изменений (читает expense-bucket `converted_totals`) |
| routers/transactions.py | `summary` | НЕТ изменений (едет на `converted_totals`) |
| routers/transactions.py | `list_transactions`, `_read_filters` | + фильтр `account_id` (матчит `account_id == X OR counter_account_id == X` — история счёта = обе ноги); `kind=transfer` в фильтре работает бесплатно через enum |
| routers/transactions.py | `_export_row`, `_EXPORT_COLUMNS` | transfer ВКЛЮЧЁН в CSV (экспорт — полная история); + колонки account, counter_account, counter_amount; base-ячейки пустые честно |
| services/advisor_context.py | — | НЕТ изменений (pure; питается агрегатами tx_totals — чистится в источнике) |
| services/goal_reads.py | free balance | НЕТ изменений (едет на `converted_totals`; перевод и не должен менять свободный остаток — деньги остаются у пользователя) |
| services/recurring_jobs.py | `materialize_due` | + копирование `account_id` шаблона в Transaction; transfer не материализуется (§7) |

### 7. recurring_templates
**Вердикт**: `account_id` UUID NOT NULL FK CASCADE на шаблоне (таблица обнуляется —
NOT NULL сразу); kind-CHECK шаблона ОСТАЁТСЯ `('expense','income')` — recurring-переводы
в v1 не поддерживаются (OQ-2, рекомендация «нет»: нужна вторая пара счёт/сумма на
шаблоне и transfer-ветка материализатора ради несформулированного сценария).
- Отвергнуто: transfer в шаблонах сразу — спекулятивно, добавляется аддитивно позже.

### 8. Чеки
Confirm-поток — клиентский (parse заполняет форму транзакции, POST /transactions с
`receipt_id`). `account_id` приходит из селектора счёта в confirm-форме; серверных
изменений в /receipts НЕТ. Дефолт селектора (последний использованный) — клиентская
деталь, решает web-инженер.

### 9. Эндпоинты и схемы
- `GET /accounts` — archived-inclusive (паттерн категорий), каждый с `balance_minor`.
- `POST /accounts` — name, currency, type, starting_balance_minor (default 0).
- `PATCH /accounts/{account_id}` — name, type, starting_balance_minor, archived
  (omit=keep); currency иммутабельна (422 `ACCOUNT_CURRENCY_IMMUTABLE`). DELETE нет — только архив.
- Перевод: тот же `POST /transactions` с `kind=transfer` + `counter_account_id` +
  `counter_amount_minor`. Отвергнуто: отдельный `POST /transfers` — дублирует
  client_id-идемпотентность, 422-union, MCP-пару; один ресурс — один маршрут.
- `TransactionCreate`: + `account_id` (required), + counter-пара (optional, валидны
  только при transfer — 422 `COUNTER_FIELDS_WITHOUT_TRANSFER` / `TRANSFER_FIELDS_REQUIRED`);
  `currency` optional и обязан совпадать со счётом (§4). `TransactionRead`: +
  `account_id`, `counter_account_id`, `counter_amount_minor` (nullable).
- PATCH транзакции: смену kind на/с transfer запретить — 422
  `KIND_CHANGE_UNSUPPORTED` (delete+create); expense↔income как раньше.
- `AccountRead`: id, name, currency, type, starting_balance_minor, balance_minor, archived, created_at.
- Ошибки: `ACCOUNT_NOT_FOUND` (404, no-oracle), `ACCOUNT_ARCHIVED`,
  `ACCOUNT_CURRENCY_MISMATCH`, `SAME_ACCOUNT_TRANSFER` (422). Роутер — в общий
  `current_user_jwt_or_pat`. CORS: новых verbs нет (GET/POST/PATCH уже в списке).
- Контрактная пара openapi.json + schema.d.ts — регенерация, один коммит.

### 10. MCP / pat_auth
- Allowlist-пары (fail-closed, аддитивно): `("GET","/accounts")`, `("POST","/accounts")`,
  `("PATCH","/accounts/{account_id}")`. Перевод — через уже разрешённый `POST /transactions`
  (flat-схема MCP-тула подхватит новые поля из openapi при регенерации).
- Инструменты в `packages/mcp-server/src/allowlist.ts`: `list_accounts`,
  `create_account`, `update_account`; `create_transaction` обновляется генерацией.
- Отвергнуто: отдельный transfer-тул — нечему отличаться от create_transaction.

### 11. Обнуление (выполняет PM, до миграции 0008)
- Чистим: `transactions`, `receipts` (+ бакет MinIO по желанию), `recurring_templates`.
- Сохраняем: `users`, `profiles`, `categories` (frozen UUIDs!), `exchange_rates`,
  `goals`, `goal_contributions`, `category_limits`, `merchant_category_map`,
  `personal_access_tokens`, `pat_audit_log`, `refresh_tokens`.
- Миграция 0008: create accounts; transactions: + `account_id` NOT NULL,
  + counter-пара nullable, пересборка `kind_valid`, новые CHECK (§3);
  recurring_templates: + `account_id` NOT NULL. Всё NOT NULL легально — таблицы пусты.

### 12. Подзадачи, зависимости, тиры
| ID | Что | Зависит от | Тир |
|---|---|---|---|
| B1 | Ядро: миграция 0008, enums, модели, /accounts, transfer в /transactions, остатки, контрактная пара | — | FULL (миграция+деньги+контракт) |
| B2 | Агрегаты: tx_totals-фильтр, export-колонки, recurring account_id, фильтр account_id | B1 | FULL (money math) |
| W1 | Веб: экран счетов (CRUD+архив+остатки), форма перевода, счёт в форме транзакции | B1, B2 | STANDARD |
| W2 | Веб: правки существующего (рендер transfer в списке, фильтр по счёту, confirm-форма чека, форма recurring) | W1 | STANDARD |
| M1 | MCP: allowlist-пары pat_auth + тулы mcp-server | B1 | FULL (auth-поверхность, маленькая) |
| MOB | Мобилка: счета+переводы, симуляторный QA — отцепляемая, последняя, цена отдельно | B1, B2 | STANDARD + mobile-qa |

## Что НЕ решает этот документ
- Точная форма balance-SQL (один запрос vs UNION) — за backend-engineer.
- UX дефолтного счёта в формах/confirm чека — за web-engineer (рекомендация: последний использованный, клиентски).
- Мобильные экраны — plan-mobile.md.

## Открытые вопросы для пользователя
- **OQ-1. Валюта транзакции**: (a) форсировать `tx.currency == account.currency` (рекомендую — честные целочисленные остатки, никакой FX на чтении) vs (b) свободная валюта строки с конвертацией в валюту счёта. Следствие (a): валюта счёта иммутабельна после создания.
- **OQ-2. Recurring-переводы**: (a) не поддерживать в v1, только expense/income (рекомендую — добавляется аддитивно позже) vs (b) поддержать сразу (вторая пара счёт/сумма на шаблоне + ветка материализатора).
- **OQ-3. Переводы в CSV-экспорте**: (a) включать с колонками account/counter_account/counter_amount (рекомендую — экспорт есть полная история) vs (b) исключать как «не деньги-события».
- **OQ-4. starting_balance_minor после создания**: (a) правится PATCH-ем (рекомендую — это setup-факт, удобно докалибровать) vs (b) иммутабелен.

## Аддендум (senior-lead, по директиве PM 2026-08-19 — НЕ переоткрывать)

### A1. Перевод — одна операция во всех UI
- В списке: ОДИН элемент с обеими сторонами («−100.00 USD Карта USD → +330.00 BYN
  Карта BYN»), никогда не два пункта. Правится одной формой (обе суммы, оба счёта,
  дата), удаляется целиком. Однострочная модель §3 гарантирует отсутствие
  «половины перевода» на всех уровнях, включая MCP.

### A2. Фактический курс перевода — серверное поле
- `TransactionRead.transfer_rate`: nullable string (Decimal), только у transfer.
  Вычисляется СЕРВЕРОМ на чтении из мажорных величин обеих ног:
  `(counter_minor/10^exp(target)) / (amount_minor/10^exp(source))`, Decimal
  ROUND_HALF_UP; точность квантования — деталь plan.md (рекомендация: 6 значащих).
  НЕ хранится (производная двух сумм), клиенты только показывают строку.

### A3. Правило отображения в списке конкретного счёта (общее для web и mobile)
- При просмотре истории счёта X: перевод — минус, если X = account_id (показать
  amount_minor в валюте X), плюс, если X = counter_account_id (показать
  counter_amount_minor в валюте X). Это ОДНА операция: тап/клик открывает одну
  форму перевода. Логика направления — чистый общий хелпер в `packages/shared`
  (не арифметика денег — выбор ноги и знака), используется обоими клиентами.

### A4. Мобилка — полноценная подзадача
- MOB планируется целиком (счета, перевод, форма транзакции со счётом) вместе с
  симуляторным QA, честная отдельная цена. Последняя по порядку, независимая от
  веба; формулировку «отцепляемый хвост» считать заменённой.

### A5. Утверждённое отклонение (Phase-4, senior-lead): `counter_currency` на строке
- План бэкенда (C-3) добавляет к counter-паре третье поле `counter_currency`
  String(3) nullable, штампуется от target-счёта, парный CHECK по образцу
  `base_snapshot_pair`. Причины: `transfer_rate` требует экспонент валюты цели;
  `_serialize`/`_export_row` остаются чистыми функциями строки; клиентам (A3)
  нужна валюта второй ноги без джойна (веб пришёл к тому же — OQ-W1). Дрейф
  невозможен: валюта счёта иммутабельна (§4). §3/§9 читать с этой поправкой;
  `TransactionRead` несёт `counter_currency`.
