# Implementation Plan (web): accounts-and-transfers (W1, W2)

## Approach
Счёт — второй справочник рядом с категориями: один archived-inclusive запрос
`['accounts','list']`, клиентская фильтрация архива в селекторах, in-place
`setQueryData` из ответа мутации (паттерн `data/categories.ts`). `balance_minor`
приходит с сервера и НИКОГДА не считается на клиенте.

Перевод — отдельная `TransferFormModal`, а не третья ветка в
`TransactionFormModal` (665 строк, converted-секция, чек, merchant — у перевода
ничего этого нет). Побочный выигрыш: селектор kind остаётся expense/income, и 422
`KIND_CHANGE_UNSUPPORTED` в вебе непредставим. A1 соблюдён: одна строка списка →
одна форма (оба счёта, обе суммы, дата) → одно удаление. `transfer_rate` — ТОЛЬКО
post-factum строкой с сервера: превью курса = деление двух минорных сумм на
клиенте, т.е. запрещённая денежная арифметика.

## W1 — счета, перевод, счёт в форме транзакции (STANDARD)
- `data/queryKeys.ts` — `qk.accounts()` = `['accounts','list']`: НОВЫЙ дизъюнктный
  корень, сегмент `'list'` как у recurring/tokens (задел под `['accounts', id, …]`).
- `data/accounts.ts` (новый) — `useAccounts` (archived-inclusive, staleTime 60s),
  `useCreateAccount`, `useUpdateAccount`; мутации пишут кэш in-place по id из
  возвращённого `AccountRead` (в нём свежий `balance_minor`), не инвалидируют ничего.
- `App.tsx` + `routes/ProtectedLayout.tsx` — роут и навлинк `/accounts`.
- `routes/AccountsPage.tsx` + `features/accounts/` — `AccountList`/`AccountRow`
  (имя, тип, валюта, `formatMoney(balance_minor, currency)`, тег Archived),
  `AccountFormModal` (create/edit + архив `ConfirmDialog`, паттерн `CategoryFormModal`;
  валюта на edit read-only, §4), `AccountSelect` (общий контрол четырёх форм),
  `lastAccount.ts` (`pickDefaultAccount`, чистая).
- `features/transfers/TransferFormModal.tsx` (новый) — два `AccountSelect`, две суммы,
  дата, note; на edit read-only `transfer_rate` и удаление целиком (`ConfirmDialog`);
  шлёт `POST /transactions` c `kind='transfer'`.
- `features/transactions/TransactionFormModal.tsx` — обязательный `AccountSelect`;
  `CurrencySelect` → read-only производная от счёта, `currency` на wire не шлём;
  смена счёта инвалидирует выставленное converted-значение как смена валюты
  (`convertedSection.ts`).
- `routes/TransactionsPage.tsx` — кнопка «Add transfer»; `onEdit` шлёт
  `kind==='transfer'` в `TransferFormModal`.
- `packages/shared` — `accountFormSchema`; `transferFormSchema(currencyOf)`:
  фабрика с lookup «id счёта → валюта», потому что экспоненты обеих сумм зависят
  от выбранных счетов (прецедент object-level `multiCurrencyTransactionFormSchema`).
- `packages/api-client` (рукописные билдеры, НЕ generated) — `buildAccountPatch`;
  `buildTransactionPatch` += `account_id`. Аддитивно, мобилку не ломает.
- `lib/errors.ts` — `describeAccountError` (`ACCOUNT_NOT_FOUND`/`_ARCHIVED`/
  `_CURRENCY_MISMATCH`/`_CURRENCY_IMMUTABLE`, `SAME_ACCOUNT_TRANSFER`); те же коды
  доводятся в `describeTransactionError`.

## W2 — правки существующего (STANDARD)
- `data/queryKeys.ts` — `TxListFilters` += `account_id?` (член ключа ⇒ своя
  запись кэша; сервер матчит ОБЕ ноги перевода).
- `features/transactions/TransactionList.tsx`/`TransactionRow.tsx` — диспетчер на
  `TransferRow`; `transferDisplay.ts` (чистая) собирает «A → B» и пару сумм.
- `packages/shared` — `signedLegFor(tx, accountId)`: правило A3 (выбор ноги и знака,
  не арифметика денег), общий с мобилкой.
- `routes/TransactionsPage.tsx` — фильтр по счёту в URL (`?account=`), проброс в
  `filters` и `ExportFilters` (OQ-W3); заголовок фильтра называет счёт.
- `features/transactions/confirmDefaults.ts` — валюта чека больше не «выбор»,
  а сверка с валютой счёта (OQ-W2); селектор счёта форма получает от W1 даром.
- `features/recurring/TemplateFormModal.tsx` — обязательный `AccountSelect`;
  `buildRecurringTemplatePatch` += `account_id`. Переводов в шаблонах нет (§7).
- Ячейка категории у перевода: иконка «⇄» и «Карта USD → Карта BYN» ВМЕСТО
  категории, никогда «Uncategorized» (это про расход без категории).

## Инвалидация (критично)
- `data/transactions.ts` — хелпер `invalidateAccounts(qc)` =
  `invalidateQueries({queryKey:['accounts']})` в `onSuccess` ВСЕХ трёх tx-мутаций
  рядом с `invalidateStats`/`invalidateLimits` И в их 404-ветках `onError` (иначе
  удалённая в другой вкладке строка остаётся в остатке). Blanket, не точечно: PATCH
  переносит операцию между счетами, перевод двигает ДВА баланса, а вычислять «какие
  счета затронуты» — повтор серверной формулы §2.
- Мутации счетов НЕ инвалидируют `['transactions']`: архив не удаляет строки (как у
  категорий), имена джойнятся из кэша счетов реактивно. `['stats']`/`['limits']`
  тоже не трогаем — `starting_balance_minor` не входит ни в один агрегат.

## Дефолт счёта в формах
`localStorage['budget.lastAccountId']`, пишется после успешного create (у перевода —
source): клиентское предпочтение, не серверное состояние ⇒ ни Query, ни Zustand.
Читается при монтировании через чистую `pickDefaultAccount(accounts, storedId)`:
сохранённый id, если он в списке и не архивен → иначе единственный неархивный →
иначе пусто. Кэш транзакций не сканируем: «последний использованный» ≠ «последний
по дате».

## UI states
- `/accounts`: loading — 3 скелетона; error/unreachable — `QueryStateNotice` + retry
  (4 арма `queryPhase`); empty — «Add your first account — every transaction is
  recorded on one» с кнопкой; success — архивные внизу, приглушены. Архив —
  `ConfirmDialog`: «остаётся на прошлых операциях, но не предлагается в новых».
- Формы транзакции/перевода/шаблона при пустом списке счетов: вместо селектора блок
  «Сначала создайте счёт» со ссылкой на `/accounts`, submit недоступен.
- Селектор: неархивные + текущий архивный с «(archived)» на edit (прецедент
  категорий — иначе PATCH-диф вынуждает менять счёт).
- Перевод в списке: две строки сумм «−100.00 USD» / «+330.00 BYN», под ними серым
  `transfer_rate`. `baseEquivalent` сам вернёт null (base-пара NULL, §5) — правок
  в `rowDisplay.ts` не нужно.
- Список конкретного счёта: знак и нога ТОЛЬКО через `signedLegFor`; empty —
  «No operations on this account in <месяц>».

## Тесты (чистая логика, node-vitest)
4 модуля, ~16 кейсов: `signedLegFor` (расход/доход/source/target/чужой счёт),
`transferFormSchema` через zodResolver (одинаковые счета, exponent-0 counter, пустой
второй счёт, роутинг object-level issue в поле), `pickDefaultAccount` (валидный/
архивный/исчезнувший/пусто), `transferDisplay`.

## Оценки (агент-минуты: написание / гейты / верификация)
- W1: 20 / 8 / 20   - W2: 15 / 7 / 15

## Open questions
- **OQ-W1 (блокирует честный рендер).** `TransactionRead` по §9 не несёт
  `counter_currency`, а вторая нога должна форматироваться СВОЕЙ валютой. Джойн из
  кэша счетов работает (имена нужны всё равно), но пока `['accounts']` не приехал,
  рисовать «+330.00 BYN» нечем, а `?? tx.currency` — нарушение AM-5. Просьба к
  backend-engineer: `counter_currency` (nullable, производное) в `TransactionRead`.
- **OQ-W2 (чек).** `buildConfirmDefaults` ставит валюту из чека, §4 форсирует валюту
  счёта. Предлагаю: дефолт — счёт с совпавшей валютой; нет такого — явное
  предупреждение «в чеке EUR, счёт в BYN» и ручной выбор.
- **OQ-W3 (экспорт).** `ExportFilters = Omit<TxListFilters,'limit'>` ⇒ `account_id`
  уедет в `GET /transactions/export`. Если экспорт не делит `_read_filters` со
  списком — нужен серверный приём параметра, иначе «экспортировал не то, что видел».

## Risks
- `['accounts']`-инвалидация — единственная точка, где остатки застревают тихо (числа
  выглядят правдоподобно). QA: create/edit/delete операции и перевода — каждый раз
  сверять остатки БЕЗ перезагрузки. Смена счёта у операции перештамповывает валюту
  и base-снапшот (§4).
- Забытый `account_id` в `ExportFilters`/предикате ⇒ «фильтр применился, список прежний».
- Разрастание `TransactionFormModal`: ветку счёта и empty-state держать в `AccountSelect`.
