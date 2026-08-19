# Implementation Plan (mobile): accounts-and-transfers (MOB)

## Approach
MOB — полноценная последняя подзадача (A4), независимая от W1/W2, зависит от B1+B2
(контракт + фильтр `account_id`). Презентация своя, data-layer зеркалит веб 1:1, как
уже сделано для categories/transactions. Перевод — ОДНА операция (A1): один элемент
списка, одна форма, удаление целиком. Никакой клиентской арифметики: `balance_minor`
и `transfer_rate` только показываем (A2).
Третий таб «Accounts»: экрана настроек в мобилке нет вообще, изобретать хаб ради одного
экрана дороже, чем добавить таб (3 — нормальный объём bottom-tabs, зеркалит веб-нав).
ЗАВИСИМОСТЬ (не мокаю): `accountFormSchema`, `transferFormSchema` и хелпер знака A3 из
`packages/shared` создаёт web-инженер в W1; стартую после их мерджа, копий не пишу.

## Screens / navigation
- `app/(app)/(tabs)/_layout.tsx` — + `<Tabs.Screen name="accounts">` третьим.
- `app/(app)/(tabs)/accounts.tsx` — НОВЫЙ: список счетов (паттерн `categories.tsx`),
  `balance_minor` с сервера, архивные — отдельной секцией внизу; «＋» → форма.
- `app/(app)/account-form.tsx` — НОВЫЙ: create/edit/архив (паттерн `category-form.tsx`).
- `app/(app)/transfer-form.tsx` — НОВЫЙ: create/edit/delete перевода (отдельный роут,
  а не ветка в transaction-form: нет категории/kind, две суммы, два счёта).
- `app/(app)/account/[id].tsx` — НОВЫЙ: история счёта (`account_id`-фильтр из B2),
  MonthPicker + TransactionList, знак/нога по A3; deep-link-safe (id из params, месяц —
  локальный стейт). Кандидат на отрез v1 (~30 мин + ~6 QA-кейсов); рекомендую оставить —
  A3 существует ровно ради него.
- `app/(app)/transaction-form.tsx` — правка (см. ниже).

## New components / hooks
- `src/data/accounts.ts` — `useAccounts` (archived-inclusive, staleTime 60s),
  `useCreateAccount`, `useUpdateAccount` (архив = PATCH `{archived}`, DELETE нет); кэш —
  `setQueryData` по id из ответа (паттерн `categories.ts`).
- `src/data/accountLookup.ts` — чистые хелперы: `buildAccountIndex`,
  `sortForDisplay` (не-архивные первыми, locale-aware), `pickDefaultAccount`.
- `src/components/AccountPicker.tsx` — чипы (паттерн Category-чипов), touch ≥44pt, архивные
  скрыты кроме текущего значения при edit.
- `src/features/accounts/AccountList.tsx` + `AccountRow.tsx` (memo, FlatList, keyExtractor
  по id) — имя, тип, валюта, `formatMoney(balance_minor, currency)`.
- `src/features/transactions/TransferRow.tsx` — `kind==='transfer'` в общем списке:
  «Карта USD → Карта BYN», обе суммы, без категории; `TransactionRow` роутит по kind
  (ОДНА строка, не две).

## Data layer
- Query-ключи (`src/data/queryKeys.ts`, зеркало веба): `accounts: () => ['accounts',
  { includeArchived: true }]`; `TxListFilters` += `account_id?: string`.
- Эндпоинты: `GET/POST /accounts`, `PATCH /accounts/{account_id}`, `POST/PATCH/DELETE
  /transactions` (перевод — тот же маршрут, §9).
- Инвалидация: ВСЕ мутации транзакций (включая перевод) дополнительно инвалидируют
  `['accounts']` — остатки серверные и протухают от любой записи. Мутация счёта правит
  `['accounts']` через `setQueryData`; списки транзакций трогать не нужно.
- Дефолт счёта в форме: `pickDefaultAccount(accounts, cachedTransactions)` — свежайший
  `account_id` из закэшированного месячного списка, иначе единственный не-архивный, иначе
  пусто (поле обязательное). Персистентного стореджа НЕ добавляю: AsyncStorage в мобилке
  нет, secure-store — только под токены (docs/mobile.md).
- Offline: Query-кэш отдаёт остатки/список как есть; sync не делаем (вне скоупа).

## Platform concerns
- Новых нативных модулей НЕТ (дата-пикер и safe-area уже стоят) → Expo Go живёт.
- Формы — `KeyboardAwareForm` + `SafeAreaView edges={['bottom']}`; в transfer-form два
  `decimal-pad`-поля, ОБА через `normalizeAmountInput` (F-1) перед shared-схемой.
- Android back / iOS swipe-back на модальных формах = `router.back()` без сохранения;
  destructive (delete перевода, архив счёта) — через `confirmAction`.

## UI states
- Accounts tab: скелетоны / «Couldn't load your accounts»+Retry / «No accounts yet»+Add / список с остатками.
- Account form: валюта выбирается ТОЛЬКО при создании (§4 иммутабельна), при edit —
  read-only с подписью «archive and create a new account»; ошибки — `describeAccountError`.
- Transfer form: счета грузятся → submit disabled; edit показывает `transfer_rate`
  строкой post-factum (null → ничего); `SAME_ACCOUNT_TRANSFER`/`ACCOUNT_ARCHIVED`/
  `ACCOUNT_CURRENCY_MISMATCH` — на конкретное поле, сетевой сбой — сообщение + повторный тап.
- Transaction form: счёт обязателен; валюта формы = валюта ВЫБРАННОГО счёта (заменяет
  текущий вывод из summary), смена счёта переоценивает схему.
- Account history: pending / empty «No operations this month» / error+Retry / success.

## Открытые вопросы
- OQ-M1. Персистентный «последний счёт» между запусками требует новой зависимости
  `@react-native-async-storage/async-storage` (одобрение senior-lead). По умолчанию — без неё.
- OQ-M2. История счёта (`app/(app)/account/[id].tsx`) — оставляем или режем в v1?
  Рекомендую оставить; при отрезе A3-хелпер в мобилке не используется.

## Тесты (vitest, node; RN-импортов в графе быть не может)
- `src/data/accountLookup.test.ts` — НОВЫЙ: `pickDefaultAccount` (из кэша / единственный
  не-архивный / архивный не выбирается / пусто) + сортировка архивных — 5 кейсов.
- `src/data/errors.test.ts` — расширение: роутинг `ACCOUNT_NOT_FOUND`, `ACCOUNT_ARCHIVED`,
  `ACCOUNT_CURRENCY_MISMATCH`, `SAME_ACCOUNT_TRANSFER` — 4 кейса.
Итого 9 кейсов в 2 файлах. Логика знака/ноги (A3) тестируется в `packages/shared` веб-инженером — не дублирую.

## Оценки (агент-минуты)
| Этап | Мин |
|---|---|
| Написание: data-layer + queryKeys 20; accounts-таб и список 35; account-form 35; селектор счёта и перевалюта в transaction-form 30; transfer-form 45; TransferRow 20; account/[id] 25; errors+тесты 25 | **235** |
| Гейты: `pnpm lint` + `tsc --noEmit` + `vitest run` в apps/mobile, с циклом правок | **30** |
| Верификация — СИМУЛЯТОРНЫЙ QA (idb + Expo Go): полный прогон чеклиста mobile-qa ~35 кейсов **210** + круг фикса functional-дефектов (ожидаю 2–4: две суммы/клавиатура, дефолт счёта, edit перевода, архивный счёт в пикере) **100** + ре-прогон затронутых кейсов **50** | **360** |
| **Итого MOB** | **625** |

## Риски
- Симуляторный QA исторически дороже написания (1.8: 35 кейсов, два круга фиксов) —
  360 честная цифра, а не запас; при отрезе OQ-M2 минус ~40.
- Конфликт с заморозкой: третий таб меняет shell — проверяем, что deep-link `next`
  (TC-8) и guard не сломались; это отдельные QA-кейсы.
- Валюта формы транзакции меняет источник истины (счёт вместо summary) — регресс-риск
  для существующего экрана, а не только новый код.
- Зависимость от shared-схем и A3-хелпера из W1: если их сигнатуры разъедутся —
  останавливаюсь и иду к senior-lead, свои копии не пишу.
