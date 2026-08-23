# Implementation Plan (web): recurring-book-now — «+» = ярлык предзаполненной формы

> Первая редакция этого файла (эндпоинт `POST /recurring/{id}/book`, `BookNowModal`,
> сдвиг ватермарки) АННУЛИРОВАНА вместе с первой версией скоупа — PM 2026-08-23;
> её текст доступен в истории git. Ниже — действующий план под task.md R1–R7.
> Статус: РЕАЛИЗОВАН (W1, 2026-08-23), отклонений от плана нет; добавления по
> ходу отмечены пометкой «(факт реализации)».

## Подход
Новой модалки и мутации нет (R1/R2). «+» открывает существующий `TransactionFormModal`
в режиме создания той же механикой, что receipt confirm: проп `templatePrefill?:
{source, occurredAt}` (взаимоисключим с `transaction`/`receipt`) + третья ветка
`defaultValues` + чистый маппер. Сабмит — обычный `useCreateTransaction` (R5).

## Затронутые файлы
- `features/transactions/TransactionFormModal.tsx` — проп + ветка `defaultValues`;
  `defaultAccountId` из `source.account_id` вместо `pickDefaultAccount`; `currentId` у
  `AccountField`/`accountFieldBlocked` → `transaction?.account_id ??
  templatePrefill?.source.account_id` — несущее: иначе архивный счёт шаблона не попадёт
  в `selectableAccounts` и `<select>` молча подменит его вместо честного 422 (R5);
  строка `txForm.fromTemplateLede` («это обычная операция, автосписание не отменяет», R6).
  (факт реализации) Тем же правилом накрыта архивная КАТЕГОРИЯ шаблона:
  `startingCategoryId = transaction?.category_id ?? templatePrefill?.source.category_id`
  питает существующую ветку «архивная текущая категория остаётся в опциях» — иначе
  селект показывал бы «Без категории», а форма отправляла бы её id.
- `features/recurring/UpcomingCharges.tsx` — `<button>` «+» на строке (`aria-label` с
  именем и датой) + проп `onAdd(charge)`; виджет read-only, только эмитит событие.
- `routes/TransactionsPage.tsx` — вариант `ModalState` `createFromTemplate`; source из `recurringIndex`
  (страница УЖЕ держит `useRecurringTemplates()` для бейджей — нового запроса нет), индекс пуст/ошибка →
  source из полей `UpcomingChargeRead` (там нет `merchant`/`note`). Дата = `charge.due_on` (R4).
- `features/recurring/TemplateRow.tsx` — четвёртая кнопка в `.actions`, видна и на
  paused (R5), и на ended; `routes/RecurringPage.tsx` — `ModalState` + рендер
  `TransactionFormModal` (`month = currentMonth()`), дата `todayApiDate()` (R4).
- `dict.en.ts` + `dict.ru.ts` — `upcoming.addFromTemplate`, `recurring.addTransaction`,
  `txForm.fromTemplateLede` (с параметром «имя шаблона»).
- `packages/shared/src/i18n/errors.ts:87,157` (проверка R5 — правка нужна): копия
  `transaction.accountArchived` (туда роутит `lib/errors.ts:163`) — только факт («новые операции по нему
  записать нельзя»), без выхода, в отличие от соседнего `account.archived`. Добавляем «Pick another
  account.» / «Выберите другой счёт.»; ключи и типы те же, но файл общий с мобилкой → нужен ОК лида.
## Новый модуль
`features/transactions/templatePrefill.ts`: `TemplatePrefillSource`
(`account_id, amount_minor, currency, kind, category_id, merchant, note, name`) +
`buildTemplateDefaults(source, occurredAt)` → `MultiCurrencyTransactionFormInput`:
`amount = toInputString(amount_minor, source.currency)`, `currency`/`original_currency =
source.currency`, `original_amount`/`base_amount` = '' (авто), `category_id ?? ''`,
`note ?? ''`, `merchant = merchant ?? name`; `country` — из профиля, в модалке (как в confirm). Валюта в
обоих полях одна: стамп шаблона == валюта счёта (§4), сумма декодится ею же (AM-5) — маппер не зависит
от `useAccounts`. Фолбэк на `name` — отклонение от джобы (`recurring_jobs.py:149-150` копирует только
`merchant`): у ручной записи нет `recurring_template_id`, значит нет и бейджа с именем; поле правится.
`templatePrefill.test.ts` (node-vitest): экспонента 0 (JPY 5000 → «5000»), экспонента 2,
фолбэк `merchant ?? name` (в т.ч. отсутствующее поле у строки виджета),
`category_id`/`note`: `null → ''`.
(факт реализации, решение PM №1) `features/accounts/accountOptions.test.ts` —
`selectableAccounts` держит АРХИВНЫЙ стартовый счёт в опциях и не пускает туда
прочие архивные; до этого скоупа функция не была покрыта вовсе.

## Состояния UI
Виджет: существующие loading/error/empty/ready, «+» только в ready-ветке строк — новых скелетонов и
джанка нет. `/recurring`: кнопка всегда активна (мутации за ней нет). Форма: свои арм-ы (базовая валюта,
счета, `accountFieldBlocked` → Save disabled, pending/error сабмита); архивный счёт помечен
`common.archivedParens`, 422 → form-level сообщение. Строка виджета после успеха НЕ исчезает (R6).

## Решения PM 2026-08-23 (вторая волна) — ОБА вопроса закрыты, инженеру исполнять
1. **`currentId`/`accountFieldBlocked` — ОБЯЗАТЕЛЬНАЯ часть работы + ТЕСТ (PM).**
   Молчаливая подмена архивного счёта первым попавшимся = деньги не на той карте
   без единого сообщения. Тест обязателен: предзаполнили архивным счётом →
   форма показывает ИМЕННО его (он в selectable-наборе через `currentId`) и
   отказывает по R5, а не подставляет другой. Форма чистой логики
   (`accountOptions.ts`-вроде vitest) — на усмотрение инженера, само требование
   не обсуждается.
2. **`merchant = merchant ?? name` — УТВЕРЖДЁН.** Джоба копирует только
   `merchant`, потому что у её строки есть `recurring_template_id` и бейдж с
   именем шаблона; у ручной записи связи и бейджа нет — без фолбэка трата
   осталась бы безымянной. Разница поведения обоснована разницей ДАННЫХ.
   ОБЯЗАТЕЛЬНО: комментарий с этим объяснением в маппере
   (`templatePrefill.ts`), чтобы следующий не «выровнял» обратно.
3. **Правка копии `transaction.accountArchived` в общем пакете — РАЗРЕШЕНА.**
   Мобилка фактически разморожена со скоупа счетов; копия улучшается для обоих
   клиентов: вместо констатации факта — подсказка «Выберите другой счёт. /
   Pick another account.» Достаточная проверка: мобильный клиент типизируется
   после правки (typecheck apps/mobile в гейтах W1).
   (факт реализации) ВАЖНО: до мобилки правка НЕ доезжает —
   `apps/mobile/src/data/errors.ts:157-161` держит собственную захардкоженную
   английскую строку и `ERROR_MESSAGES` не читает вовсе (grep по репозиторию:
   единственные потребители — веб через `lib/errors.ts`). Мобилку W1 не трогает
   по брифу; выравнивание копии — follow-up.

## Риски
`currentId` — единственная правка, ошибка в которой пишет деньги не на тот счёт. Три
взаимоисключающих пропа модалки типами не запрещены — инвариант доккоментарием.
Незакоммиченный base-currency правит тот же файл: мержим поверх, его правки не трогаем.

## Оценка (агент-минуты)
письмо ~22 / гейты (typecheck+lint+vitest) ~8 / верификация ~10.
