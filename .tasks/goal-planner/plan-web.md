# Implementation Plan (web): goal-planner — цель как план с деревом пунктов

Источники: `task.md` (решения пользователя, не переоткрываются), `architecture.md`
(§4–§10 — контракт), `grooming-review.md` (W1/W2, тиры), `qa-web-checklist.md`,
`docs/web.md`. Подзадачи ниже — ровно W1/W2 из grooming-review.

## Approach

- **Отдельный роут `/goals/:goalId`**, не раскрывашка внутри `GoalCard`: qa-web TC-1
  требует F5 и прямой вход по URL, а дерево + вложения + операции узла не помещаются
  в карточку. `/goals` остаётся списком; на карточке — ссылка «План».
- **Сервер считает, клиент рисует** (D12). Все три величины прогресса, `children_sum`,
  `ceiling_exceeded`, `remaining_to_find_minor`, `files_count`, дата напоминания —
  поля ответа. Клиент не складывает деньги нигде, включая «оплачено + накоплено»
  (запрещено task.md) и «сумма детей» (её считает CTE §4).
- **Единственная клиентская производная — структура**: плоский список с `parent_id`
  → дерево. Это не деньги и не даты, а порядок отрисовки, поэтому живёт в чистом
  tested-модуле рядом с фичей (`realism.ts`/`upcomingRows.ts` прецедент).
- **Формы — существующие механизмы**: rhf + zod, PATCH-диффы (omit/value/null),
  пара «своя валюта + сумма в валюте цели» — калька с `convertedSection.ts`
  транзакций, а не второй способ вводить деньги.
- Альтернативы отвергнуты: DnD (решение §10b — кнопки вверх/вниз), локальное дерево
  в Zustand (это server state), рекурсивный компонент со своим запросом на узел (N+1).

## Screens / components affected

- `apps/web/src/App.tsx` — новый роут `/goals/:goalId` под `ProtectedLayout`.
- `apps/web/src/routes/GoalsPage.tsx` — без изменений логики; ссылка на план идёт
  через `GoalCard`.
- `apps/web/src/features/goals/GoalCard.tsx` — `<Link to={`/goals/${goal.id}`}>`
  («План»); в режиме плана (`has_items`) карточка показывает `effective_target_minor`
  и три величины вместо одного «saved / target» (см. UI states).
- `apps/web/src/features/goals/GoalFormModal.tsx` — поле «первоначальный бюджет»
  (`initial_budget_minor`, опционально); `final_cost_override_minor` редактируется
  НЕ здесь, а на экране плана, где рядом видна сумма снизу.
- `apps/web/src/features/transactions/TransactionFormModal.tsx` — селектор пункта
  (W2, §«Data layer»).
- `apps/web/src/routes/TransactionsPage.tsx` — второй виджет: ближайшие сроки целей,
  рядом с `UpcomingCharges`, под тем же `isNarrowed`-гейтом (строки не отвечают на
  поиск/страну/категорию — тот же довод, что для upcoming-виджета).
- `apps/web/src/data/queryKeys.ts`, `data/transactions.ts` (инвалидация),
  `apps/web/src/lib/errors.ts` (роутинг новых кодов), `i18n/dict.{en,ru}.ts`.

## New components / hooks

Дерево фичи: `apps/web/src/features/goals/plan/`

- `GoalPlanPage.tsx` (в `routes/`) — шапка цели + блок стоимости + дерево;
  4 арма `queryPhase`.
- `PlanSummary.tsx` — три РАЗДЕЛЬНЫЕ величины (оплачено / накоплено / осталось
  найти), «план неполный, стоимость растёт», расхождение override ↔ сумма снизу,
  счётчики несконвертированного (`planned_unconverted_count`,
  `paid_unconverted_count`) — каждый своей строкой, как `tx_totals`.
- `PlanTree.tsx` + `PlanNodeRow.tsx` — семантические вложенные `<ul>/<li>`
  (`role` не подменяем), отступ по `depth`, кнопки вверх/вниз/добавить ребёнка/
  править/перенести/удалить; кнопка «добавить ребёнка» скрыта на `depth === 6`.
- `PlanNodeDetails.tsx` — описание, ссылки (`http(s)` только,
  `rel="noreferrer noopener"`), фото (W2), список операций узла (W2).
- `GoalItemFormModal.tsx` — CRUD пункта: имя, описание, ссылки, сумма+валюта,
  вторая сумма в валюте цели, срок, напоминание, родитель.
- `FinalCostSection.tsx` — ручная итоговая стоимость (value/null → «вернуться к
  счёту снизу»), рядом всегда показано `planned_total_minor`.
- `ItemPhotos.tsx` (W2) — presign → PUT → confirm → `view_url`, лимит 10.
- `GoalDeadlines.tsx` (W2) — виджет ближайших сроков на `/transactions`.
- `ItemMoveDialog.tsx` — перенос узла: `<select>` допустимых родителей (см.
  `moveTargets`), 422 `GOAL_ITEM_CYCLE`/`DEPTH_EXCEEDED` всё равно роутится.

Чистые модули (vitest, node-only; только они и тестируются — политика «без тестов
ради тестов»):

- `buildTree.ts` — плоский список → корни/дети; сортировка `sort_order`, затем `id`;
  узел с неизвестным `parent_id` НЕ теряется (поднимается в корни) — потеря строки
  с деньгами хуже кривого отступа; возвращает `depth`, `descendantIds`.
- `moveTargets.ts` — допустимые родители для узла (исключить себя и потомков,
  учесть лимит глубины поддерева ≤ 6) + `siblingMove(node, siblings, dir)` →
  новое значение `sort_order` (см. Open question Q3).
- `remindPreview.ts` — (`mode`, `remind_on` | `remind_days_before`, `eff_deadline`)
  → дата или `null` («срока нет — напоминания без даты»). Только арифметика по
  календарю через shared-хелперы; сервер остаётся источником истины на чтении.

Тестируем: `buildTree` (сироты, порядок, глубина), `moveTargets` (запрет потомка/
себя, потолок глубины), `remindPreview` (обе ветки + отсутствие срока). Больше
ничего — остальное либо серверные поля, либо JSX.

## Data layer

Новый модуль `apps/web/src/data/goalItems.ts` (goals.ts не раздуваем), всё через
`packages/api-client`; типы — только из `components['schemas'][...]`.

Ключи (`data/queryKeys.ts`), под правилом disjoint roots из `docs/web.md`:

| Ключ | Эндпоинт | Почему так |
|---|---|---|
| `qk.goalDetail(goalId)` = `['goals', goalId, 'detail']` | `GET /goals/{goal_id}` | под-семейство цели; `['goals', goalId]` уже инвалидируется взносами |
| `qk.goalItems(goalId)` = `['goals', goalId, 'items']` | `GET /goals/{goal_id}/items` | дерево читается ОДНИМ запросом на цель (qa TC-1: без N+1) |
| `qk.goalsUpcoming(days)` = `['goals', 'upcoming', {days}]` | `GET /goals/upcoming` | тот же корень намеренно (прецедент `recurring/upcoming`), `days` в ключе |
| операции узла | `GET /transactions?goal_item_id=` | это СПИСОК ТРАНЗАКЦИЙ → `qk.txList({ goal_item_id, limit })`; в `TxListFilters` добавляется `goal_item_id?: string` (data-in-the-key), и существующий предикат `key[0]==='transactions' && key[1]!=='summary'` покрывает его бесплатно |

Инвалидация:

- Мутации пункта (create / PATCH / move / sort / delete) → `['goals', goalId]`
  (дерево + detail), `['goals','list']` (has_items, planned_total, effective target,
  три величины на карточке), `['goals','upcoming']` (сроки и напоминания уехали).
- DELETE узла дополнительно → `invalidateTxLists()` из `data/transactions.ts`:
  сервер делает `goal_item_id → NULL` у привязанных операций (§3), строки списка
  становятся ложными. Это единственное место, где write в целях трогает транзакции.
- Файлы (create/confirm/delete) → `['goals', goalId]` (дерево несёт `files_count`).
- **Существующей инвалидации tx-мутаций НЕДОСТАТОЧНО** (проверено по
  `data/transactions.ts`): сегодня они трогают только `['goals','list']`, а
  привязанная операция двигает `paid` в дереве (`['goals', goalId, 'items']`) и в
  виджете сроков (`['goals','upcoming']`). Правило: если у операции `goal_item_id`
  был ДО или стал ПОСЛЕ записи — инвалидировать бареный `['goals']`; иначе поведение
  как сегодня. Триггер вычисляется из ответа мутации + исходной строки (прецедент
  `useUpdateProfile`: сравнение кеша с ответом PATCH), а не из «на всякий случай».
- Оптимистичных апдейтов НЕТ нигде: каждое число на экране — производная сервера
  (rollup по дереву), локально его честно не пересчитать.

Привязка в `TransactionFormModal` (W2):

- Поле «Пункт плана»: два `<select>` (цель → пункт) или один сгруппированный
  `<optgroup>` по целям; источник — `['goals','list',{includeArchived:false}]` +
  `qk.goalItems(goalId)` выбранной цели (запрос не летит, пока цель не выбрана).
- Видно ТОЛЬКО при `kind === 'expense'` (§3); при переключении на income поле
  очищается — как `category_id` при смене kind, чтобы пользователь не мог собрать
  заведомый 422 `GOAL_ITEM_EXPENSE_ONLY`. В `TransferFormModal` поля нет вовсе.
- Create: ключ в body только если выбран. PATCH: диф через `buildTransactionPatch`
  — понадобится ветка для `goal_item_id` в `packages/api-client` (omit/value/null),
  как у `category_id`; правка билдера — это КОД пакета, не generated-схема.

Коды ошибок: `describeGoalItemError` в `lib/errors.ts` (`GOAL_ITEM_NOT_FOUND`,
`GOAL_ITEM_PARENT_NOT_FOUND`, `GOAL_ITEM_CYCLE`, `GOAL_ITEM_DEPTH_EXCEEDED`,
`GOAL_ITEMS_LIMIT_EXCEEDED`, `GOAL_ITEM_FILES_LIMIT_EXCEEDED`,
`GOAL_ITEM_EXPENSE_ONLY`, `GOAL_ARCHIVED`, `FILE_NOT_FOUND`, `FILE_NOT_UPLOADED`),
копия — новые ключи в `packages/shared/src/i18n/errors.ts` (аддитивно; кросс-пакет →
Q7). `GOAL_ITEM_EXPENSE_ONLY` роутится на поле пункта в форме транзакции.

Формы/схемы: `goalItemFormSchema.ts` живёт В ФИЧЕ (`features/goals/plan/`), не в
`packages/shared` — прецеденты `tokenFormSchema.ts` и `incomeFormSchema.ts`: второго
потребителя нет, мобилка заморожена. Денежные парсеры (`parseMoney`,
`moneyAmountSchema`, `toInputString`) берутся из shared — своей арифметики нет.

## UI states

**`/goals/:goalId` (экран плана)**

- loading — скелетон шапки + 3 строк дерева фиксированной высоты (без прыжка).
- unreachable / error — `QueryStateNotice` с retry (4 арма `queryPhase`, как везде).
- 404 цели — «цель не найдена или удалена» + ссылка на `/goals`, не белый экран.
- empty (`items.length === 0`) — что делать дальше: «Разложите цель на пункты…» +
  кнопка «Добавить пункт»; ручная сумма при этом показана как сегодня, блока «план
  неполный» НЕТ (qa TC-2 шаг 1).
- ready + `has_items` — дерево, три величины, «план неполный: стоимость собирается
  снизу и будет расти по мере добавления пунктов» (пока нет
  `final_cost_override_minor`), при override — ОБА числа рядом, ни одно не подменяет
  другое.
- archived-цель — весь экран read-only (кнопки записи скрыты) + баннер «цель в
  архиве»; 422 `GOAL_ARCHIVED` всё равно роутится (гонка вкладок).
- Узел: `ceiling_exceeded` → предупреждение (жёлтое, не ошибка) с обеими величинами
  — «своя сумма X, пункты внутри Y»; сохранение НИКОГДА не блокируется.
- Узел без своего срока → «к 15 июня · срок цели» (`deadline_inherited`).
- Несконвертированное → отдельная строка-счётчик, НЕ прячется и не приплюсовывается.

**Форма пункта**

- pending — кнопка дизейблится (двойной Enter не создаёт два пункта), `closeDisabled`.
- error — серверный код на поле или в шапке формы; ничего не закрывается само.
- dirty-guard — через общий `Modal` (`shouldConfirmDiscard`) бесплатно.
- Валюта: сумма в валюте пункта; вторая сумма в валюте цели появляется только при
  расхождении валют (`shouldShowConvertedSection`-логика), с подсказкой курса и
  кнопкой «вернуть авто» (null → пересчёт сервером).
- Напоминание: радио «конкретная дата» / «за N дней» — ровно одно, второе поле
  очищается при переключении; под полем СРАЗУ дата из `remindPreview`; нет
  эффективного срока → «срок не задан — напоминание без даты».
- **Первый пункт у цели без пунктов** (`has_items === false`) — ConfirmDialog ДО
  записи: «итоговая стоимость начнёт считаться из пунктов; ручная сумма остаётся
  ориентиром». Отмена не создаёт пункт (qa TC-2).

**Удаление узла** — `ConfirmDialog`, `destructive`, текст называет: количество
пунктов в поддереве (клиентская структура из `buildTree`), количество файлов
(`files_count` — серверное поле) и что привязанные операции ОСТАНУТСЯ, просто
без привязки. Плюрализация через `Intl.PluralRules` (ru 21 vs 11 — уже покрыто
`t.test.ts`).

**Виджет сроков на `/transactions`** — калька с `UpcomingCharges`: компактные армы,
loading = 2 плейсхолдера фиксированной высоты, empty = «ближайших сроков нет» +
ссылка на `/goals`, ready = ≤5 строк + «ещё N». Пометка «скоро»/«сегодня» — сравнение
`YYYY-MM-DD` строк с `todayApiDateUtc()` (сервер решает даты в UTC), не с локальной
полуночью.

**i18n** — новые неймспейсы `goalPlan.*`, `goalItemForm.*`, `goalDeadlines.*` в
`dict.en.ts` (ключевое множество) + зеркало `dict.ru.ts`; плюралы для файлов/пунктов/
«ещё N». Имена цели и пунктов, описания и ссылки НЕ переводятся. Все
`formatMoney/formatApiDate` — с `{ locale }`.

## Подзадачи (границы файлов)

**W1 — экран плана и CRUD пункта** (STANDARD)
`App.tsx`, `routes/GoalPlanPage.tsx(.module.css)`, `features/goals/plan/{PlanSummary,
PlanTree,PlanNodeRow,PlanNodeDetails,GoalItemFormModal,FinalCostSection,ItemMoveDialog}`,
`plan/{buildTree,moveTargets,remindPreview,goalItemFormSchema}(.test).ts`,
`data/goalItems.ts`, `data/queryKeys.ts`, `features/goals/GoalCard.tsx`,
`features/goals/GoalFormModal.tsx`, `lib/errors.ts`, `i18n/dict.*`.

**W2 — привязка операций, вложения, виджет сроков** (STANDARD)
`features/transactions/TransactionFormModal.tsx` (+ `goalItemField.ts` — чистый
маппер видимости/очистки по kind), `packages/api-client` patch-builder (ветка
`goal_item_id`), `data/transactions.ts` (инвалидация), `data/queryKeys.ts`
(`goal_item_id` в `TxListFilters`), `features/goals/plan/{ItemPhotos,
GoalDeadlines}`, `routes/TransactionsPage.tsx`, `i18n/dict.*`.

Границы пересекаются в `queryKeys.ts` и `dict.*` — мержить последовательно.

**Старт параллельно бэкенду**: до регенерации `schema.d.ts` можно писать только
`buildTree` / `moveTargets` / `remindPreview` / CSS / словари. Всё типизированное
ждёт контракт-пару (B1) — руками серверные типы не объявляем и `as` не ставим.

## Open questions

1. **Q1 — файлы в ответе дерева.** `architecture.md` §7 обещает `files_count` по
   поддереву. Веб не может нарисовать превью без списка: нужен ли per-node
   `files: [{id, uploaded, view_url}]` в `GET /goals/{goal_id}/items`, или заводится
   отдельный `GET .../items/{id}/files`? И нужны ОБА счётчика: `files_count` (свой,
   для строки узла) и по поддереву (для текста удаления) — сегодня это одно поле.
2. **Q2 — валюта у каждого вычисленного числа.** `children_sum`, `planned_total_minor`,
   `paid_minor`, `remaining_to_find_minor` предполагаются в валюте цели. Правило AM-5
   («валюта никогда не fallback») требует явного эха валюты в ответе либо явной
   фиксации в контракте. Прошу поле/формулировку.
3. **Q3 — вверх/вниз.** `PATCH sort_order` силами клиента = клиент считает
   `сосед ± шаг` и может исчерпать зазор/словить коллизию. Просим одно из:
   (а) сервер нормализует/перенумеровывает сиблингов при коллизии, приняв любое целое,
   или (б) семантика `{"move": "up" | "down"}` в PATCH. Иначе перестановка — два
   неатомарных PATCH.
4. **Q4 — `?goal_item_id=`**: фильтр по УЗЛУ или по поддереву? План исходит из
   «только прямые привязки» (иначе список операций узла и `paid` по поддереву
   рассинхронятся по смыслу; подпись в UI будет разной).
5. **Q5 — строки `GET /goals/upcoming`**: нужны валюты для `own_amount`/`paid` и
   имя цели + путь (breadcrumb) пункта — «Отель в Кракове» без «Поездка → Жильё»
   на главной не читается.
6. **Q6 — `GET /goals/{goal_id}` (single)**: получает ли он те же новые поля §5/§8
   (`has_items`, `planned_total_minor`, `effective_target_minor`, `paid_minor`,
   `remaining_to_find_minor`), что и элементы списка? Экран плана читает именно его.
7. **Q7 — копия ошибок в `packages/shared/src/i18n/errors.ts`**: добавление ключей —
   кросс-пакетное изменение (мобилка заморожена, но аддитивно безопасно). Нужен
   явный ОК senior-lead.
8. **Q8 — `depth` в ответе узла**: чтобы прятать «добавить ребёнка» на 6-м уровне,
   не пересчитывая глубину поддерева на клиенте после каждого переноса. Клиент
   умеет вывести её из `parent_id`, но серверное поле дешевле и честнее.

## Risks

- **Инвалидация после привязки операции** — главный риск экрана: если tx-мутации не
  начнут трогать `['goals', goalId, 'items']` и `['goals','upcoming']`, «оплачено»
  будет врать до F5 (qa TC-4 это ловит). Правило описано выше; проверять именно
  третий уровень (узел → родитель → цель).
- **Перевязка операции на другой узел** — «оплачено» не должно задвоиться:
  клиент ничего не складывает, но одна пропущенная инвалидация выглядит как задвоение.
- **Дерево на 500 узлов** — рендер плоского `<ul>` с отступами; `buildTree` за один
  проход по мапе, без рекурсивных `filter` на узел. Виртуализации не заводим
  (нет библиотеки и нет доказанной потребности).
- **Смешение валют** — сумма пункта в своей валюте, рабочие числа в валюте цели,
  `allocated_monthly_minor` в базовой: три валюты на одном экране, каждая
  форматируется СВОЕЙ, ни одна не fallback (правило GoalCard T4/T8').
- **`view_url` протухает** — минтится на чтение; долго открытый экран покажет битые
  картинки. `onError` на `<img>` → плейсхолдер + «обновить», без падения экрана.
- **Перенос узла в собственного потомка** — `moveTargets` фильтрует, но 422
  `GOAL_ITEM_CYCLE` из гонки вкладок всё равно роутится в диалог.
- **375px** — дерево с отступами на 6 уровнях: отступ ограничивается (clamp) и на
  узкой ширине заменяется хлебной крошкой родителя, иначе строки уезжают.
- **Переход «ручная → снизу»** — если предупреждение показать ПОСЛЕ создания пункта,
  пользователь увидит изменившуюся цель без объяснения; диалог строго ДО записи.

---

## Резолюции open questions (сведение 2026-08-24, решения PM + senior-lead)

Контрактные ответы зафиксированы в `plan.md` §8 — здесь только следствия для веба.

1. **Q1** — в дереве ДВА счётчика: `files_count` (строка узла) и `subtree_files_count`
   (текст ConfirmDialog удаления). Список файлов с `view_url` — отдельный
   `GET .../items/{item_id}/files`, грузится при открытии PlanNodeDetails
   (новый ключ `['goals', goalId, 'items', itemId, 'files']`).
2. **Q2** — ответы несут явные валюты: `currency` у own_amount узла, `goal_currency`
   одним эхом на ответ. Форматирование СТРОГО от серверных полей, fallback запрещён (AM-5).
3. **Q3 (PM)** — перестановка СЕРВЕРНАЯ: PATCH `{"move": "up"|"down"}`, один запрос,
   атомарно. `sort_order` из формы и из patch-builder УБРАТЬ; `ItemMoveDialog`/кнопки
   шлют только move. Разрядка шага 1024 — не забота клиента.
4. **Q4 (PM)** — `?goal_item_id=` фильтрует по ПОДДЕРЕВУ. Подпись списка операций
   узла формулируется как «операции по поддереву» — совпадает по смыслу с «оплачено»
   строкой выше; клиентской фильтрации «только прямые» не заводить.
5. **Q5** — строки upcoming получают `breadcrumb` (имена предков), имя цели и явные
   валюты — GoalDeadlines рендерит «Поездка → Жильё → Отель» с сервера, не строит
   путь запросом дерева.
6. **Q6** — `GET /goals/{goal_id}` несёт полный набор полей плана; экран читает
   single-ответ, БЕЗ доставания цели из кэша списка.
7. **Q7 (PM)** — ключи в `packages/shared/src/i18n/errors.ts` РАЗРЕШЕНЫ; условие —
   мобилка типизируется после правки (`pnpm -C apps/mobile typecheck` в гейт W2).
8. **Q8 (PM)** — сервер отдаёт `depth`; клиентский пересчёт глубины убрать из плана
   (buildTree глубину не считает, берёт поле).
- **Patch-builder (PM):** ветка `goal_item_id` в общем сборщике разрешена; в гейте W2
  ДОКАЗАТЬ поиском по `apps/mobile` (grep по buildTransactionPatch/полям формы), что
  мобильный клиент не задет, — результат grep в отчёт, не рассуждение.
- **Схема формы в фиче** — принято, остаётся в `features/goals/plan/goalItemFormSchema.ts`.
