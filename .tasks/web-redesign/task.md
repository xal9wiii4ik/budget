# Скоуп `web-redesign` — фаза 1 (чекпоинт для пользователя)

Оценка пользователя: «фронтенд ужасный», ждёт красивый редизайн. Судит глазами по
скриншотам — фаза 1 заканчивается выкладкой ему, не отчётом. Тир: STANDARD
(только представление; ни auth-логики, ни денег, ни контракта).

## Диагноз (по коду)
- Дизайн-системы нет: 78 `*.module.css`, ни одной CSS-переменной, `#2563eb` ×144.
- Шрифт не задан → системный с засечками на форме входа.
- Оболочка `routes/ProtectedLayout.tsx` — шапка с девятью ссылками в ряд.
- Общие компоненты: Modal, ConfirmDialog, CurrencySelect, QueryStateNotice — и всё.

## Решения пользователя (не обсуждаются)
1. Светлая + тёмная тема с переключением. По умолчанию системная
   (`prefers-color-scheme`), ручной выбор в localStorage, БЕЗ мигания при
   загрузке (тема применяется до первой отрисовки).
2. Боковая панель навигации с группами: деньги (операции, счета, вклады,
   статистика), планирование (категории, регулярные, цели, советник),
   настройки. Иконки, активное состояние, сворачивание на узких экранах.

## Решения senior-lead
- Узкие экраны (< 900px): top bar (бренд + переключатель темы + бургер), бургер
  открывает ТУ ЖЕ сгруппированную панель как off-canvas drawer; закрывается по
  переходу, Esc и клику по подложке. Не bottom bar: девять пунктов в трёх
  группах не помещаются без «Ещё», прячущего планирование за два тапа; drawer
  даёт один компонент навигации и одну ментальную модель на обеих ширинах.
- Шрифт: Inter Variable (fontsource-сборка, subsets latin + latin-ext +
  cyrillic + cyrillic-ext, `unicode-range`), woff2 в `apps/web/public/fonts`,
  `@font-face` в `styles/fonts.css`, preload в `index.html`. Никаких внешних
  загрузок в рантайме. Табличные цифры включаются токеном/утилитой
  (`font-variant-numeric: tabular-nums`) на всех суммах.
- Тема: атрибут `data-theme` на `<html>`, значения `light|dark`; отсутствие
  атрибута = системная. Инлайн-скрипт в `index.html` ДО модуля читает
  `localStorage['budget.theme']` и ставит атрибут → нет мигания. `color-scheme`
  на `:root` в обеих темах — нативные select/date/скроллбары следуют теме.
- Токены семантические, не сырьевые: surface/bg/border/text/accent/danger/
  success/warning + отдельно `--color-expense`, `--color-income`,
  `--color-transfer` — одна семантика на всех экранах. Плюс шкалы spacing,
  radius, font-size, line-height, shadow (минимальные), z-index, focus-ring.
- Тёмная тема — свой набор поверхностей (не инверсия), текст ≥ 4.5:1.

## Направление стиля
Спокойный, дорогой, без игрушечности: воздух, один сдержанный акцент, тонкие
границы вместо теней, tabular-nums, суммы по правому краю, расход/доход/перевод
одними цветами везде. Ориентиры — Linear, Mercury, Wise.

## Периметр фазы 1
- Слой 1: `styles/tokens.css`, `styles/global.css`, `styles/fonts.css`, шрифт,
  `theme/` (провайдер/хук + переключатель).
- Слой 2: `components/` — Button (primary/secondary/ghost/danger; sm/md),
  Field (label + control + hint + error; text/number/select), Card, Badge,
  PageHeader, EmptyState, Toolbar. Плюс перевод существующих Modal,
  ConfirmDialog, CurrencySelect, QueryStateNotice на токены.
- Слой 3: оболочка с сайдбаром и переключателем темы; вход и регистрация;
  экран Операций целиком: `routes/TransactionsPage`, `features/transactions/*`
  (list/row/summary/pickers/filters/search/window/form), `features/transfers/*`,
  `features/accounts/AccountFilter|AccountSelect|AccountField`,
  `features/recurring/UpcomingCharges`, `features/goals/plan/GoalDeadlines`,
  `features/receipts/ReceiptCaptureModal|ReceiptDropzone`.
- Остальные экраны — фаза 2, НЕ трогать (пусть временно выглядят старыми).

## Что нельзя
- Менять поведение. Только представление. 277 веб-тестов без правок. Роли,
  `aria-label`, тексты кнопок, id полей — сохраняются.
- Hex в тронутых модулях: `grep -E "#[0-9a-fA-F]{3,6}"` = 0 (кроме tokens.css).
- Трогать мобилку, `packages/shared`, `docker-compose.yml`, `.env`.
- Коммитить.

## Доступность
Текст ≥ 4.5:1 в обеих темах, фокус видим с клавиатуры, цели нажатия ≥ 40px на
узких экранах. Проверяется инструментально (web-qa).

## Приёмка
1. Скриншоты в обеих темах, десктоп и 375px: вход; операции — список с данными,
   форма, перевод. Одноразовый стенд с `qa-*@budgetqa.dev`.
2. Гейты: typecheck 6 пакетов, 277 веб-тестов без правок, lint.
3. Отчёт ≤400 слов + пути к скриншотам.

## Команда и порядок
A. frontend-engineer — слои 1 + 2 + оболочка + вход/регистрация → `plan-web.md`
   (имена токенов, API компонентов) — гейт senior-lead.
B1. frontend-engineer — страница/список/фильтры/виджеты; B2. frontend-engineer —
   форма операции/перевод/пикеры/чек. Параллельно, файлы не пересекаются.
C. web-qa — стенд, скриншоты, контраст (axe/вычисление по computed styles),
   размеры целей на 375px. Функциональная программа НЕ гоняется.
