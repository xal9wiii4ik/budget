# statement-import — план web (S4)

Контракт: architecture.md §6–7. Мобилка не трогается. Журнал импортов в UI — вне v1:
экран списка сессий не строим, но экран сессии deep-linkable по id.

## 1. Роуты и вход

- `/imports/:importId` — `routes/ImportPage.tsx`, единственный новый роут (под
  ProtectedLayout). F5/deep-link работает: экран поднимается из GET `/{id}` +
  GET `/{id}/rows`, ничего не живёт только в state.
- Вход в поток: действие «Импортировать выписку» на строке счёта в `/accounts`
  (AccountRow) → `features/imports/ImportUploadModal.tsx` (счёт предвыбран,
  формат зашит `priorbank_csv_v1`, file input `.csv`). 201 → `navigate('/imports/:id')`.
  Отдельного пункта в навбаре нет.
- POST — multipart в НАШ API (не пресайн, как receipts): openapi-fetch +
  `bodySerializer` → FormData; файл читается как bytes, никакого перекодирования
  cp1251 на клиенте — декодирует сервер.

## 2. Data layer (`data/imports.ts`, ключи в `queryKeys.ts`)

Новый дизъюнктный корень `['imports', ...]` (правило «new feature = new root»):
- `qk.importSession(id)` → `['imports', id, 'session']` — сессия + счётчики
  (rows_total/blocked/zero_skipped, разрезы по match_status/decision).
- `qk.importRows(id, matchStatus)` → `['imports', id, 'rows', { match_status }]` —
  useInfiniteQuery, limit=200, `offset` = pageParam (AM-1.6-a), фильтр — ДАННЫЕ В
  КЛЮЧЕ (как account_id у транзакций). 1000 строк = 5 страниц, паттерн
  TransactionList уже это держит; виртуализацию не вводим.
- Хуки: `useImportSession`, `useImportRows`, `useUploadStatement`,
  `usePatchImportRow`, `useApplyImport`, `useReplacePreview` (обычный useQuery,
  ключ `['imports', id, 'replace-preview', { from }]`, enabled при валидной дате),
  `useReplaceImport`, `useCancelImport` (DELETE, 204 разворачиваем руками —
  прецедент limits/tokens).

Инвалидация:
- PATCH строки: НЕ инвалидируем rows (invalidate infinite-query = рефетч всех
  загруженных страниц на каждый клик). PATCH-ответ (RowRead) кладём в кэш
  `setQueryData` по страницам; инвалидируем только `importSession` (счётчики —
  один дешёвый GET на клик). Отсюда: по одному PATCH на клик достаточно, дебаунс
  не нужен — решения принимаются по строке, гонок нет (мутации сериализуются
  через isPending-блокировку строки). Массовых операций в v1 нет (нет bulk
  endpoint) — «сбросить все similar в skip» потребует контрактного решения.
- apply/replace success: `invalidateTxLists` + `invalidateTxSummaries` (уже
  экспортированы) + bare `['stats']`, `['limits']`, `['accounts']`,
  `['goals','list']` — в `data/transactions.ts` завести экспортный
  `invalidateAfterBulkTxWrite(qc)` рядом с приватными хелперами, чтобы грамматика
  ключей не расползлась по модулям. Плюс `['imports', id]`.

## 3. Экран сессии (ImportPage)

- Шапка: filename, счёт, период, валюта; счётчики «разобрано N / пропущено
  заблокированных M / нулевых K» (i18n-плюрали); чипы-фильтры по match_status
  (все / exact / similar / new) со счётчиками из session — similar визуально
  акцентирован («требует взгляда»).
- Список строк `features/imports/ImportRowList.tsx` + `ImportRow.tsx`:
  дата (+время, если не NULL), description, bank_category, секция (contract/card
  бейджем), деньги — пара «потрачено/списано» через СУЩЕСТВУЮЩИЙ
  `originalPair.ts`-шейп (строка несёт те же поля amount_minor/currency +
  original_*); `formatMoney` c `useLocale()`. Никакой клиентской арифметики.
- Бейджи: `possible_transfer` («возможно, перевод» + подсказка «поставьте skip и
  создайте перевод вручную»); «Комиссия/Money-back» — только при ненулевом
  значении (см. §6 контрактный вопрос).
- Решение: сегмент import / skip / replace_own; replace_own отрисовывается
  только при `matched_tx_id != null` (сервер всё равно ответит
  DECISION_NEEDS_MATCH — но кнопку без матча не показываем). У exact/similar —
  ссылка «показать мою запись» (matched_tx / candidate_tx_ids) — рендер
  read-only мини-строк, данные кандидатов см. вопрос §6.
- Категория: текущая `category_id` (или подсказка) + источник подсказки
  («по мерчанту» / «по категории банка») мелким текстом. НЕ монтируем 1000
  `<select>`: строка показывает имя категории, выбор — по клику popover/модалка
  с одним переиспользуемым селектором (иначе предпросмотр на 1000 строк ляжет).
  Выбор шлёт PATCH `{category_id}` → `category_user_set=true` на сервере.
- Футер (sticky): «Применить» (apply), «Заменить с даты…» (второй путь),
  «Отменить импорт» (DELETE + ConfirmDialog destructive → navigate назад).
- Статус `applied`/`replaced` (в т.ч. после F5): read-only арм — счётчики сессии
  + ссылка на `/transactions?account=...`; строки редактировать нельзя
  (IMPORT_FINISHED не должен быть достижим из UI).

## 4. Путь «сверить» — apply

Кнопка «Применить» → ConfirmDialog с итогом из session-счётчиков по decision
(«создать X, пропустить Y, заменить Z») → POST apply → экран отчёта
`ImportReport.tsx` из ТЕЛА ответа: created / skipped / replaced /
already_existed. Повторный POST после обрыва сети безопасен (B-1) — retry-кнопка
в error-арме честная.

## 5. Путь «заменить с даты X» — replace

`features/imports/ReplaceFlow.tsx` (модалка, шаги):
1. Дата: input date, min=period_from, max=period_to (клиентский гейт; серверный
   REPLACE_FROM_OUT_OF_RANGE всё равно замаплен).
2. Превью: GET replace-preview → таблица СЕРВЕРНЫХ счётчиков: удалится всего /
   с чеком / из плана цели / от шаблона / переводы останутся / будет создано.
   Пока превью грузится — подтверждение недоступно.
3. Подтверждение «нельзя нажать случайно»: кнопка disabled, пока пользователь не
   ВПЕЧАТАЛ число удаляемых операций из превью (языконезависимо, требует
   прочитать превью); кнопка destructive-стилем, Enter не сабмитит. Смена даты
   сбрасывает ввод. Гейт — чистый модуль `replaceConfirmGate.ts`.
4. POST replace → тот же ImportReport (+ deleted).

## 6. Ошибки, i18n, контрактные поля

- `lib/errors.ts`: `describeImportError` — маппинг STATEMENT_PARSE_FAILED,
  STATEMENT_CURRENCY_MISMATCH (называет валюты выписки и счёта, если сервер их
  отдаёт в detail — иначе общая формулировка), STATEMENT_TOO_LARGE,
  STATEMENT_FORMAT_UNKNOWN, ACCOUNT_ARCHIVED/NOT_FOUND, IMPORT_NOT_FOUND,
  IMPORT_FINISHED, DECISION_NEEDS_MATCH, CATEGORY_*, REPLACE_FROM_OUT_OF_RANGE,
  RATE_LIMITED, network. Копия — в `ERROR_MESSAGES` (@budget/shared, аддитивные
  ключи не трогают замороженную мобилку); экранная копия — `apps/web/src/i18n`
  (dict.en задаёт ключи, dict.ru обязан отобразиться — typecheck-гейт).
- Комиссия/Money-back лежит в `raw` (JSONB) — контрактное предложение к S1/S2:
  RowRead отдаёт типизированное `fee_moneyback_minor: int | null` (парсится
  сервером при parse; null = пусто/ноль), клиент НЕ разбирает raw и не парсит
  «1 800,00». Бейдж рисуется при non-null.

## 7. Чистые модули и тесты (node vitest, рядом с фичей)

- `replaceConfirmGate.ts` + тест — единственная реально ломаемая логика
  (совпадение ввода с числом, сброс при смене даты/превью).
- `rowBadges.ts` (возможно объединить с view-маппером строки): гейт бейджа
  комиссии (non-null), выбор ключа источника подсказки — тест только если
  появится ветвление сложнее тривиального маппинга; иначе без теста (политика).
- Остальное — существующие покрытые модули (originalPair, formatMoney).

## 8. Вопросы к контракту (финальное сообщение) и оценки

Оценки (агент-минуты): написание 100–130; гейты (typecheck, lint, vitest,
openapi-drift) 15–20; верификация (dev-сервер + реальный Vpsk-файл, оба пути,
ошибки, F5) 35–45. Итого ~150–195.
