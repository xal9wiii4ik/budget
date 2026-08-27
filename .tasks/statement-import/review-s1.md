# Ревью S1 (statement-import) — code-reviewer, 2026-08-27

Диф: working tree (не закоммичен). Гейты (pytest/lint/typecheck/миграция/контракт)
прогнаны оркестратором до ревью — здесь только код. Проба-доказательство для
находки №1: `scratchpad/probe_matching.py` (вывод приведён ниже).

## Findings

### MAJOR-1 — matching: exact-by-value «крадёт» чужой exact-by-client_id
`apps/api/src/budget_api/services/statement_import/matching.py:159-187`

Три прохода §4 схлопнуты в один per-row цикл: жадный exact-by-value более ранней
строки (по `(txn_date, row_index)`) может занять транзакцию, которая является
exact-by-client_id-матчем более поздней строки. Занятая транзакция исключается и
из similar (`taken`-фильтр в `_similar`), поэтому «строка по построению» падает
сразу в `new`. Проба:

```
A (genuinely new):    exact -> skip      # реально новая операция — будет потеряна
B (re-imported row):  new -> import      # уже импортированная — даст дубль на apply
```

Обе ошибки сразу: дефолт `skip` теряет новую операцию, дефолт `import` создаёт
дубль (B-1 replay спасёт только строки с client_id-транзакциями, здесь спасает,
но статусы/дефолты в предпросмотре всё равно лгут пользователю; для рукописных
транзакций без client_id аналогичная кража между exact-by-value строк даёт
честный дубль/потерю без страховки). §3 обещает «повторная загрузка — точно по
построению» — нарушено.

**Правка**: пасс 1 сделать глобальным — сначала пройти ВСЕ строки, разрешить
client_id-хиты и зарезервировать их транзакции в `taken`, и только затем второй
цикл (в том же порядке) для exact-by-value/similar.

### MAJOR-2 — окно кандидатов не покрывает txn_date < period_from
`apps/api/src/budget_api/routers/statement_imports.py:262-263` (`_load_candidates`)

Окно `occurred_at ∈ [period_from−1; period_to+1]`. Банк отбирает строки в период
по дате проведения: операция, совершённая до `period_from` и проведённая в первые
дни периода, имеет `txn_date < period_from` (лаг 1–3 дня — факт из task.md).
Для такой строки кандидат с `occurred_at == txn_date` (пользователь датировал
днём покупки) не загружается вовсе → exact-by-value невозможен → строка
классифицируется `new` → дефолт `import` → дубль при apply. Левый край similar
`txn_date−1` недостижим по той же причине. Комментарий «so the matcher never has
to ask for more rows» верен только при `txn_date ≥ period_from`, чего формат не
гарантирует.

**Правка**: нижняя граница окна `min(period_from, min(row.txn_date)) − 1`
(верхняя аналогично `max(period_to, max(row.booked_date)) + 1` для симметрии,
хотя booked_date ≤ period_to на практике держится).

### MINOR-3 — дрейф формата ДАТЫ внутри секции проглатывается молча
`apps/api/src/budget_api/services/statement_import/priorbank.py:278-286`

Строгость к дрейфу односторонняя: заголовок колонок сверяется, но строка внутри
ОТКРЫТОЙ секции, не начинающаяся с `\d{2}\.\d{2}\.\d{4}`, молча игнорируется.
Если банк сменит формат даты (`2026-06-02`), все операции будут отброшены и
пользователь получит 201-сессию с `rows_total=0` вместо STATEMENT_PARSE_FAILED.
Докстринг модуля обещает игнор только «outside a section». Правка: внутри
открытой секции незнакомая непустая строка (не totals) → StatementParseError,
либо минимум — ошибка, если открытая секция закрылась с нулём распознанных строк.

### MINOR-4 — контракт to_minor_units нарушен отрицательными значениями
`apps/api/src/budget_api/services/statement_import/priorbank.py:105-107` против
`apps/api/src/budget_api/domain/money.py:83-94`

Докстринг `to_minor_units` требует «well-formed NON-NEGATIVE decimal string»;
парсер передаёт отрицательные обороты и комиссии. Сегодня поведение корректно
(ROUND_HALF_UP в decimal — ties away from zero, симметрично по знаку), но это
использование вне контракта: будущая правка money.py вправе полагаться на
неотрицательность. Правка: обновить докстринг (узаконить знак), либо в парсере
конвертировать abs и восстанавливать знак снаружи.

### NIT-5 — app.py: осиротевший комментарий advisor
`apps/api/src/budget_api/app.py:291-293` — старый блок «POST /advisor/ask …»
теперь висит над statement-imports-маунтом, текст продублирован новым блоком.
Убрать/переставить при следующем касании.

### NIT-6 — уникальность (import_id, row_index) не закреплена
`apps/api/alembic/versions/0013_statement_imports.py:198-203`. Индекс не
уникальный, хотя комментарий роутера (`statement_imports.py:657-658`) опирается
на тотальность порядка пагинации. По построению дублей нет; уникальный индекс
закрепил бы инвариант бесплатно.

### NIT-7 — гонка двух параллельных POST может оставить два parsed-превью
Supersede — delete+insert без частичного уникального индекса
`(user_id, account_id) WHERE status='parsed'`. Гонка одного пользователя,
принято аналогично S2-рискам; индекс закрыл бы и это, и NIT-6-подобные догмы.

## Фокус-пункты — проверено, ок

1. Деньги: minor через `to_minor_units` по экспоненте валюты (не ×100); original-пара
   только при отличающейся валюте (+CHECK `original_pair`); fee со знаком файла;
   после разбора только int/Decimal — ок (кроме MINOR-4 по контракту докстринга).
2. Скоупинг/no-oracle: `_load_own` один путь, 404 байт-идентичны (тест сравнивает
   content); `_candidate_views` и `_load_candidates` user-scoped; deposit-счёт →
   404 по прецеденту accounts.py — ок.
3. fingerprint.py: canonical дословно §3 (порядок полей, пара с внутренним `|`,
   "" для пустых, версия `prior:v1`, NS-константа); occ_index — счётчик
   идентичных строк в порядке файла — ок, BLOCKER нет.
4. matching.py: окно similar [txn_date−1; booked_date+1] точно (тест ±1/±2);
   transfer только similar; ранжирование детерминировано (дата → текст → id) —
   ок, кроме MAJOR-1.
5. priorbank.py: state machine (итоги/заблокированные/вне секций), строгий
   заголовок, NBSP/узкий NBSP/пробел (фикстура несёт NBSP 0xa0 и обычный пробел),
   00:00:00→NULL, знак/kind из «Обороты по счету» — ок, кроме MINOR-3.
6. Роутер: порядок гейтов account→size→format→parse→currency→БД; supersede+TTL+
   insert одной транзакцией (один commit); rate limit per-user, свой namespace;
   size по факту чтения limit+1; счётчики §10.4 в POST (in-memory) и GET (SQL),
   консистентность закрыта тестом `fetched == body`; RowRead §10.1/§10.5;
   MISMATCH §10.7 с обеими валютами — ок, кроме MAJOR-2.
7. Миграция 0013: CHECK-и байт-совпадают с моделями (enum-порядок), FK: rows
   CASCADE, matched_tx SET NULL (превью не удаляет транзакцию и наоборот),
   категории SET NULL; downgrade симметричен — ок.
8. generate.mjs: Blob-transform матчит только `format:binary`/octet-stream;
   в контракте ровно одно такое поле (новый file), diff schema.d.ts — только
   добавления — чужие поля не задеты, ок.
9. MCP: в PAT_ALLOWLIST пар statement-imports нет (grep), allowlist fail-closed,
   роуты через `current_user_jwt_or_pat` доходят до гейта — ок.
10. Тесты: покрывают объявленное планом (границы секций, сепараторы, пара, время,
    fee, refусалы без следов в БД, supersede+стабильные client_id, no-oracle,
    TOO_LARGE с фактическим чтением); вакуумных/дублирующих нет — ок.

Ничего не правил, не коммитил.
