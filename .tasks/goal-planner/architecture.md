# architecture.md — goal-planner (скоуп «цель как план с деревом пунктов»)

Входные решения: `.tasks/goal-planner/task.md` (не переоткрываются). Миграция — `0011`.
Конфликтов с решениями пользователя нет (см. финальную секцию — два уточнения в рамках
делегированной свободы).

---

## 1. Таблица `goal_items`

**`goal_id` денормализован на КАЖДОМ узле**, не только у корней. Причины:
- скоуп по user_id и no-oracle 404 — один JOIN `goal_items → goals` по `goal_id`,
  без рекурсивного подъёма ради авторизации;
- рекурсивный CTE читает всё дерево одним индексированным проходом по `goal_id`;
- составной FK `(parent_id, goal_id) → goal_items(id, goal_id)` даёт БД-гарантию
  «родитель в той же цели» бесплатно (нужен `UNIQUE (id, goal_id)`), и она же
  ловит любую попытку перевесить узел в чужую цель, оставив детей.

```sql
CREATE TABLE goal_items (
    id            uuid PRIMARY KEY,
    goal_id       uuid NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    parent_id     uuid NULL REFERENCES goal_items(id) ON DELETE CASCADE,
    name          varchar(100) NOT NULL,
    description   text NULL,
    links         jsonb NOT NULL DEFAULT '[]',   -- список URL-строк; валидация (≤10, ≤2048) на схеме
    -- деньги: пара «своя валюта + снапшот в валюте цели» — калька с транзакций
    amount_minor      bigint NULL CHECK (amount_minor IS NULL OR amount_minor > 0),
    currency          varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),  -- штампуется валютой цели, если не прислана
    converted_minor   bigint NULL CHECK (converted_minor IS NULL OR converted_minor >= 0),
    converted_currency varchar(3) NULL CHECK (converted_currency ~ '^[A-Z]{3}$'),
    CHECK ((converted_minor IS NULL) = (converted_currency IS NULL)),       -- pair, как base_snapshot_pair
    CHECK (converted_minor IS NULL OR amount_minor IS NOT NULL),            -- снапшот без суммы не бывает
    deadline      date NULL,               -- NULL = наследует (НИЧЕГО не проставляем — решение task.md)
    remind_on         date NULL,           -- §6
    remind_days_before int NULL CHECK (remind_days_before >= 0),
    CHECK (NOT (remind_on IS NOT NULL AND remind_days_before IS NOT NULL)), -- exactly-one-or-none
    sort_order    integer NOT NULL,        -- §10b
    created_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (parent_id <> id),               -- дешёвая первая линия против цикла
    UNIQUE (id, goal_id),
    FOREIGN KEY (parent_id, goal_id) REFERENCES goal_items (id, goal_id)
);
CREATE INDEX ix_goal_items_goal_id   ON goal_items (goal_id);
CREATE INDEX ix_goal_items_parent_id ON goal_items (parent_id);
```

- Снапшот в валюте цели: считается сервером при create/PATCH по nearest-previous
  курсу (`fx_lookup` + `domain/fx`), **ручное значение побеждает**, PATCH-семантика
  omit=keep / value=override / null=clear+recompute — байт-в-байт правило транзакций.
  Нет курса → пара NULL/NULL, узел попадает в честный счётчик несконвертированного
  (bucket-порядок чтения — калька с `tx_totals`: `currency == goal.currency` →
  amount_minor; `converted_currency == goal.currency` → converted_minor; иначе — счётчик).
  Смена валюты цели (relabel, D12) снапшоты не переписывает — их обесценивает bucket-порядок.
- `amount_minor` nullable: группирующий узел («Жильё») может не иметь своего потолка.

## 2. Циклы — PL/pgSQL-триггер (named requirement)

```sql
CREATE FUNCTION goal_items_no_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  -- сериализация конкурентных перевесов внутри ОДНОЙ цели: без него два
  -- параллельных UPDATE (A→под B и B→под A) оба пройдут проверку.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.goal_id::text, 0));
  IF EXISTS (
      WITH RECURSIVE anc AS (
          SELECT id, parent_id FROM goal_items WHERE id = NEW.parent_id
          UNION ALL
          SELECT gi.id, gi.parent_id FROM goal_items gi JOIN anc ON gi.id = anc.parent_id)
      SELECT 1 FROM anc WHERE id = NEW.id)
  THEN RAISE EXCEPTION 'goal_items cycle' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_goal_items_no_cycle
  BEFORE INSERT OR UPDATE OF parent_id ON goal_items
  FOR EACH ROW EXECUTE FUNCTION goal_items_no_cycle();
```

Почему триггер, а не альтернативы:
- **CHECK** не видит другие строки — цикл межстрочный по определению;
- **ltree / materialized path** — хранимая производная структура: перенос поддерева
  переписывает N строк, path может разъехаться с parent_id (update-аномалия — тот же
  довод, по которому у goals нет `saved_minor`);
- **closure table** — O(N·depth) строк ради инварианта, который проверяется за один
  рекурсивный SELECT на запись; записи в дерево редкие, чтения частые — платим на записи;
- составной FK из §1 удерживает цикл внутри одной цели → рекурсия триггера ограничена
  её глубиной (≤6 по §10a), стоимость копеечная.

Роутер делает ту же проверку ДО записи и отвечает 422 `GOAL_ITEM_CYCLE`; триггер —
backstop уровня БД (проигравший гонку получает DBAPIError с check_violation → тот же 422).

## 3. «Одна операция — максимум один узел» — nullable FK на transactions

**Выбор: колонка `transactions.goal_item_id uuid NULL REFERENCES goal_items(id)
ON DELETE SET NULL`.** Против link-таблицы с UNIQUE(transaction_id):
- скаляр держит одно значение **по построению** — инвариант не «констрейнт, который
  можно уронить миграцией», а сама форма данных;
- прецеденты в этой же таблице: `receipt_id`, `recurring_template_id` — привязка
  «операция → сущность» здесь всегда колонка;
- нет JOIN в `_serialize`/`_export_row`/list-фильтрах; PATCH-семантика omit/value/null
  ложится в существующий код транзакций без второго агрегата и двух записей на линк.
Link-таблица оправдана только при many-to-many или атрибутах связи — ни того ни другого нет.

- **Только expense.** CHECK: `goal_item_id IS NULL OR kind = 'expense'`
  (сосед `transfer_has_no_category`). Transfer — движение между своими счетами, у него
  нет base-пары (CHECK 0008) и он исключён из всех денежных агрегатов (`tx_totals`);
  «оплачено» из transfer задваивало бы внутренние переводы как расходы. Income тоже
  запрещён: v1 не вводит знаковую арифметику «оплачено минус возврат» — возврат решается
  отвязкой/правкой операции. Код 422 `GOAL_ITEM_EXPENSE_ONLY` (на create/PATCH: и при
  привязке к не-expense, и при PATCH kind у привязанной строки).
- Привязка user-скоупится в роутере через JOIN `goal_items → goals` (foreign/missing →
  один путь → 404 `GOAL_ITEM_NOT_FOUND`) — тот же уровень защиты, что у `category_id`.
- Удаление узла/поддерева: `parent_id ... ON DELETE CASCADE` сносит поддерево строк,
  `goal_item_id ... ON DELETE SET NULL` **снимает привязку**; операции не трогаются
  никогда — ровно семантика task.md, целиком на констрейнтах.
- Индекс: `CREATE INDEX ix_transactions_goal_item_id ON transactions (goal_item_id)
  WHERE goal_item_id IS NOT NULL` — партиальный: под агрегат «оплачено» и фильтр
  `?goal_item_id=`, не раздувая индекс на 99% непривязанных строк.
- Фильтр списка: `GET /transactions?goal_item_id=` (операции узла в UI).

## 4. Рекурсивные агрегаты — один запрос (named risk)

Один SQL-стейтмент на цель: рекурсивный CTE вниз (path-массив + эффективный срок),
lateral-unnest по path для восходящих сумм, `jsonb_object_agg` по валютам «оплачено».
Никаких N+1; Python только конвертирует K валютных корзин (K ≤ числу валют) и
раздаёт предупреждения.

```sql
WITH RECURSIVE tree AS (
    SELECT i.id, i.parent_id, ARRAY[i.id] AS path, 1 AS depth,
           COALESCE(i.deadline, g.deadline) AS eff_deadline,       -- наследование БЕЗ хранения:
           (i.deadline IS NULL) AS deadline_inherited,             -- узел → родитель → цель,
           CASE WHEN i.currency = g.currency          THEN i.amount_minor
                WHEN i.converted_currency = g.currency THEN i.converted_minor
           END AS own_goal_ccy_minor,                              -- bucket-порядок tx_totals
           (i.amount_minor IS NOT NULL AND i.currency <> g.currency
            AND i.converted_currency IS DISTINCT FROM g.currency) AS own_unconverted,
           i.remind_on, i.remind_days_before, i.sort_order, i.name
    FROM goal_items i JOIN goals g ON g.id = i.goal_id
    WHERE i.goal_id = :goal_id AND i.parent_id IS NULL
  UNION ALL
    SELECT c.id, c.parent_id, t.path || c.id, t.depth + 1,
           COALESCE(c.deadline, t.eff_deadline),                   -- тот же CTE, не N+1
           (c.deadline IS NULL), CASE ... END, ..., c....
    FROM goal_items c JOIN tree t ON c.parent_id = t.id
),
nodes AS (  -- лист = нет детей; листовость нужна правилу потолка (§5)
    SELECT t.*, NOT EXISTS (SELECT 1 FROM goal_items ch WHERE ch.parent_id = t.id) AS is_leaf
    FROM tree t
),
rollup AS (  -- w(x) = Σ сумм ЛИСТЬЕВ поддерева x (следствие «наверх уходит сумма детей», §5)
    SELECT anc AS node_id,
           COALESCE(SUM(n.own_goal_ccy_minor) FILTER (WHERE n.is_leaf), 0) AS subtree_leaf_sum,
           COUNT(*) FILTER (WHERE n.is_leaf AND n.own_unconverted)        AS planned_unconverted
    FROM nodes n CROSS JOIN LATERAL unnest(n.path) AS anc
    GROUP BY anc
),
paid_direct AS (  -- привязанные операции по узлу, сгруппированные ПО ВАЛЮТЕ операции
    SELECT tx.goal_item_id, tx.currency, SUM(tx.amount_minor) AS amt, COUNT(*) AS ops
    FROM transactions tx
    WHERE tx.goal_item_id IN (SELECT id FROM tree)
    GROUP BY tx.goal_item_id, tx.currency
),
paid AS (         -- «оплачено» по ПОДДЕРЕВУ каждого узла, всё ещё по валютам
    SELECT anc AS node_id, jsonb_object_agg(cur, amt) AS by_currency, SUM(ops) AS ops
    FROM (SELECT n.path, pd.currency AS cur, pd.amt, pd.ops
          FROM nodes n JOIN paid_direct pd ON pd.goal_item_id = n.id) q
    CROSS JOIN LATERAL unnest(q.path) AS anc
    GROUP BY anc
)
SELECT n.*, r.subtree_leaf_sum, r.planned_unconverted, p.by_currency, p.ops
FROM nodes n
LEFT JOIN rollup r ON r.node_id = n.id
LEFT JOIN paid   p ON p.node_id = n.id
ORDER BY n.depth, n.sort_order, n.id;
```

Python-достройка (в `services/goal_plan_reads.py`): для каждой валютной корзины
`by_currency` — валюта цели напрямую, иначе `lookup_rate` один раз на валюту;
нет курса → корзина исключается и её `ops` идёт в `paid_unconverted_count`
(честный счётчик, как в tx_totals). Сложность O(N·depth) при N≤500, depth≤6 — копейки.
Тот же CTE с анкером «все корни всех неархивных целей пользователя» обслуживает §6 (upcoming).

## 5. Правило потолка и колонки goals

Числа узла в ответе: `own_amount` (ориентир и потолок), `children_sum` (= subtree_leaf_sum,
рабочее число), `ceiling_exceeded: bool` — **поле ответа, не ошибка** (children_sum >
own_amount при обоих заданных). Наверх всегда уходит children_sum; для листа рабочее
число = own_amount (лист поддерева самого себя — это одно правило, не два).

Маппинг на goals (миграция 0011, существующие строки не трогаются, пунктов задним числом нет):
- `target_minor` **остаётся как есть** (NOT NULL, CHECK > 0): ручная цель режима «без
  пунктов» — поведение сегодняшнего дня.
- `+ initial_budget_minor bigint NULL CHECK (> 0)` — «первоначальный бюджет» (ручной,
  необязательный).
- `+ final_cost_override_minor bigint NULL CHECK (> 0)` — ручная «итоговая стоимость»
  режима планирования; PATCH omit/value/null (null = вернуться к счёту снизу).
- Эффективная цель (одна функция в `domain/goal_plan.py`, используется ВЕЗДЕ — прогресс,
  monthly_needed, реализм):
  `нет пунктов → target_minor; есть → COALESCE(final_cost_override_minor, planned_bottom_up)`.
- Ответ цели несёт `has_items`, `planned_total_minor` (снизу, из §4 по корням),
  `planned_unconverted_count`, `effective_target_minor`, и расхождение показывается
  честно: override и planned оба в ответе, UI сравнивает.
- Почему не «сделать target_minor nullable»: NOT NULL нужен режиму без пунктов и всем
  четырём потребителям контракта; «ручная итоговая» — другой факт, чем «цель, заданная
  до планирования», и склеивание их в одну колонку сделало бы переход «добавили первый
  пункт» неотличимым от ручного override (а task.md требует явного переключения на счёт
  снизу с предупреждением).

## 6. Напоминания

Хранение — намерение, ровно одно из двух (CHECK exactly-one-or-none в §1):
`remind_on` (конкретная дата — стоит на месте) XOR `remind_days_before`
(«за N дней» — едет за ЭФФЕКТИВНЫМ сроком, включая унаследованный). Фактическая
дата НЕ хранится, вычисляется на чтении: `remind_on` либо
`eff_deadline - remind_days_before` (eff_deadline из CTE §4; нет эффективного
срока → напоминание честно без даты, поле null).

`GET /goals/upcoming` — калька с `GET /recurring/upcoming`: `days` 1–90, default 30,
PAT-allowlist. **Регистрируется ДО `/{goal_id}`** (route-order landmine из backend.md —
отдельный роутер `goal_items.py` монтируется в app.py раньше goals.py). Выборка: CTE §4
с анкером по всем корням всех НЕархивных целей пользователя; узел попадает в окно, если
вычисленная дата напоминания ∈ [today, today+days], а без напоминания — если
eff_deadline ∈ окна (напоминание, когда задано, решает само). Строка: goal_id/name,
item_id/name, eff_deadline, deadline_inherited, remind-дата, own_amount/валюта,
paid по поддереву. Сортировка: дата, затем created_at (как у recurring/upcoming).

## 7. Вложения

Отдельная таблица — receipts НЕ переиспользуется (у receipts OCR-жизненный цикл,
parsed_json/error/claim-token, и правило «файл не удаляется» — здесь всё наоборот):

```sql
CREATE TABLE goal_item_files (
    id           uuid PRIMARY KEY,
    goal_item_id uuid NOT NULL REFERENCES goal_items(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    storage_path varchar(255) NOT NULL,
    uploaded     boolean NOT NULL DEFAULT false,   -- proof-момент, см. ниже
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_goal_item_files_goal_item_id ON goal_item_files (goal_item_id);
```

- Механизм ОДИН — `services/storage.py`: тот же bucket, новый path-хелпер
  `goal_item_file_path(user_id, file_id) = "{user_id}/goal-items/{file_id}.jpg"`,
  presign PUT/GET как у receipts. Второго стораджа-класса не заводим.
- `POST .../files` → строка + presigned PUT (лимиты §10a);
  `POST .../files/{id}/confirm` → серверный HEAD (существование + size gate 5 МБ, коды
  409 `FILE_NOT_UPLOADED` / 422 `IMAGE_TOO_LARGE` / 503 `STORAGE_UNAVAILABLE` — таксономия
  receipts) → `uploaded = true`. `view_url` минтится на чтение ТОЛЬКО при `uploaded`
  (правило `_UPLOAD_PROVEN_STATUSES`: URL — только на доказанные байты; presign — чистый
  SigV4 без IO, можно на каждый файл дерева).
- Удаление узла/поддерева (решение пользователя — файлы уносятся): в транзакции удаления
  СНАЧАЛА собрать storage_path поддерева (по path-массиву §4), commit (CASCADE удаляет
  строки), затем **best-effort** удаление объектов из MinIO в background-task с логом
  ошибок. Синхронное удаление отвергнуто: недоступный MinIO не должен блокировать
  удаление пункта; истина — БД, осиротевший объект — утечка диска, не данных (ключ
  содержит только UUID). Предупреждение «с количеством» — на клиенте: ответ дерева несёт
  `files_count` по поддереву (тот же rollup §4).

## 8. Прогресс цели — три величины раздельно

`GoalRead` (и `GoalListRead.items`) получает:
- `paid_minor` + `paid_unconverted_count` — привязанные операции по ВСЕМ узлам цели,
  в валюте цели (§4-агрегат по корням; в списке целей — один сгруппированный запрос
  `transactions JOIN goal_items` по всем целям сразу, не N+1);
- `saved_minor` — как есть (SUM goal_contributions, не трогается);
- `remaining_to_find_minor` = effective_target − paid − saved — считает СЕРВЕР
  (клиентской арифметики по деньгам нет), может быть отрицательным — отдаётся честно.
Сложение paid+saved нигде не производится и в контракте такого поля НЕТ.
Ложится в `goal_reads.py` точечно: `assemble_goal_reads` берёт `effective_target_minor`
вместо `target_minor` во всей ladder-математике (`monthly_needed(target=effective −
paid, saved, months)` — domain-функции не меняются), plus один grouped-запрос paid.
`GoalPortfolio` расширяется этими полями.

## 9. Контракт и MCP (тезисно)

Эндпоинты:
- `GET /goals/upcoming` — §6 (до `/{goal_id}`!);
- `GET /goals/{goal_id}/items` — всё дерево с агрегатами §4 (плоский список с parent_id
  + computed-полями; дерево собирает клиент);
- `POST /goals/{goal_id}/items` | `PATCH /goals/{goal_id}/items/{item_id}` (перенос =
  PATCH parent_id; деньги — PATCH-семантика §1) | `DELETE .../items/{item_id}` (поддерево);
- `POST .../items/{item_id}/files`, `POST .../files/{file_id}/confirm`, `DELETE .../files/{file_id}`;
- transactions: `goal_item_id` в POST/PATCH (omit/value/null) + фильтр `?goal_item_id=`;
- goals: PATCH `initial_budget_minor`, `final_cost_override_minor`; расширенный GoalRead (§5, §8).

Новые коды: `GOAL_ITEM_NOT_FOUND` (404), `GOAL_ITEM_PARENT_NOT_FOUND`, `GOAL_ITEM_CYCLE`,
`GOAL_ITEM_DEPTH_EXCEEDED`, `GOAL_ITEMS_LIMIT_EXCEEDED`, `GOAL_ITEM_FILES_LIMIT_EXCEEDED`,
`GOAL_ITEM_EXPENSE_ONLY`, `GOAL_ARCHIVED` (422), `FILE_NOT_FOUND` (404), `FILE_NOT_UPLOADED` (409).

Пара `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts` — вместе,
одним коммитом (`pnpm openapi`); контрактное изменение гоняет тесты ВСЕХ ЧЕТЫРЁХ
потребителей: web, mobile, api-client, **mcp-server** (fa6c773).

MCP (`packages/mcp-server/src/allowlist.ts`, PAT-allowlist сервера расширить теми же
парами, fail-closed): read — `get_goal_plan` (дерево), `list_upcoming_goal_deadlines`;
write — `create_goal_item`, `update_goal_item`; привязка операции — новые params
`goal_item_id` в `create_transaction`/`update_transaction` (описание: «expense only,
один узел, id из get_goal_plan»). `delete_goal_item` в v1 НЕ публикуем (уносит поддерево
и файлы — деструктивнее delete_transaction; в приложении есть).

## 10. Четыре открытых вопроса — решения

**a. Глубина и фото.** Лимиты ВАЛИДАЦИЕЙ (константы в config), не БД («динамичная БД»
остаётся правдой): глубина ≤ **6** (проверка на create/move тем же ancestor-walk, что
и цикл — глубже breadcrumbs в UI не живут, а рекурсия §2/§4 остаётся копеечной);
пунктов на цель ≤ **500** (потолок стоимости CTE §4: 500×6 unnest-строк ≈ 3000);
фото на пункт ≤ **10**, размер ≤ 5 МБ (существующий receipt size gate). Коды 422 из §9.

**b. Порядок.** Колонка `sort_order integer NOT NULL` среди сиблингов, шаг 1024
(append = max+1024): перестановка — одна запись без перенумерации соседей, при
исчерпании зазора — перенумерация сиблингов одним UPDATE (редко). Drag-and-drop в v1
**не нужен**: PATCH sort_order + кнопки «вверх/вниз» в web покрывают сценарий; DnD —
отдельный UI-скоуп, когда деревья станут длинными. Схема к нему уже готова.

**c. Статус пункта.** В v1 — **нет**. «Оплачено» выводится из денег (привязанные
операции), а не декларируется; «забронировано» — свободный текст в description/links.
Отдельный статус — второй источник правды рядом с деньгами и +1 enum в контракте всех
клиентов ради недоказанной потребности (YAGNI). Вернуться, если попросят явно.

**d. Архивация цели.** Пункты и файлы остаются нетронутыми (архив — не удаление);
записи в пункты архивной цели → 422 `GOAL_ARCHIVED` (зеркало ACCOUNT_ARCHIVED; guard
order: 404 РАНЬШЕ archived — no-oracle, как account_access); привязки операций
**сохраняются** (история); из `GET /goals/upcoming` и блока на главной архивная цель
исчезает целиком (фильтр в анкере CTE); разархивация возвращает всё как было.

---

## Модули и границы файлов

- `models/goal_item.py` — GoalItem + GoalItemFile (goal.py не раздуваем; агрегат пунктов свой).
- `models/goal.py` — +2 колонки §5; `models/transaction.py` — +goal_item_id, CHECK, индекс.
- `alembic/versions/0011_goal_items.py` — обе таблицы, колонки goals/transactions,
  триггер+функция §2 (`op.execute`), индексы; downgrade симметричный (drop trigger/function).
- `domain/goal_plan.py` — чистая математика: effective target, remaining_to_find,
  ceiling-предупреждения, remind-дата (без IO, today параметром).
- `services/goal_plan_reads.py` — CTE §4 (дерево одной цели / upcoming по портфелю /
  paid-rollup для goal_reads), валютная досборка по образцу tx_totals.
- `services/goal_reads.py` — точечно: effective target + три величины §8 в GoalPortfolio.
- `routers/goal_items.py` — items CRUD + files + `GET /goals/upcoming`; монтируется в
  app.py на префикс `/goals` РАНЬШЕ goals.py.
- `routers/goals.py` — PATCH новых полей; `routers/transactions.py` — goal_item_id
  (create/PATCH/фильтр) + `goal_item_access.py`-хелпер (образец account_access).
- storage: только новый path-хелпер в `services/storage.py`.
- CORS: новых HTTP-глаголов нет (GET/POST/PATCH/DELETE уже в списке) — test_cors подтвердит.

## Подзадачи имплементации

1. **Бэкенд-ядро** (FULL — миграция + деньги + контракт): 0011 + модели + триггер §2 +
   items CRUD + CTE §4 + goal_item_id на transactions (§3) + три величины в goal_reads
   (§5/§8) + пара контракта. Файлы: всё из списка выше, кроме files/upcoming/MCP.
2. **Напоминания + upcoming** (STANDARD): `GET /goals/upcoming`, remind-математика в
   domain/goal_plan (колонки уже в 0011). Файлы: routers/goal_items.py,
   services/goal_plan_reads.py, domain/goal_plan.py, контракт.
3. **Вложения** (STANDARD): files-роуты §7, path-хелпер, confirm-HEAD, best-effort
   удаление. Файлы: routers/goal_items.py, services/storage.py, models/goal_item.py (готово).
4. **MCP** (FULL — контракт/безопасность): allowlist.ts + серверный PAT-allowlist +
   тесты четырёх потребителей.
5. **Web** — отдельный груминг (дерево, предупреждение перехода §5, блок на главной);
   mobile заморожен — не разворачиваем.

## Конфликты с решениями пользователя

Прямых конфликтов нет. Два уточнения в рамках делегированной свободы:
- «Глубина не ограничена ("динамичная БД")» — БД действительно не ограничивает
  (никаких CHECK на глубину); практический лимит 6 — валидация уровня API, о которой
  пользователь сам спросил открытым вопросом №1. Константа, поднимается без миграции.
- «Привязать можно сколько угодно операций» — да, но только `kind = expense` (§3):
  запрет transfer пользователь делегировал; запрет income — та же логика («оплачено» —
  ушедшие деньги), знаковая арифметика возвратов в v1 не вводится.
