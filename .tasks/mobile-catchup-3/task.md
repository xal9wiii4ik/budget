# mobile-catchup-3 — последняя часть догоняющего мобилки

Tier: STANDARD (контракт не меняется; деньги — только поля ответа). Team: три
mobile-engineer параллельно по непересекающимся экранам, mobile-qa — один сквозной
проход в конце. Без architect/backend. Части 1–2: `../mobile-catchup-{1,2}/`.

## План (≤200 слов)

**Линия A — операции/категории.** `TxListFilters` += `q/country/sort`; на вкладке
операций: поиск (debounce), лист фильтров (категория, страна, сортировка, режим
периода месяц|всё|диапазон), чипы активных фильтров; `txFilters.ts` (чистый: те же
правила омиссии ключей, `isNarrowed`, `showsDayGroups`, что и веб). Строки списка
показывают исходную пару (N-2 части 2) — `rowDisplay` переезжает из веба в
`@budget/api-client` (веб — только импорты). Экран `category-transactions?id=`:
период месяц|диапазон, заголовок-итог из `/stats/summary.by_category` (новый
`data/stats.ts`), список тем же ключом, что вкладка. Форме передаётся МЕСЯЦ СТРОКИ.

**Линия B — регулярные/настройки/хвосты.** `data/recurring.ts` (+`upcoming`),
экран списка шаблонов (даты: `start_date`, `next_due_on`, `end_date`), форма
шаблона (modal, start_date на create+edit), виджет `UpcomingCharges` (компонент,
вайринг в tab — потом). Вкладка «Ещё»: строка «Регулярные», пикер языка (PATCH
profile + инвалидация `['profile']`), базовая валюта с ConfirmDialog и
предупреждением, месячный доход (подсказка через `/fx/convert`, как веб).
`profile.ts`: смена базы → +`['goals']`. Хвосты: N-2 (scroll-to-first-error в
`KeyboardAwareForm`), N-3 (trigger парного поля), N-5 (мобильная обёртка
`toInputString` → запятая на ru), N-5ч2 (мёртвый ключ `photo.attach`), O-1.

**Линия C — цели.** Вкладка «Цели»: список, `FreeBalanceSummary` (basis-арм +
окно), форма цели, взносы. Экран плана `goal-plan?id=`: дерево (`buildTree` в
api-client), сводка трёх величин, форма пункта (срок|напоминание, наследование),
move up/down + перенос, удаление с пересчётом потомков/файлов, фото пункта
(последним — можно не успеть). `GoalItemPicker` в форме операции; `GoalDeadlines`
компонент. `data/transactions.ts`: `touchesGoalPlan` → bare `['goals']`.

**Общие файлы** (только Edit, никогда Write): dict.en/ru — каждая линия свой
блок; queryKeys — свои ключи; `(tabs)/_layout` — свой Tabs.Screen; `(app)/_layout`
— свои Stack.Screen + `MODAL_PARENT_TAB`. Вайринг виджетов в `transactions.tsx` —
линия A после сдачи B и C.

**Оценка (агент-минуты):** написание 30/40/60; гейты 10 (shared/api-client/web/
mcp-server из-за переезда `rowDisplay`); верификация 90–120 + один круг фикса.
Симулятор — только линия B (O-1) и QA; порты: API 8023+, Metro 8085+, БД
`budget_mobile_catchup_3*`.

## Не делаем
E-1 (чеки), графики целей (нет чарт-библиотеки), book-now «+» на виджете
(скоуп `recurring-book-now`, не в карточке), депозиты/статистика/советник/импорт.
