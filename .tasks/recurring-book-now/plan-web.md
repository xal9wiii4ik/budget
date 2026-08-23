# Implementation Plan (web): recurring-book-now — «+» списать сейчас

## Подход
Одна модалка на оба входа. Обе строки (виджет `/transactions`, шаблон `/recurring`)
сводятся к общему `BookNowTarget` чистым адаптером — модалка не знает, откуда её
позвали. Всё нужное уже есть в обоих серверных типах: `template_id`, `name`,
`due_on|next_due_on`, `amount_minor`, `currency`, `kind`, `account_id`.

## 1. BookNowModal (`features/recurring/BookNowModal.tsx` + `.module.css`)
- Props `{ target, onClose }`; хостит `Modal` (`closeDisabled`, `isDirty` — общий
  dirty-guard).
- Read-only: имя, дата срока (`formatApiDate({locale})`, текст, НЕ input — какой срок
  pending, решает сервер), счёт (имя из `useAccounts()`; не загрузился — прочерк, не
  id). Редактируется ТОЛЬКО сумма: prefill `toInputString(amountMinor, currency)`,
  парс обратно `moneyAmountSchema(currency)` внутри веб-локальной фабрики
  `bookNowFormSchema(currency, t)` рядом с фичей (прецедент
  `features/tokens/tokenFormSchema.ts`: второго потребителя нет, мобилка заморожена,
  сообщения переводимы). Правило `>0` из D4. Никаких ×100 / `toFixed`.
- `dueOn > todayApiDateUtc()` → подпись «запишем сегодняшним числом, дату можно
  поправить в транзакции» (D3-асимметрия сказана вслух, а не спрятана).
- Submit `disabled` в полёте («Списываем…»), рядом «Отмена»; ошибка мутации —
  form-level `role="alert"` над кнопками, как в остальных формах.

## 2. Точки входа
- `UpcomingCharges.tsx`: в строке настоящий `<button type="button">` («+» с
  `aria-label` «Списать «{name}» за {date}»), несёт `charge.due_on`. Все строки
  виджета bookable — сервер уже отфильтровал pending и paused.
- `TemplateRow.tsx`: кнопка «Списать сейчас» в `.actions`, рендерится ТОЛЬКО при
  `templateStatus(t).status === 'active'` (paused и ended дают `next_due_on: null`),
  несёт `next_due_on`.
- Открытая модалка — локальный `useState<BookNowTarget|null>` в `UpcomingCharges` и в
  `routes/RecurringPage.tsx` (не Zustand). Архивный счёт (OQ-3): кнопку не прячем,
  честный 422 в модалке.

## 3. Чистая логика (`features/recurring/bookNowTarget.ts` + `.test.ts`)
`targetFromCharge(charge): BookNowTarget`, `targetFromTemplate(t): BookNowTarget|null`
(null = кнопки нет). vitest только за вторую: active → target, paused → null ДАЖЕ при
непустом `next_due_on`, ended → null. Ломаемое: перепутанный порядок проверок = «+» у
паузнутого шаблона, т.е. деньги. `targetFromCharge` — тривиальный маппинг, без теста.

## 4. Слой данных (`data/recurring.ts`)
- `useBookNow()`: vars `{ templateId, dueOn, amountMinor? }` → `TransactionRead`;
  `POST /recurring/{template_id}/book`, body `{ due_on, amount_minor? }`.
  `amount_minor` шлём ТОЛЬКО если сумма отличается от префилла (patch-builder
  discipline: не изменилось — ключ опускаем).
- onSuccess: `invalidateTemplates()` (корень `['recurring']` — upcoming + list,
  `next_due_on` сдвинулся) ПЛЮС полный пакет tx-write. Сейчас в
  `data/transactions.ts` экспортирован только `invalidateTxLists`;
  `invalidateGoalsList` / `invalidateStats` / `invalidateLimits` /
  `invalidateAccounts` / `affectedMonth` приватные. Решение: добавить туда ОДИН
  экспорт `invalidateAfterTxWrite(queryClient, occurredAt)` = буквально тело
  `useCreateTransaction.onSuccess` (lists + `qk.txSummary(month)` + goals + stats +
  limits + accounts), и переиспользовать его в самом `useCreateTransaction`. Месяц —
  из `created.occurred_at` ОТВЕТА, не из `due_on` (D3: расходятся). Предикаты в
  `data/recurring.ts` не дублируются.
- onError 404 → `invalidateTemplates()` (прецедент `useUpdateTemplate`).

## 5. Ошибки и i18n
- `describeBookNowError(error, lang)` в `lib/errors.ts` — дискриминированный union, не
  `FieldError`: поле одно, реакций две (`{kind:'stale'}` для 422
  `DUE_DATE_NOT_PENDING`, `{kind:'message'}` для остального).
  `describeRecurringError` не переиспользуем: он маршрутизирует на поля
  (`account_id`, `start_date`), которых в этой модалке нет.
- `DUE_DATE_NOT_PENDING` → `invalidateTemplates()` + inline-alert, submit
  скрывается, остаётся «Закрыть». (amended per senior-lead 2026-08-23: inline-alert
  ПРИНЯТ, нового UI-примитива в скоупе нет; копия НЕЙТРАЛЬНАЯ, решение QA-2 в
  task.md: «Срок изменился или уже обработан — данные обновлены».)
- Копия в `ERROR_MESSAGES` (@budget/shared/i18n/errors.ts): НОВЫЕ `recurring.paused`,
  `recurring.dueDateNotPending`; 404 → `recurring.notFound` (добавление аддитивно,
  мобилку не ломает). (amended per PM 2026-08-23, task.md D5: `ACCOUNT_ARCHIVED`
  на эндпоинте НЕ существует — book на архивный счёт успешен, зеркало джобы;
  маппинг не нужен, кнопка у таких шаблонов ведёт себя как обычно.)
- Экранные ключи `dict.en.ts` (набор) + зеркально `dict.ru.ts`: `bookNow.action`,
  `.ariaLabel`, `.title`, `.dueOn`, `.account`, `.amount`, `.earlyNote`, `.submit`,
  `.submitting`, `.stale`. Деньги/даты — shared-хелперы с `{locale}` из `useLocale()`.

## 6. Порядок и зависимость от B1
Пишем сразу всё, кроме одной строки: литерал пути `'/recurring/{template_id}/book'`
не компилируется до регенерации `schema.d.ts`. Руками не типизируем НИЧЕГО
серверного (ответ — существующий `TransactionRead`), никаких `as`, `schema.d.ts` не
трогаем. `BookNowVars` — клиентский тип аргументов хука, не копия контракта. Гейты
(`typecheck`, `lint`, `vitest`) гоняются ПОСЛЕ того, как B1 положил пару
`openapi.json` + `schema.d.ts`; до этого зелёных гейтов у W1 нет — ожидаемый блокер.

## Открытые вопросы
1. Тост vs inline-alert (§5) — подтвердить.
2. В виджете иконка «+» с aria-label, в `/recurring` текстовая кнопка — подтвердить.

## Риски
- Арреарс (D2, сырая ватермарка): при пропущенном прогоне джобы первая строка виджета
  может НЕ быть первым pending-сроком → закономерный 422 на рабочей с виду кнопке.
  Лечится тем же refetch; в QA сценарий обязателен.
- `invalidateAfterTxWrite` трогает горячий `useCreateTransaction`: рефактор — чистое
  извлечение тела, без изменения состава и порядка.
- Двойной клик защищён и клиентом (`disabled`), и сервером — проверять оба.

## Оценка (агент-минуты)
письмо 55 / гейты 12 / верификация 18


## Amended per PM 2026-08-23 — архивный счёт видим (task.md D5a)
- Кнопка НЕ блокируется и не прячется. Если `accountIndex[template.account_id]`
  архивен (данные уже есть: `['accounts','list']` archived-inclusive питает все
  селекторы, docs/web.md) — у точки входа и в BookNowModal пояснение:
  «Списание уйдёт на архивный счёт „<имя>“» + действие «Перенести шаблон» =
  открыть существующую форму редактирования шаблона (account-move B3, поле
  счёта уже там; ничего нового не строим). После переноса модалка book
  переоткрывается/обновляется обычным refetch (`['recurring']` уже
  инвалидируется PATCH'ем шаблона).
- Новые i18n-ключи: `bookNow.archivedAccountNote`, `bookNow.moveTemplate`
  (en+ru зеркально).
- Чистая логика «архивен ли счёт шаблона» — тривиальный lookup, отдельного
  vitest не заслуживает (правило тестов); состояние проверяется живым сценарием
  web-qa (резервный слот).
- Оценка W1: +5 а-мин письмо, верификация без изменений.
