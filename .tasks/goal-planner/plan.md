# Implementation Plan: goal-planner (бэкенд, подзадачи 1–4)

Вход: `.tasks/goal-planner/task.md` (решения пользователя, не переоткрываются),
`.tasks/goal-planner/architecture.md` (схема, следуем ей). Здесь — только то, чего в
architecture.md нет: уточнения, порядок работ, границы файлов, список тестов.
Пересказа архитектуры нет: §-ссылки ведут в `architecture.md`.

## 0. Уточнения senior-lead к architecture.md — исполняются в этой редакции

**У1. Составной FK родителя.** В DDL-скелете §1 у `parent_id` остался простой
`REFERENCES goal_items(id)` — опечатка; прозой (§1, буллет 3) решение верное.
Пишем в 0011 ИМЕННО так:

```sql
UNIQUE (id, goal_id),
FOREIGN KEY (parent_id, goal_id) REFERENCES goal_items (id, goal_id) ON DELETE CASCADE
```

- простого FK на `id` НЕТ вообще (иначе два FK на одну связь и два CASCADE-пути);
- `UNIQUE (id, goal_id)` обязателен — без него составной FK не создастся;
- гарантия «родитель в той же цели» — БД-уровня, роутер её не дублирует
  (он лишь резолвит `parent_id` в скоупе цели и отвечает 422
  `GOAL_ITEM_PARENT_NOT_FOUND`, чтобы пользователь видел код, а не 500);
- в SQLAlchemy: `ForeignKeyConstraint(["parent_id","goal_id"], ["goal_items.id","goal_items.goal_id"], ondelete="CASCADE")`
  + `UniqueConstraint("id","goal_id")` в `__table_args__`; `parent_id` — обычная
  nullable-колонка без своего `ForeignKey(...)`.

**У2. GROUP BY в paid-CTE.** В §4 `paid` делает `jsonb_object_agg(cur, amt)` над
строками, размноженными `unnest(path)`: два ребёнка одного предка в ОДНОЙ валюте дают
дубль ключа → `jsonb_object_agg` падает/схлопывает. Между `unnest` и агрегацией
обязателен промежуточный `GROUP BY (anc, cur)` с `SUM`:

```sql
paid_by_anc AS (
    SELECT anc AS node_id, q.cur, SUM(q.amt) AS amt, SUM(q.ops) AS ops
    FROM (SELECT n.path, pd.cur, pd.amt, pd.ops
          FROM nodes n JOIN paid_direct pd ON pd.goal_item_id = n.id) q
    CROSS JOIN LATERAL unnest(q.path) AS anc
    GROUP BY anc, q.cur
),
paid AS (
    SELECT node_id, jsonb_object_agg(cur, amt) AS by_currency, SUM(ops) AS ops
    FROM paid_by_anc GROUP BY node_id
)
```

**У3. «Оплачено» в валюте цели — живая конвертация на чтении, снапшота НЕ заводим.**
- на `goal_items` НЕТ колонок «оплачено»; на `transactions` — только `goal_item_id`;
- конвертация корзины: `lookup_rate(<валюта корзины> → goal.currency, today)`,
  nearest-previous, ОДНА ставка на корзину (не на строку) — иначе N вызовов на дерево;
- нет курса → корзина исключается целиком, её `ops` идёт в `paid_unconverted_count`
  (честный счётчик, как `tx_totals`); нулём не подменяем;
- сумма курсов не смешивается: складываем только уже приведённые к валюте цели корзины.

## 1. Подзадача 1 — бэкенд-ядро (FULL: миграция + деньги + контракт)

### Файлы
- **new** `alembic/versions/0011_goal_items.py` — `goal_items` (У1), `goal_item_files`
  (§7, таблица заводится здесь, роуты — в подзадаче 3), колонки
  `goals.initial_budget_minor` / `goals.final_cost_override_minor`,
  `transactions.goal_item_id` + CHECK expense-only + партиальный индекс, функция и
  триггер `goal_items_no_cycle` через `op.execute`; downgrade симметричный
  (`DROP TRIGGER`, `DROP FUNCTION`) — конфтест теста гоняет `downgrade base`.
- **new** `models/goal_item.py` — `GoalItem` + `GoalItemFile`.
- **new** `domain/goal_plan.py` — чистая математика (без IO, `today` параметром).
- **new** `services/goal_plan_reads.py` — CTE §4 + валютная досборка.
- **new** `goal_item_access.py` — топ-левел хелпер (образец `account_access.py`).
- **new** `routers/goal_items.py`, **new** `schemas/goal_item.py`.
- `models/goal.py` (+2 колонки), `models/transaction.py` (+колонка, CHECK, индекс),
  `models/__init__.py`, `app.py` (монтаж роутера на `/goals` РАНЬШЕ `goals.py`),
  `routers/goals.py` (PATCH двух полей), `routers/transactions.py` (см. ниже),
  `services/goal_reads.py`, `schemas/goal.py`, `schemas/transaction.py`,
  `pat_auth.py` (пары allowlist), `services/advisor_context.py` (см. Д2),
  `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts`.

### Тезисы реализации
1. **Миграция 0011.** Один ревизион, `down_revision = "0010"`. Порядок: goal_items →
   индексы → функция+триггер → goal_item_files → колонки goals → колонка/CHECK/индекс
   transactions. Существующие строки не трогаем, backfill'а нет (§5).
2. **Триггер §2** — `op.execute` текстом, ровно как в §2 (advisory-lock внутри). Модель
   его не декларирует; в `models/goal_item.py` — комментарий-ссылка, что backstop живёт
   в 0011 (прецедент: партиальный уникальный индекс транзакций объявлен в модели, а
   тут DDL функции в модель не выражается).
3. **Валюта пункта** штампуется валютой цели, когда не прислана; пара
   `converted_minor/converted_currency` пишется через `lookup_rate`+`convert_minor`
   (НЕ `auto_snapshot` — тот приведён к base-валюте профиля, а тут целевая валюта —
   валюта ЦЕЛИ). PATCH-семантика денег байт-в-байт как в транзакциях: omit=keep,
   value=override, null=clear+recompute; список conversion-inputs пункта —
   `{amount_minor, currency}` (даты у пункта в конвертацию не входят: курс берётся
   на «сегодня», а не на дату — у пункта нет даты операции).
4. **Роутер `goal_items.py`.** Порядок гардов (не переставлять): цель — `_load_own_goal`
   → 404 `GOAL_NOT_FOUND`; затем `archived` → 422 `GOAL_ARCHIVED` (§10d, зеркало
   `_reject_archived`); затем `parent_id` в скоупе ЭТОЙ цели → 422
   `GOAL_ITEM_PARENT_NOT_FOUND`; затем глубина/лимит; затем цикл.
   Проверка цикла и глубины — ОДИН ancestor-walk (один рекурсивный SELECT), не два.
   `sort_order` = `max(sort_order)+1024` среди сиблингов (§10b).
   `DELETE` пункта: собрать `storage_path` поддерева ДО коммита (пригодится подзадаче 3),
   удалить корень поддерева — CASCADE сносит потомков, `ON DELETE SET NULL` снимает
   привязки операций.
5. **CTE §4** — один стейтмент в `services/goal_plan_reads.py`, с У2. Функции:
   `read_goal_tree(session, goal, today)`, `paid_by_goal(session, user_id, goal_ids)`
   (сгруппированный запрос для списка целей, НЕ N+1), общий анкер для §6.
   Bucket-порядок «оплачено» — расширенный (см. Д1).
6. **transactions.py** — `goal_item_id` в create/PATCH/фильтре: резолв через
   `goal_item_access.load_own_goal_item` (JOIN на goals по user_id) → 404
   `GOAL_ITEM_NOT_FOUND` (foreign == missing, один путь). Порядок в create: после
   `_validate_receipt`, ДО валютных гардов. Проверка `kind == expense` — и при привязке,
   и при PATCH `kind` у уже привязанной строки: эффективная пара (kind после патча,
   goal_item_id после патча) → 422 `GOAL_ITEM_EXPENSE_ONLY`. Привязка к пункту
   архивной цели: 404 раньше `GOAL_ARCHIVED` (тот же guard order). Фильтр
   `?goal_item_id=` — в `_read_filters` (значит, автоматически и в `/export`; в CSV
   колонку НЕ добавляем — колонки CSV контракт, расширение не запрошено).
7. **goals/goal_reads.** `domain/goal_plan.effective_target(...)` — единственное место
   правила «нет пунктов → target_minor; есть → COALESCE(override, planned)».
   `assemble_goal_reads` подставляет `effective_target_minor` во всю ladder-математику
   и добавляет `paid_minor`, `paid_unconverted_count`, `remaining_to_find_minor`,
   `has_items`, `planned_total_minor`, `planned_unconverted_count`,
   `initial_budget_minor`, `final_cost_override_minor`. `completed` — тоже от
   эффективной цели. Поля «оплачено+накоплено» в контракте нет и не будет (task.md).
8. **PAT allowlist** — пары для новых маршрутов (`GET/POST /goals/{goal_id}/items`,
   `PATCH/DELETE /goals/{goal_id}/items/{item_id}`); `DELETE` пункта в PAT-allowlist
   НЕ добавляем (единственный разрешённый DELETE — транзакция; см. `docs/backend.md`).

### Новые коды ошибок
`GOAL_ITEM_NOT_FOUND` (404, из транзакций и из items-роутов),
`GOAL_ITEM_PARENT_NOT_FOUND` (422), `GOAL_ITEM_CYCLE` (422),
`GOAL_ITEM_DEPTH_EXCEEDED` (422), `GOAL_ITEMS_LIMIT_EXCEEDED` (422),
`GOAL_ITEM_EXPENSE_ONLY` (422), `GOAL_ARCHIVED` (422),
`INITIAL_BUDGET_REQUIRED` / `FINAL_COST_REQUIRED` — НЕ заводим: обе колонки nullable,
явный null = очистка (house-правило nullable-clears).

### Контракт
Новые схемы `GoalItemRead/Create/Update/List`, `GoalItemError`; расширенные
`GoalRead`, `GoalUpdate`, `TransactionCreate/Update/Read`, новый query-параметр.
422 объявляются raw `anyOf` [GoalItemError, HTTPValidationError]. `pnpm openapi`,
пара `openapi.json` + `schema.d.ts` — один коммит; прогоняются тесты ЧЕТЫРЁХ
потребителей (web, mobile, api-client, mcp-server) — см. подзадачу 4.

### Тесты (pytest, `tests/test_goal_items.py` + точечно в существующих файлах)
Классами, по конвенции скилла. Список закрытый — ровно эти:
1. `TestCycle::test_move_under_own_descendant_is_422` — PATCH `parent_id` на потомка →
   422 `GOAL_ITEM_CYCLE`, дерево не изменилось.
2. `TestCycle::test_trigger_backstop_rejects_direct_sql_cycle` — тот же цикл через
   `db_session` в обход роутера → `DBAPIError`/check_violation (backstop живой).
3. `TestTreeAggregates::test_leaf_sums_roll_up_and_ceiling_flag` — 3 уровня: сумма
   листьев уходит наверх, собственная сумма группирующего узла наверх НЕ уходит,
   `ceiling_exceeded=true` только там, где дети превысили потолок.
4. `TestTreeAggregates::test_unconverted_leaf_is_counted_not_summed` — лист в валюте без
   курса: исключён из `planned_total_minor`, попал в `planned_unconverted_count`.
5. `TestItemMoney::test_converted_patch_semantics` — omit=keep / value=override /
   null=clear+recompute на паре `converted_*` (контраст в одном тесте).
6. `TestDeadlineInheritance::test_goal_deadline_move_shifts_only_unset_items` — перенос
   дедлайна цели двигает `effective_deadline` пункта без своего срока и НЕ трогает
   пункт со своим; в БД `goal_items.deadline` остался NULL.
7. `TestDelete::test_subtree_cascade_unlinks_transactions_but_keeps_them` — удаление
   родителя: строки поддерева исчезли, привязанные операции живы с `goal_item_id=null`.
8. `TestLinking::test_income_cannot_be_linked_and_patching_kind_of_linked_is_422` —
   обе стороны expense-only (create с income; PATCH `kind` у привязанной) → 422
   `GOAL_ITEM_EXPENSE_ONLY`.
9. `TestLinking::test_foreign_item_is_byte_identical_404` — чужой `goal_item_id` и
   несуществующий дают идентичное тело 404 `GOAL_ITEM_NOT_FOUND` (no-oracle).
10. `TestPaid::test_paid_converts_one_rate_per_basket_and_counts_rateless` — две
    операции на узле в двух валютах: `paid_minor` в валюте цели + rateless-корзина в
    `paid_unconverted_count`; `remaining_to_find_minor` = effective − paid − saved.
11. `TestEffectiveTarget::test_manual_target_switches_to_bottom_up_and_back` —
    без пунктов `effective_target == target_minor`, `has_items=false`; после первого
    пункта `has_items=true` и `effective == planned_total`; с
    `final_cost_override_minor` — override, при этом `planned_total` в ответе для
    честного расхождения; явный null возвращает счёт снизу.
12. `TestArchivedGoal::test_write_to_archived_goal_is_422_and_foreign_is_404` —
    guard order: своя архивная цель → 422 `GOAL_ARCHIVED`, чужая архивная → 404
    `GOAL_NOT_FOUND` (оракула нет).
13. `TestLimits::test_depth_limit_rejects_seventh_level` — глубина 7 → 422
    `GOAL_ITEM_DEPTH_EXCEEDED` (ancestor-walk).
14. `TestLimits::test_items_limit_is_per_goal` — лимит через settings-override
    `make_client`, второй цели он не мешает → 422 `GOAL_ITEMS_LIMIT_EXCEEDED`.
Не пишем: проверки существования колонок, Pydantic-валидацию границ, 401 на каждом
маршруте (один раз на роутер — уже есть в `test_pat_auth.py`), отдельный тест
route-order (его ловит любой 200 от `/goals/upcoming`).

## 2. Подзадача 2 — напоминания + upcoming (STANDARD)

### Файлы
`routers/goal_items.py` (маршрут `GET /goals/upcoming`), `services/goal_plan_reads.py`
(анкер по всем корням неархивных целей), `domain/goal_plan.py` (`reminder_date`),
`schemas/goal_item.py` (`UpcomingDeadlineRead/List`), `pat_auth.py` (пара allowlist),
контракт.

### Тезисы
- `reminder_date(remind_on, remind_days_before, effective_deadline)` — чистая функция:
  `remind_on` как есть; `days_before` → `eff_deadline − N`; нет эффективного срока → None.
- Окно: `days` 1–90, default 30, `today` UTC. Узел входит, если есть дата напоминания и
  она ∈ [today, today+days]; если напоминания нет — по `effective_deadline` ∈ окна
  (напоминание, когда задано, решает само — прошедшее напоминание не тянет узел обратно).
- Сортировка (дата, `created_at`) — как `recurring/upcoming`; своих 422 нет.
- Маршрут объявляется ДО любых `/{goal_id}`-маршрутов И роутер монтируется раньше
  `goals.py` — оба условия нужны.

### Тесты (`tests/test_goal_upcoming.py`)
1. `test_days_before_reminder_rides_the_inherited_deadline` — у пункта без своего срока
   `remind_days_before=3`; перенос дедлайна ЦЕЛИ двигает дату напоминания, а у пункта с
   `remind_on` — не двигает (контраст в одном тесте).
2. `test_window_selects_by_reminder_then_by_deadline` — три пункта: с напоминанием в
   окне (входит), с напоминанием ЗА окном при сроке в окне (не входит), без
   напоминания со сроком в окне (входит).
3. `test_archived_goal_disappears_from_upcoming` — §10d.

## 3. Подзадача 3 — вложения (STANDARD)

### Файлы
`routers/goal_items.py` (три маршрута), `services/storage.py` (path-хелпер +
`remove_object`), `schemas/goal_item.py`, `config.py` (лимит файлов), контракт.

### Тезисы
- Механизм presign/confirm — калька `receipts` (§7): `POST .../files` создаёт строку и
  отдаёт presigned PUT; `POST .../files/{id}/confirm` делает httpx HEAD по
  `presign_head` → 503 `STORAGE_UNAVAILABLE` при `httpx.HTTPError`, 409
  `FILE_NOT_UPLOADED` при 404, 422 `IMAGE_TOO_LARGE` при `content-length >
  receipt_max_bytes` (тот же settings-ключ, второго лимита не заводим), иначе
  `uploaded = true`.
- `view_url` минтится ТОЛЬКО при `uploaded` (правило `_UPLOAD_PROVEN_STATUSES`); presign
  — чистый SigV4 без IO, безопасно на каждый файл дерева.
- Удаление узла: пути поддерева собраны до коммита (подзадача 1), после коммита —
  `BackgroundTasks` best-effort удаление объектов, ошибки логируются
  (`logger.warning`, без `print`), запрос не падает.
- Лимит файлов на пункт (10) — 422 `GOAL_ITEM_FILES_LIMIT_EXCEEDED`; `files_count` по
  поддереву едет в ответе дерева (предупреждение «с количеством» — на клиенте).
- Коды: `FILE_NOT_FOUND` (404), `FILE_NOT_UPLOADED` (409), `IMAGE_TOO_LARGE` (422),
  `STORAGE_UNAVAILABLE` (503), `GOAL_ITEM_FILES_LIMIT_EXCEEDED` (422).

### Тесты (`tests/test_goal_item_files.py`, HEAD мокается на границе процесса)
1. `test_confirm_marks_uploaded_and_only_then_mints_view_url` — до confirm `view_url` =
   null, после — не null (контраст в одном тесте).
2. `test_confirm_without_object_is_409_and_row_stays_unconfirmed` — HEAD 404 → 409,
   `uploaded` в БД остался false.
3. `test_confirm_oversize_is_422` — HEAD 200 с большим `content-length` → 422
   `IMAGE_TOO_LARGE`, `uploaded` false.
4. `test_confirm_when_storage_unreachable_is_503` — `httpx.HTTPError` → 503, строка цела.
5. `test_delete_item_removes_file_rows_even_if_storage_fails` — `remove_object`
   бросает → пункт и строки файлов всё равно удалены, ответ 204.
6. `test_files_of_a_foreign_item_are_404` — no-oracle, один раз на роутер файлов.

## 4. Подзадача 4 — MCP (FULL: контракт/безопасность)

### Файлы
`packages/mcp-server/src/allowlist.ts`, `packages/mcp-server/src/allowlist.test.ts`,
`apps/api/src/budget_api/pat_auth.py` (пары уже добавлены в подзадачах 1–2 — здесь
только сверка), `docs/mcp.md`.

### Тезисы
- Read-тулы: `get_goal_plan` (`GET /goals/{goal_id}/items`),
  `list_upcoming_goal_deadlines` (`GET /goals/upcoming`). Write: `create_goal_item`,
  `update_goal_item`. `delete_goal_item` НЕ публикуем (§9).
- **Ловушка контракта:** `tools.ts` выводит в схему ВСЕ свойства тела, кроме
  `managedBody`. Значит `goal_item_id`, добавленный в `TransactionCreate/Update`,
  появится у `create_transaction`/`update_transaction` АВТОМАТИЧЕСКИ — без курируемого
  описания модель получит поле без правил. Обязательно добавить `params`-описания
  («expense only; один узел; id брать из `get_goal_plan`, не выдумывать»).
  Новые поля `GoalUpdate` (`initial_budget_minor`, `final_cost_override_minor`)
  так же всплывут в `update_goal` — тоже описать (минорные единицы, чем отличается
  от `target_minor`).
- `allowlist.test.ts`: обновить `READ_TOOLS`/`WRITE_TOOLS` и счётчик «29 curated tools»
  (станет 33), добавить проверку `required` у новых тулов. Тесты гоняются у ВСЕХ
  четырёх потребителей (fa6c773).
- Серверный PAT-allowlist и MCP-таблица должны совпасть: тул на не-allowlisted паре
  падает 403 в рантайме — сверяем `test_pat_auth.py::test_every_allowlisted_pair_exists_in_the_exported_openapi`
  + существующий drift-тест MCP.

## 5. Отклонения/дополнения к architecture.md (на решение senior-lead)

**Д1. Bucket-порядок «оплачено» — трёхступенчатый, а не «валюта операции как есть».**
architecture §4 группирует `paid_direct` только по `tx.currency`. Предлагаю в
`paid_direct` считать корзину так: `tx.currency = goal.currency` → `amount_minor`;
иначе `tx.base_currency = goal.currency` → `base_amount_minor`; иначе — валюта
операции (живая конвертация по У3). Обоснование: `base_amount_minor` может быть
РУЧНЫМ override пользователя, а «ручное побеждает автоконвертацию» — домовой инвариант;
без этой ступени ручная правка курса на операции игнорируется, и «оплачено» в цели
разъезжается с тем же числом в списке транзакций и в статистике. Порядок арм —
ровно как в `tx_totals._effective_base_minor`.

**Д2. `services/advisor_context.py` отдаёт советнику `effective_target_minor`.**
Сейчас он маппит `goal.target_minor` дословно. В режиме планирования это число —
не то, что видит пользователь: советник будет считать «осталось» от устаревшей
ручной цели. Одна строка, но это деньги в промпте — называю явно.

**Д3. `?goal_item_id=` едет в `/export` бесплатно** (общий `_read_filters`), новых
колонок в CSV не добавляем — колонки CSV это контракт, расширение не запрашивалось.

## 6. Открытые вопросы
- Нужен ли `GET /goals/{goal_id}/items` PAT-доступ на write-парах, если MCP-тулы
  `create_goal_item`/`update_goal_item` публикуются (подзадача 4) — я исхожу из «да,
  POST/PATCH пары в allowlist, DELETE — нет».
- Лимит пунктов (500) считается запросом `COUNT(*) WHERE goal_id = :id` на каждый
  create — при 500 строк это копейки; гонка (два параллельных create на 500-й) даст
  501 строку. Считаю приемлемым (не деньги); при возражении — advisory-lock цели,
  тот же, что в триггере.

## 7. Риски
- **Регресс существующих целей.** `effective_target` меняет ladder-математику для ВСЕХ
  целей; у цели без пунктов число обязано остаться байт-в-байт прежним — это и
  проверяет тест 11 первой ветвью.
- **Задвоение «оплачено».** Держится на CHECK+скалярной колонке; отвязка через
  `ON DELETE SET NULL` — тест 7.
- **Триггер и миграция.** `downgrade base` в конфтесте должен снести функцию и триггер,
  иначе повторный прогон сюиты падает на `CREATE FUNCTION` — проверяется самим фактом
  зелёного `make test` на втором прогоне.
- **Стоимость CTE.** 500 пунктов × глубина 6 — `unnest` даёт ~3000 строк на цель; для
  списка целей paid-агрегат идёт ОДНИМ сгруппированным запросом, N+1 недопустим.

---

## 8. Сведение 2026-08-24 (решения PM + сведение с plan-web.md) — ОБЯЗАТЕЛЬНО к исполнению

Разделы выше читать с этими поправками; при расхождении побеждает этот раздел.

### Решения PM по §5–§6
- **Д1, Д2, Д3 — приняты все.** Д1 (трёхступенчатый bucket-порядок «оплачено»,
  уважающий ручной override base-суммы) — обязателен: одно и то же число не имеет
  права расходиться между целью, списком операций и статистикой.
- **PAT-пары items (§6.1):** GET/POST/PATCH — в allowlist; **DELETE — НИКОГДА.**
  В «никогда»-список `docs/mcp.md` заносится С ПРИЧИНОЙ: удаление узла каскадом
  уносит поддерево и файлы пользователя — необратимее delete_transaction, модели
  по реплике в чате такое не отдаём. (`delete_goal_item` не публикуется — §4 в силе.)
- **Гонка на лимите 500 (§6.2):** обычная проверка COUNT при вставке, БЕЗ
  advisory-lock. Одной строкой в код/тест-комментарий: это защита интерфейса, не
  денежный инвариант — 501 пункт ничего не ломает; у «одна операция — один узел»
  цена ошибки — деньги, поэтому там гарантия БД. Разница записана, чтобы не
  выглядело непоследовательностью.

### Контрактные дополнения из сведения с веб-планом (входят в подзадачи 1–3)
- **B1, дерево (`GET /goals/{goal_id}/items`), каждый узел дополнительно несёт:**
  - `depth` (int) — клиент не пересчитывает глубину обходом (решение PM, Q8);
  - `files_count` (СВОЙ) и `subtree_files_count` (по поддереву) — ДВА счётчика:
    строка узла и текст предупреждения об удалении говорят о разном (PM, Q1);
  - явные валюты у ВСЕХ денежных полей: `currency` у own_amount, и `goal_currency` —
    одно эхо на ответ для children_sum/paid/planned/remaining (правило AM-5 «валюта
    никогда не подставляется по умолчанию» — сквозное; PM, Q2).
- **B1, перестановка:** `sort_order` клиент НЕ пишет. PATCH пункта принимает
  `{"move": "up" | "down"}`; сервер атомарно свапает с соседом / перенумеровывает
  сиблингов в одной транзакции (PM, Q3: два неатомарных запроса оставляют дерево
  неверным при обрыве; исчерпание зазора — серверная забота). `sort_order` в
  ответе остаётся (порядок сортировки), в теле запроса его НЕТ.
- **B1, фильтр `?goal_item_id=` — по ПОДДЕРЕВУ** (PM, Q4): «оплачено» родителя уже
  агрегирует поддерево — список операций обязан считаться так же, иначе два числа
  об одном и том же расходятся. Реализация: рекурсивное расширение id в множество
  узлов поддерева (тот же CTE-скелет) → `WHERE goal_item_id = ANY(...)`. Через
  общий `_read_filters` та же семантика уезжает в `/export` (Д3 в силе).
- **B1, `GET /goals/{goal_id}` (single):** несёт ПОЛНЫЙ набор новых полей §5/§8
  (has_items, planned_total_minor, planned_unconverted_count, effective_target_minor,
  paid_minor, paid_unconverted_count, remaining_to_find_minor + goal_currency-эхо) —
  экран плана читает именно его, дрейф single/list недопустим (PM, Q6).
- **B2, строки `GET /goals/upcoming` дополнительно:** `breadcrumb` (массив имён
  предков от корня — path-массив CTE уже есть, добавить имена), имя цели, явные
  валюты денежных полей (PM, Q5).
- **B3, список файлов:** `GET /goals/{goal_id}/items/{item_id}/files` →
  `[{id, uploaded, view_url}]`. В ответ ДЕРЕВА файлы НЕ встраиваются (рамка PM «не
  раздувать общий ответ»: 500 узлов × 10 файлов = до 5000 presign на рендер) —
  детали узла грузят список отдельно; в дереве только два счётчика.

### Следствия для тестов
- Move-семантика: свап у границ (первый/последний — no-op или 422? — no-op, идемпотентно),
  атомарность (один UPDATE-путь), порядок в ответе дерева после move.
- Subtree-фильтр: операция на внуке видна в списке по родителю; /export согласован.
- Single-goal ответ: контраст с list-элементом (поля совпадают) — один тест.
- Два счётчика файлов: узел с файлом у ребёнка: own=0, subtree=1.
