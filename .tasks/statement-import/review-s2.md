# review-s2 — code review подзадачи S2 (statement-import)

Тир: код-ревью дифа S2 (PATCH row, bulk-decision, apply, suggest/learn, контракт).
Гейты (ruff/pyright/pytest 593/контракт/четыре потребителя) прогнаны оркестратором
независимо и здесь не повторяются. Пробы: два таргетных теста, прогнаны и удалены
(рабочее дерево не изменено).

**Вердикт: 1 MAJOR, 2 MINOR, 4 NIT. BLOCKER нет.** Деньги, скоупинг, идемпотентность
и learning-гейт — корректны; обе находки MAJOR/MINOR-1..2 сидят в одном месте —
взаимодействии `replace_own` с батчевым B-1-фильтром.

---

## Findings

### MAJOR-1 — `replace_own` на строке exact-by-client_id молча не выполняется

`apps/api/src/budget_api/services/statement_import/apply.py:204-209`

```python
existing = await _existing_client_ids(session, user_id, [row.client_id for row in actionable])
pending  = [row for row in actionable if row.client_id not in existing]
replaced_ids = await _take_replaced(session, user_id, pending)   # ← только pending
```

Строка со статусом `exact` по `client_id` — это ровно та строка, чью транзакцию
создал ПРЕДЫДУЩИЙ apply. Её `client_id` уже в `existing`, значит она выпадает из
`pending` ДО `_take_replaced`. Итог: `matched_tx` не удаляется, новая не создаётся,
строка уезжает в `already_existed`. Явное решение пользователя «выбрось мою
(отредактированную) запись и возьми банковскую» тихо не исполняется.

**Доказательство** (проба, реальный Postgres, фикстура `statement_csv_bytes`):
импорт → apply → PATCH `/transactions/{id}` merchant=«мой отредактированный
магазин» → повторный импорт того же файла → PATCH строки `decision=replace_own`
(**200**, гейты пропускают) → apply:

```
PROBE-A match_status: exact          matched_tx_id == отредактированная tx: True
PROBE-A patch: 200
PROBE-A report: {'created': 0, 'skipped': 6, 'replaced': 0, 'already_existed': 1}
PROBE-A edited row still alive: True
PROBE-A merchant now: мой отредактированный магазин
```

Ответ на вопрос фокус-пункта 7b: **дефект, не приемлемая семантика.** Потери данных
нет (направление безопасное), но маршрут принимает решение 200-м ответом и затем не
исполняет его, а отчёт называет это `already_existed` — «уже импортировано», что
для пользователя означает противоположное («ничего делать не нужно»), а не «твой
replace проигнорирован». Путь узкий, но полностью реальный: apply → правка
транзакции → переимпорт перекрывающегося периода → «верни банковскую версию».
Это же единственный сценарий, где `replace_own` на `exact`-строке вообще осмыслен
(exact-by-value работает корректно — там у матча нет `client_id`).

Варианты, оба локальные: (а) не отфильтровывать `replace_own`-строки из `pending`,
когда их `matched_tx_id` — это и есть транзакция с тем же `client_id` (delete+insert
в одной транзакции проходит по частичному уникальному индексу); (б) если PM решает
оставить как есть — гейтить в PATCH/bulk (`DECISION_NEEDS_MATCH`-подобный отказ на
exact-by-client_id), чтобы решение нельзя было принять, а не тихо потерять. Молчание
— единственный вариант, который выбирать нельзя.

### MINOR-2 — отчёт врёт про `created`/`replaced`, когда несколько строк делят один `matched_tx_id`

`apps/api/src/budget_api/services/statement_import/apply.py:209-214`

```python
replaced = sum(row.matched_tx_id in replaced_ids for row in pending
               if row.decision == StatementRowDecision.replace_own.value)
...
created=len(pending) - replaced
```

`matching.py` явно разрешает это: «Only EXACT matches consume a candidate. A
`similar` verdict is a suggestion … so several rows may legitimately point at the
same transaction». Две `similar`-строки с одинаковой суммой в окне получают ОДИН
`matched_tx_id`; `doomed` — множество, удаление одно, а `replaced` считает строки,
не удаления. `created` при этом занижается на ту же величину.

**Доказательство** (проба B: одна записанная вручную транзакция 1.15 от 2026-06-05
даёт две `similar`-строки «PAYBYCARD.BY», bulk-decision `similar → replace_own`):

```
PROBE-B report: {'created': 5, 'skipped': 0, 'replaced': 2, 'already_existed': 0}
PROBE-B transactions in DB now: 7      (было 1, создано 7, удалена 1)
PROBE-B original 1.15 row alive: False
```

Отчёт говорит «создано 5, заменено 2», фактически создано 7 и удалена 1 запись
пользователя. Данные в порядке (`created + replaced == len(pending)`, всё, что надо
было записать, записано), врут только числа — но это единственная обратная связь по
необратимой операции. Честный `created` — `len(pending) - len(replaced_ids)`;
`replaced` тогда `len(replaced_ids)`, то есть «сколько МОИХ записей исчезло».

### MINOR-3 — `merchant` в обход `clean_merchant`: пустое описание станет `""`, а не NULL

`apps/api/src/budget_api/services/statement_import/apply.py:241` — `merchant=row.description[:_MERCHANT_MAX]`.

`POST /transactions` кладёт merchant через `schemas/transaction.clean_merchant`
(strip; `""` → **None**; кап длины). Парсер описание не валидирует: `_cell()`
(`priorbank.py:136`) возвращает `""` для отсутствующей/пустой ячейки, и
`_parse_operation` (`priorbank.py:181`) кладёт его в `description` как есть. Такая
строка после apply получит `merchant=""`, тогда как ручной ввод той же пустоты дал
бы NULL. Последствие точечное, но не нулевое: `services/tx_totals.py:295` —
«NULL-merchant rows are out of the population entirely» — пустую СТРОКУ из
топ-мерчантов не исключает, она станет отдельным безымянным мерчантом.

Модуль перечисляет в докстринге, что именно он повторяет за `POST /transactions`
вручную; чистка merchant в этот список не попала. Фикс — `clean_merchant(...)`
вместо среза (он же делает и обрезку, только через ValueError — тогда срез до
`_MERCHANT_MAX` остаётся перед вызовом).

### NIT-4 — bulk `replace_own`: отказ по одной строке без указания виновника (фокус 7a)

`apps/api/src/budget_api/routers/statement_imports.py:851-889, 969-978`

**Вердикт: приемлемо для v1**, но с оговоркой. Клиент МОЖЕТ предсказать отказ сам:
`RowRead` несёт `matched_tx_id` и `candidates[].kind`, так что «в этом статусе есть
строка без матча / с transfer-матчем» видно с экрана предпросмотра без запроса.
Оговорка: докстринг подаёт transfer как редкий случай, а на деле отказ ловится и
проще — достаточно, чтобы пользователь удалил ОДНУ сматченную транзакцию после
парса (FK `SET NULL` → `matched_tx_id is None` → `DECISION_NEEDS_MATCH` на весь
bulk). Стоит одной строкой в web-плане: перед bulk `replace_own` фильтровать статус
по `matched_tx_id`/`kind`, иначе кнопка будет 422-иться без объяснения.

### NIT-5 — категория не перепроверяется на `archived` в момент apply

`apply.py:237` — `category_id=row.category_id`. Валидация была в PATCH; между PATCH
и apply категорию можно заархивировать, и apply запишет транзакцию в категорию,
которую `POST /transactions` отказался бы принять (`CATEGORY_ARCHIVED`). Гонка
узкая, а отказ всей выписки из-за одной архивации был бы хуже — так что поведение,
скорее всего, правильное; но оно НЕ описано ни в докстринге модуля (где перечислены
все остальные заимствованные инварианты), ни в §7. Одна фраза закрывает пункт.
Побочно: `categories.py:67-99` (`_lookup`) архивные из ПОДСКАЗОК фильтрует, так что
семя `category_id` при parse архивным быть не может — расходится только правка.

### NIT-6 — `_merchant_key` считается дважды на строку

`categories.py:111` и `categories.py:130` — `normalize_merchant` вызывается 2N раз
на файл вместо N. Чистый CPU, на 1000 строк незаметно; правится словарём ключей.

### NIT-7 — `null` в `StatementRowPatch` значит разное для двух полей

`schemas/statement_import.py` (`StatementRowPatch`): `decision: null` = «не трогать»,
`category_id: null` = «очистить». Асимметрия задокументирована в докстринге и в
openapi-описании, оба поля читаются через `model_fields_set`, так что сервер
однозначен — но клиент, который шлёт «пустую» форму целиком, снимет категорию и не
тронет решение. Для web-плана это ловушка стоимостью в строку комментария.

### NIT-8 — доки: `docs/backend.md` до сих пор не знает про statement-import

`grep -n statement docs/backend.md` — пусто; ни в «Routers», ни в «services/» нет
ни роутера, ни модуля `services/statement_import/` (S2 добавил в него ещё два
файла). По CLAUDE.md дописывает `senior-lead` ПРИ ЗАКРЫТИИ скоупа — фиксирую, чтобы
не потерялось. Там же остаточный пункт S1: `_counts` (in-memory, POST,
`statement_imports.py:470`) и `_counts_of` (SQL, `:494`) — по-прежнему две
реализации; **S2 третьей не завёл** (см. фокус-пункт 5).

---

## Фокус-пункты — проверено

1. **Деньги.** `currency=account.currency` (штамп со счёта, валюта выписки сверена
   при upload); снапшот по той же таблице решений, что и `POST /transactions:885-905`
   — `account.currency == base` → NULL/NULL, иначе `auto_snapshot(..., row.txn_date)`,
   отсутствие курса → честная NULL-пара (закреплено тестом на PLN-строке);
   original-пара копируется как напечатал банк, БЕЗ пересчёта. CHECK-и
   `transactions` проходят: `_original_pair` (`priorbank.py:140-161`) отдаёт
   (None, None) и при равной валюте, и при нулевой сумме, так что
   `original_amount_minor_positive` / `original_currency_differs` недостижимы.
   `occurred_at=txn_date`, `amount_minor` — модуль-плюс-kind, без знаковой
   арифметики. Валюта счёта неизменяема (`AccountUpdate.currency` объявлено только
   ради отказа `ACCOUNT_CURRENCY_IMMUTABLE`), так что «валюта уехала между parse и
   apply» невозможно. Ок, кроме MINOR-3 (merchant).
2. **Идемпотентность — один механизм.** B-1 и только он: детерминированный
   `client_id`, частичный уникальный индекс `uq_transactions_user_id_client_id`,
   один батчевый `IN`-select (`apply.py:94-110`, user-scoped), retry на
   IntegrityError. Повторный apply → `created: 0, already_existed: 7` (тест
   `test_re_importing_the_same_file_creates_nothing`, причём с bulk-«import» поверх
   дефолтного skip — то есть проверяется именно select-first, а не дефолт).
   **Ретрай-арм прочитан:** `apply_import` перечитывает сессию, счёт, строки и
   `existing` с нуля, поэтому `rollback()` (который экспайрит инстансы и выкидывает
   pending-объекты первой попытки) ничего не оставляет; `user.id` вычисляется в
   роутере ДО входа в `_apply_once_or_twice:994`, так что после rollback ленивых
   догрузок нет (`MissingGreenlet` недостижим); `expire_on_commit=False` в
   `db.py:28`, поэтому пост-commit сериализации в PATCH/bulk тоже безопасны;
   `applied_at` сохраняется, `status` идемпотентно переставляется. Второй
   IntegrityError подряд ушёл бы в 500 — но повторяемый дубликат `client_id` внутри
   одной выписки исключён `occ_index`-ом. Корректно.
3. **Скоупинг / no-oracle.** Все select/delete несут `user_id` (`_existing_client_ids`,
   `_take_replaced`, `_reject_unreplaceable`, `_candidate_views`, `_lookup`).
   PATCH — двухуровневый 404 одним запросом `id + import_id` (тест
   `test_a_row_of_another_session_is_not_found_either` сверяет байты тел). Чужая
   категория → `CATEGORY_NOT_FOUND` строго ДО `CATEGORY_ARCHIVED`, через общий
   `load_visible_category` (тест сверяет `foreign.content == missing.content`).
   `_take_replaced` удаляет только `user_id`-scoped и только то, что вернул
   user-scoped select. bulk — по `import_id`, уже проверенному `_load_live`. Ок.
4. **Learning-гейт.** Пишет только `category_user_set=true` И `category_id is not
   None` (`categories.py:170`); `decision` намеренно не гейт. Пассивная подсказка не
   обучает — закреплено контрастом в одном apply (сид мерчант-карты остаётся на
   старой категории, банковская корзина — на пре-сиженной). Explicit `null` снимает
   флаг вместе со значением (`statement_imports.py:928`). Пары distinct через dict,
   строки идут в порядке файла → последний выигрывает, детерминированно. Ключи
   развязаны правильно: `normalize_merchant` для мерчант-карты (одна функция и на
   чтении `:130`, и на записи `:172`), `bank_category` — stripped verbatim из
   `_cell`, без нормализации. Отсечка 255: `_merchant_key` возвращает `""` и строка
   просто не учит (`bank_category` — уже `String(255)` на уровне модели). Ок.
5. **Счётчики.** `_counts_of` — единственная новая реализация, её используют GET
   (`:767`), bulk (`:990`) и `skipped` отчёта apply (`:1045`). Второго подсчёта S2
   не завёл; тест сверяет `fetched.json() == bulk.json()`. Остаточный in-memory
   `_counts` в POST — наследство S1, см. NIT-8.
6. **Гонки / двойной apply.** Два прохода `_load_live` → оба в `apply_import`
   (статус внутри не перепроверяется, задокументировано). Двойной ВСТАВКИ нет:
   `client_id` детерминирован, проигравший ловит IntegrityError, откатывается и на
   повторе видит строки победителя как `already_existed`. Двойного УДАЛЕНИЯ в
   `replace_own` нет: DELETE второго под READ COMMITTED блокируется до коммита
   победителя и удаляет 0 строк, после чего вся его транзакция всё равно
   откатывается по конфликту `client_id`; на повторе `pending` пуст и
   `_take_replaced` не вызывается вовсе. Transfer-гейт стоит ДО любой записи, так
   что отказ оставляет транзакцию чистой (тест `test_a_transfer_is_never_replaced`
   проверяет и это, и что сессия остаётся `parsed`).
7. **Два пограничных случая** — вердикты выше: (a) NIT-4, приемлемо для v1 с
   оговоркой в web-плане; (b) MAJOR-1, дефект.
8. **Контракт.** Диф `openapi.json` (+353) и `schema.d.ts` (+287) — 0 удалённых
   строк, чисто аддитивный. `RowRead` получил ровно четыре поля §10, все в
   `required`, `suggestion_source` — `$ref` на enum. `StatementRowPatch`: оба поля
   вне `required`, `anyOf [uuid, null]` — tri-state по присутствию на проводе
   работает. `StatementBulkDecision` — `match_status` + `decision`, оба required
   (§10.8). `StatementApplyReport` — четыре целых, все required (§10.6). Пути:
   `PATCH /{id}/rows/{row_id}`, `POST /{id}/rows/bulk-decision`, `POST /{id}/apply`.
   `pat_auth.py` не тронут (`git status` пуст) → MCP-allowlist не расширен, все
   восемь маршрутов остаются JWT-only fail-closed. Ок.
9. **Тесты.** Бьют в объявленное ломаемое: валюта/original-пара/NULL-снапшот, B-1
   на повторе, replace_own как delete+insert в одном заходе, transfer — оба гейта
   (второй прогоняется через прямой UPDATE в БД, то есть проверяет именно защиту
   от нечестного писателя `decision`), learning-гейт с контрастом в одном apply,
   no-oracle на обоих уровнях PATCH, bulk не трогает чужие статусы и не сбрасывает
   категорию. Вакуумных/дублирующих не нашёл: каждый тест меняет хотя бы одну
   ветку относительно соседа, `test_statement_apply.py` не переспрашивает парсер и
   матчер. Не покрыто (осознанно, нужна реальная гонка): ретрай-арм
   `_apply_once_or_twice` — оценён чтением, см. фокус-пункт 2. Не покрыто
   (неосознанно): оба сценария MAJOR-1 и MINOR-2.

## Пробы

Два httpx-теста против реального Postgres (`apps/api/tests/`, временный файл,
удалён после прогона — `git status` по `apps/api/tests/` показывает только диф S2):
PROBE-A — `replace_own` на exact-by-client_id; PROBE-B — две `similar`-строки на
одном `matched_tx_id` через bulk `replace_own`. Вывод обоих — в MAJOR-1 и MINOR-2.
