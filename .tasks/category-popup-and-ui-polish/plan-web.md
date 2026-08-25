# plan-web — category-popup-and-ui-polish (части 1 и 2; часть 3 вне скоупа)

## Часть 1 — «+ Бюджет» в строку

- `CategoryRow.tsx`: состояние формы бюджета (`editing`) и `LimitFormModal`
  ПОДНИМАЮТСЯ на уровень строки — иначе одна кнопка (в `rowLine`) и бар (во
  второй строке) не смогут делить одну модалку.
- Правая группа `rowLine`: компактная пилюля «+ Бюджет» (`limitInlineButton`,
  текст короче: `limits.setBudgetShort`) → drill-кнопка. Гейты неизменны:
  `kind==='expense' && !archived && state.kind==='ready' && item===undefined`.
  aria-label остаётся `limits.setBudgetFor` (с именем категории).
- Вторая строка (`limitSlot`) рендерится ТОЛЬКО когда бюджет задан: бар +
  Edit/Remove как сейчас. Незаданный бюджет = одна строка по высоте.
- `limitPlaceholder` → `limitReserve`: резервируем не вторую строку, а саму
  пилюлю (невидимая копия с тем же текстом = точная ширина в любой локали).
  Строка, у которой окажется бар, вырастет на его высоту — осознанно: бюджет
  есть у меньшинства категорий, резерв строки для всех = постоянная пустота.
- 375px: `.name` уже с `min-width:0`+ellipsis; пилюля `flex-shrink:0`.

## Часть 2 — модалка операций категории

- Новое: `features/categories/CategoryTransactionsModal.tsx` (+`.module.css`),
  чистый модуль `categoryDrilldown.ts` (+`.test.ts`).
- Drill теперь `<button>`, открывает модалку; `<Link>` на /transactions убран
  ТОЛЬКО из строки — логика страницы /transactions не тронута.
- Период: локальный `useState<CategoryPeriod>` (= `TxRangeMode` без `all`),
  дефолт — текущий месяц. `TxRangePicker` получает опциональный
  `allowAllTime` (default true); модалка передаёт `false`.
- Итог: `useStatsSummary({period:'month'|'custom',…})` → `categoryPeriodTotal()`
  выбирает строку `by_category` по `category_id`+`kind`, нет строки → 0.
  Формат `formatMoney(total, summary.currency)`. `unconverted_count>0` →
  `UnconvertedNotice scope="totals"`.
- Список: `useTransactions(txListFilters(selection, TX_LIST_LIMIT))` — тот же
  ключ, что у страницы (лимит 200 переезжает в `txFilters.ts` как экспорт и
  используется обеими сторонами), `TransactionList` + его же «Загрузить ещё».
  Скролл — у контейнера списка (`max-height`), шапка/итог/ссылка не уезжают.
- Строки в окне НЕКЛИКАБЕЛЬНЫ (`onEdit` у `TransactionList`/`TransactionRow`
  становится опциональным): вложенная `TransactionFormModal` дала бы два
  document-level Esc-хендлера и два фокус-трапа в одном DOM-поддереве. Пустое
  состояние — своё. 4 руки `queryPhase()` у обоих запросов, `isDirty` не нужен.
- Низ: ссылка `categoryTransactionsHref()` → `/transactions?category=…` +
  `month=` либо `from=&to=` (те же параметры, что читает `txFilters.ts`).
- Тексты — обе локали. Тесты: только `categoryDrilldown.test.ts`.
