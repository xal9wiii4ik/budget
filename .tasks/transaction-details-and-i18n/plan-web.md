# Implementation Plan (web): transaction-details-and-i18n (S1-UI, S2, S3-UI, S4, S5, S7)

Планируется против контракт-скетча из task.md. Места, где финальный контракт
архитектора может сдвинуть план, помечены **[CONTRACT]**.

## Общие правила для всех подзадач
- Чистая логика — в node-модули рядом с фичей (`features/*/x.ts` + `x.test.ts`),
  DOM не тестируем (web.md §Forms).
- Новые поля формы → схема в `packages/shared/src/schemas.ts`, patch-семантика →
  `packages/api-client/src/patch.ts` (omit/null/value, `undefined` на провод не уходит).
- Инвалидации tx уже покрыты хелперами `data/transactions.ts` — новые поля НЕ требуют
  новых ключей и новых инвалидаций (кроме профиля, см. S5).

---
## S1-UI — пара original_amount_minor/original_currency + поля профиля
**Файлы:** `features/transactions/TransactionFormModal.tsx` (новая секция «More options»),
новый `features/transactions/originalPair.ts` (+тест), `features/transactions/rowDisplay.ts`
(+тест), `packages/shared/src/schemas.ts` (`multiCurrencyTransactionFormSchema`),
`packages/shared/src/countries.ts` (новый: список ISO-3166 alpha-2 + country→currency),
`packages/api-client/src/patch.ts`, `lib/errors.ts` (новые коды 422).
- Лейблы: главное поле → «Списано со счёта, {accountCurrency}», новое → «Потрачено,
  {originalCurrency}». Валюта названа в любом исходе (требование task.md).
- Поле original — сумма + селект валюты (`SUPPORTED_CURRENCIES` + свободный код?
  **[CONTRACT]**). Парсинг суммы — с экспонентой ORIGINAL-валюты, не счёта (AM-5).
- Пара «целиком или никак» валидируется в zod (superRefine), зеркало серверного CHECK.
  Равенство original_currency == валюта счёта → **[CONTRACT]** (422 или тихо трактовать
  как «нет пары»); план: показываем inline-ошибку поля, не блокируем сабмит формы.
- Кто считает списание: если сервер разрешает `amount_minor` опустить при заданном
  original — показываем оценку через существующий `useFxPreview` как hint (текст, не
  значение поля), клиент НИКОГДА не умножает на курс (D8). Если `amount_minor`
  обязателен — автозаполняем поле списания превью один раз, как base_amount, с явным
  флагом «правил руками» (паттерн `baseAmountEdited`). **[CONTRACT]** — это развилка,
  которая меняет ~15 строк формы, не архитектуру.
- Patch-семантика (в `buildTransactionPatch`): пара — nullable-VALUE **атомарно**:
  unchanged → omit обоих; очищена → оба ключа `null`; изменена → оба ключа значением.
  Один член пары в одиночку не эмитится никогда (+ тест на это в patch.test.ts).
- kind=transfer: полей нет — `TransferFormModal` не трогаем.
- Строка списка (`rowDisplay.ts`): новая чистая `primaryAmount(tx, summaryCurrency)` →
  discriminated union {original|charge} + опциональная вторичная строка. Правило: **не
  более двух денежных строк** — при наличии original показываем original (главный) +
  списание (вторично), `≈ base` подавляем (иначе три суммы в строке и лишний шум).
  Риск: визуальная сумма колонки перестаёт совпадать с итогами месяца → вторичная
  строка обязана быть видимой, не hover-only.
- Профиль: `country`, `language` — **БЛОКЕР, см. Вопросы (нет profile-эндпоинта)**.
  country → дефолтная валюта поля «потрачено» через `countryToCurrency` в shared.
Оценка (мин): **написание 20 / гейты 8 / верификация 10**.

## S2 — страна операции
**Файлы:** `TransactionFormModal.tsx` (в тот же «More options»), `packages/shared/src/countries.ts`.
- Селект стран: коды — статический список ISO-3166 alpha-2; **подписи — `Intl.DisplayNames('region')`**
  под текущий язык. Ноль данных в бандле, бесплатная локализация (стыкуется с S5).
- Дефолт из `profile.country` только в create-режиме и только если профиль загружен;
  «не указана» = `""` → `null` (сентинел `emptyToNull`).
- Patch: nullable-clearable string (omit/null/value) — `clearableChange`, как note.
Оценка: **10 / 5 / 5**.

## S3-UI — фото в форме операции
**Файлы:** новый `features/transactions/AttachPhotoField.tsx`, новый `data/receipts.ts::useReceipt(id)`
(ключ `['receipts', id]`, уже существует как семейство), `TransactionFormModal.tsx`,
`features/receipts/useReceiptFlow.ts` — **переиспользуем без изменений**: терминал
`saved` (upload без parse) уже есть, AI-гейта на presign нет (F3).
- Create: прикрепление уже работает (`body.receipt_id`) — нужен только UI-вход в форме
  (кнопка «Прикрепить фото» → ReceiptDropzone → состояние `saved` → id в body).
- Edit: миниатюра/ссылка по `transaction.receipt_id` (поле есть в TransactionRead) через
  presigned GET; attach/detach через PATCH — **[CONTRACT]** (сегодня `receipt_id` в
  TransactionUpdate отсутствует; detach-в-null решает архитектор). Patch-семантика:
  nullable-clearable (omit/null/value), тот же `clearableChange`.
- Инвалидации: успех мутации tx уже инвалидирует списки; `['receipts', id]` не трогаем
  (объект неизменяемый). Кэш чека, как и сейчас, чистится при закрытии модалки.
- UI-состояния: пусто (нет фото) / загрузка (прогресс из useReceiptFlow) / ошибка
  (сообщения уже в useReceiptFlow) / прикреплено (миниатюра + «Открыть» + «Открепить»
  с подтверждением, т.к. это потеря связи).
Оценка: **18 / 6 / 8** (+нужен merged-контракт до старта).

## S4 — merchant как «название» операции
**Файлы:** `TransactionFormModal.tsx` (поле merchant выносим из confirm-only ветки),
`features/transactions/rowDisplay.ts` (+тест), `packages/api-client/src/patch.ts`,
`TransactionRow.tsx`.
- Лейбл «Name / place (optional)», maxLength 255, `""` → null.
- Patch: сегодня `buildTransactionPatch` merchant НЕ эмитит (комментарий в форме);
  добавляем как nullable-clearable + тест. Контракт менять не надо (поле в
  TransactionUpdate есть). Автокатегоризация учится только на CREATE (F4) — в UI не
  обещаем обучение при редактировании.
- Строка: новая чистая `rowTitle(tx, category)` → merchant, иначе имя категории, иначе
  «Uncategorized»; note остаётся вторичным. Для transfer-ветки не применяется.
Оценка: **10 / 5 / 5**.

## S5 — i18n веба + системные категории
**Решение: свой минимальный словарный слой, БЕЗ react-i18next.** Обоснование:
~10 экранов, 2 локали, статические словари, лениво грузить нечего (обе локали ~30-40 КБ
суммарно, меньше самого i18next+react-i18next ≈ 20-25 КБ gz). Главный выигрыш —
**типобезопасность**: `type Key = keyof typeof en` даёт ошибку `pnpm typecheck` на
опечатке и на непереведённом ключе в ru; в react-i18next это отдельная обвязка типов.
Плюрализация решается `Intl.PluralRules` (ru: one/few/many) в 20 строках, интерполяция —
`{name}`-подстановка. Ре-оценить react-i18next стоит, если появятся 3-й язык, rich-text
внутри переводов или переводы, загружаемые с сервера.
**Файлы:** новый `apps/web/src/i18n/` — `dict.en.ts`, `dict.ru.ts`, `t.ts` (чистый:
lookup + интерполяция + плюрали, +тест), `I18nProvider.tsx` (context, без Zustand),
`useT()`; `packages/shared/src/systemCategories.ts` (UUID→ключ, 19 замороженных UUID из
0003, F5) + `packages/shared/src/i18n/categories.{ru,en}.ts` — там же, потому что мобилка
это переиспользует (**решение о размещении shared-словарей — за архитектором**).
- Категории: перевод по UUID; user-категории и неизвестные UUID → `name` из API как
  fallback (никаких «Unknown»). Затрагивает: пикер в tx-форме, `CategoriesPage`, лимиты,
  строки списка, статистику, advisor-вывод (там имена приходят с сервера в тексте —
  НЕ переводим, честно оставляем как есть).
- Ошибки: `lib/errors.ts` (~117 сообщений) переводим на ключи; коды остаются кодами (F6).
- Язык: сервер (`profile.language`, из S1) — истина; локальный кеш `budget.lang` в
  localStorage (рядом с `budget.auth`) читается синхронно на бутстрапе, до логина и
  оффлайн; фолбэк — `navigator.language` → ru/en. При первом входе с `language = null`
  показываем неблокирующую плашку-подтверждение (S1). Переключатель — `SettingsPage`.
  Смена языка: PATCH профиля → `invalidateQueries(['profile'])`; больше НИЧЕГО не
  инвалидируем (сервер данные не локализует).
- **Самая дорогая часть — честно:** прогон ВСЕХ существующих строк. Объём: 59 tsx +
  ~15 ts с текстами, ~15.5k строк кода, оценочно **450-600 пользовательских строк**
  (только `lib/errors.ts` — ~117). Это не 20 минут. Предлагаю резать на партии по
  зонам, каждая — самостоятельный сдаваемый кусок:
  S5a инфраструктура+категории+errors.ts (**20 / 8 / 10**);
  S5b transactions+transfers+accounts (**20 / 6 / 8**);
  S5c categories+limits+recurring (**18 / 6 / 8**);
  S5d goals+stats+advisor (**20 / 6 / 8**);
  S5e auth+settings+tokens+shell+NotFound+переключатель языка (**18 / 6 / 8**).
  **Итого S5: написание ~96, гейты ~32, верификация ~42.**
  Риск партийности: пока идёт S5, любой другой подскоуп добавляет НОВЫЕ строки —
  S1..S4 и S7 должны сразу писать текст через словарь, если S5a уже влит; иначе
  сознательно оставляем хвост и добираем его в S5e.

## S7 — priority у целей
**Решение: селект Высокий/Средний/Низкий (1/2/3) + «Не задан» («» → null).** Дешевле и
понятнее, чем подпись+hint: hint там УЖЕ есть (GoalFormModal.tsx:238) и именно он не
сработал (F7). Число «меньше = важнее» контринтуитивно, а селект убирает вопрос целиком.
Контракт и схема НЕ меняются: `goalFormSchema` уже парсит строку в int, patch-builder
не трогаем. Существующее произвольное число (7) сохраняется как дополнительная опция
«Другой (7)» — правка не теряет значение и не навязывает переезд на 1/2/3.
**Файлы:** `features/goals/priority.ts` (новый, чистый: `priorityOptions(current)`,
`priorityLabel(n)` + тест), `GoalFormModal.tsx`, `GoalCard.tsx` («Приоритет: высокий»).
Оценка: **8 / 4 / 4**.

---
## Вопросы (контракт-скетч не покрывает)
1. **Profile-эндпоинта нет вообще.** В контракте только `GET/PATCH /users/me` с
   `{email, id, is_active}`; `base_currency` веб сегодня добывает из `/transactions/summary`.
   Для `country`/`language` (S1, S2-дефолт, S5) нужен читаемый И записываемый профиль:
   новый `GET/PATCH /profile` или расширение `/users/me`. Без него S5 не может хранить
   язык на сервере, а S2 не имеет дефолта. → backend-engineer + перегенерация клиента.
2. Обязателен ли `amount_minor` при заданном original (сервер считает сам?) — см. S1.
3. Разрешено ли `original_currency == currency` счёта (422 или no-op)?
4. `receipt_id` в PATCH: только attach (null→value) или ещё и detach (value→null)?
5. Набор валют для поля «потрачено»: `SUPPORTED_CURRENCIES` (4 шт.) или любой код?
   Сценарий из task.md (EUR при BYN-счёте) покрыт, но JPY-чек — нет.
6. Где живут shared-словари категорий (`packages/shared` vs новый пакет) — за архитектором.

## Правки senior-lead (2026-08-22) — обязательны
- **S4 PATCH merchant: общий `buildTransactionPatch` НЕ трогаем.** Пиновый тест
  (patch.test.ts:161) — предохранитель замороженного мобильного edit. Веб шлёт
  merchant ЯВНЫМ ключом в submit-коде формы (диф против baseline: unchanged→omit,
  ""→null), как create уже делает с `body.merchant`. Жёсткой связки с мобилкой нет.
- Имя производного курса в контракте — **`original_rate`** (не display_rate).
- Фолбэк на 422 `FX_RATE_UNAVAILABLE` («введите сумму списания») — обязателен с
  первого дня: хранятся только 6 канонических пар, для экзотики это норма.
- Полупара/нет суммы — коды `ORIGINAL_FIELDS_REQUIRED` / `AMOUNT_REQUIRED`.
- `profiles.language` NULL = «не выбирал» → язык из локали браузера (PM-1); первый
  явный выбор пишет в профиль.
- Q5 (валюты original): format-only как D7 — чипы предлагают известный набор
  (валюты счетов + валюта страны профиля первой), ввод любого валидного кода допустим.
- Q6 (словари): packages/shared — UUID→ключ категорий, страна→валюта, коды ошибок
  (второй потребитель — мобилка); экранные строки веба — в apps/web.
