# Implementation Plan (web): deposits — вклады, ручной ввод

## Approach
Вкладка `/deposits` + новый disjoint-root `['deposits', ...]`. Деньги двигает
СУЩЕСТВУЮЩИЙ `TransferFormModal` с зафиксированной deposit-стороной — новой формы
движения денег нет; клиент не считает денег, единственная арифметика на клиенте —
сравнение ДАТ в блоке сроков. Стыковка: deposit-счетов нет в `GET /accounts` →
`counter_account_id` перевода не резолвится; решение — merged-индекс
accounts+deposits (AMENDMENT п.2), один pure-модуль на 4 потребителя. До
`pnpm openapi` типы — локальный `deposits.types.ts` с `TODO(B1)`.

## Screens / components affected
- `App.tsx` — роут `/deposits`; `ProtectedLayout.tsx` — NavLink к `/accounts`.
- `features/transfers/TransferFormModal.tsx` — новый проп
  `prefill?: { side:'source'|'target'; accountId: string }`: сторона read-only
  (паттерн immutable-валюты AccountFormModal), но зарегистрировано в RHF;
  `currencyOf`/`byId` — из MERGED-списка (иначе schema не знает экспоненту);
  `usable < 2` → `< 1` при фиксированной стороне. В edit — без префилла.
- `routes/TransactionsPage.tsx` — merged-индекс вместо `accountIndex(accounts)` для
  `transferDisplay` и чипа фильтра. `transferDisplay.ts` не меняется.
- `GoalDeadlines.tsx` — принимает строки вкладов, заголовок обобщается
  (`deadlines.title`); goal-арм не трогаем.

## New components / hooks
- `data/deposits.ts` — `useDeposits/useCreateDeposit/useUpdateDeposit`.
- `routes/DepositsPage.tsx`; `features/deposits/DepositList.tsx` + `DepositRow.tsx`:
  тело, проценты, «на руки» при `accrued_after_tax_minor != null`, ставка,
  капитализация, даты; бейджи «срок истёк» (`status==='matured'`) и «поправлено
  вручную»; архивные приглушены; кнопки Пополнить/Снять/Изменить/История.

- `features/deposits/DepositFormModal.tsx`, `AccruedEditModal.tsx`;
  `depositFormSchema.ts` — web-local (прецеденты tokenFormSchema/incomeFormSchema:
  второго потребителя нет, мобилка заморожена).
- Pure, node-tested: `depositAccounts.ts` (`depositAccountEntries`,
  `mergedAccountIndex`), `depositStatus.ts` (арм строки → КЛЮЧИ, не предложения),
  `depositDeadlines.ts` (`term_end` в горизонте → row-shape + слияние с goal-строками).
- `packages/api-client/src/patch.ts` — `buildDepositPatch` (generated/ не трогаем).

## Data layer
- Ключи: `depositsList: ['deposits','list']`, `depositDetail: ['deposits', id]`
  (деталь в MVP не читаем, ключ объявляем сразу). `GET /deposits`
  archived-inclusive, ОДНА запись, staleTime 60s, фильтр на клиенте.
- Из deposits: create/PATCH → `setQueryData` + invalidate `['deposits']`; чужого не
  трогаем (скрытый счёт в `GET /accounts` не приходит, в агрегаты не входит).
- В deposits: новый `invalidateDeposits` (bare `['deposits']`) во ВСЕХ трёх
  tx-мутациях рядом с `invalidateAccounts` — тело computed из переводов; условная
  инвалидация невозможна (edit может УВЕСТИ перевод со вклада). Optimistic — нет.

## UI states
- `/deposits`: loading — 3 скелетона фикс. высоты; error/unreachable —
  `QueryStateNotice` + retry; empty — «Вкладов пока нет. Добавьте вклад, чтобы видеть
  тело и проценты отдельно от счетов» + кнопка.
- Форма: pending (Save disabled), коды через `lib/errors.ts`
  (`DEPOSIT_TERM_BEFORE_OPENING` → `term_end`, `DEPOSIT_ARCHIVED` → form-level),
  dirty-guard общего `Modal`. Архив — `ConfirmDialog` с порядком закрытия (перевод
  обратно → архив, AMENDMENT п.3); архив с ненулевым телом разрешён.
- Нет живых обычных счетов — форма перевода говорит это, а не собирает суммы.
  Блок сроков скрыт при `narrowed`, скелетоны фикс. высоты.

## Форма вклада
- Create: name, currency (`currencyOptions()`, дефолт — база из summary),
  rate_percent (строка Decimal, НЕ Number), capitalization, opened_on (дефолт
  `todayApiDate()`, прошлое — нормальный кейс, верхней границы НЕТ), term_end (пусто
  = бессрочный), tax_rate_percent, `initial_balance_minor` (`parseMoney`, ge 0) +
  подсказка «вклад открыт до начала учёта — укажите тело на дату открытия».
- Edit: currency read-only, `initial_balance` не показываем вовсе (второй источник
  правды); PATCH — диффы `buildDepositPatch` + `emptyToNull` на nullable-полях.

## «Рассчитать на сегодня» / override
- `AccruedEditModal`: серверный `accrued_minor` (+ after-tax) на сегодня, поле
  предзаполнено `toInputString(accrued_minor, currency)`. Save → `PATCH
  { accrued_override_minor: parseMoney(...).minor }`, «Сбросить к расчёту» → `PATCH
  { accrued_override_minor: null }` под ConfirmDialog. Бейдж + `accrued_override_as_of`
  на строке; копия: прогноз ПРОДОЛЖАЕТ идти от правки.

## i18n
- `deposits.*`, `depositForm.*`, `depositAccrued.*`, `nav.deposits`, обобщённый
  `deadlines.title` — в `dict.en.ts` (набор ключей) и `dict.ru.ts`; коды ошибок →
  `ERROR_MESSAGES` (@budget/shared). Имена вкладов не переводим,
  `formatMoney/formatApiDate` — с `{ locale }`, имя вклада в строке перевода — из
  merged-индекса.

## Подзадачи и оценки (агент-минуты)
- **W1 — одна подзадача**: merged-индекс — общий корень пп. 1/4/6/7, вторая = второй
  проход по `TransferFormModal`/`TransactionsPage`. Линия реза, если wall-clock
  заставит: блок сроков + «История» (чужой шипнутый виджет).
- Написание **~110** (список 25, форма 25, transfer-prefill+merged 25, accrued 15,
  сроки 10, i18n+тесты 10) / гейты **~15** / верификация (`/review-pr` + прогон
  против живого API) **~30**.

## Open questions
1. Deposit-счета в `AccountFilter`? Предлагаю ДА: фильтр — не денежный пикер, иначе
   истории вклада достаётся лейбл «недоступен».
2. Обобщение заголовка шипнутого виджета goal-planner (`deadlines.title`) — ок?
3. Есть ли `accrued_override_as_of` в `DepositRead` (в брифе — «override-поля»)?

## Risks
- Blanket `['deposits']` на каждой tx-мутации — лишний GET на любой расход; список
  крошечный, альтернатива молча протухает. Осознанный размен.
- `TransferFormModal` — самая нагруженная форма; `prefill` не должен задеть edit.
- Типы-дубль до `pnpm openapi`: расхождение имён полей всплывёт только после B1 —
  замена типа = ПЕРВЫЙ шаг. Статус вклада берём ТОЛЬКО из серверного поля.
