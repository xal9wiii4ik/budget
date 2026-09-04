# mobile-catchup-2 — форма операции (валюта траты, страна, фото, название, доход)

Tier: STANDARD (контракт не меняется, деньги — только перенос строк между полями,
без арифметики; presigned upload — повтор уже принятой на вебе схемы).
Team: mobile-engineer (один диспатч), mobile-qa (один сквозной проход в конце).
Без architect, без backend. Часть 1 — фундамент (`.tasks/mobile-catchup-1/`).

## План (≤200 слов)

**Переиспользуется из shared/api-client, без изменений:** `multiCurrencyTransactionFormSchema`
(уже пара original_*/country/merchant), `buildTransactionPatch` (диффит пару атомарно,
country; merchant НЕ диффит — мобилка диффит явно, как веб), `countryToCurrency`,
`COUNTRY_CODES`, `toInputString`, `emptyToNull`.

**Переезжает из веба в пакеты (как `amountMirror` в части 1, веб меняется только
импортами):** чистые `isPairMode/spendPrefill/spendCurrencyOptions/migrateAmounts`
(`originalPair.ts` → `@budget/shared`), `buildCreateBody` (`convertedSection.ts` →
`@budget/api-client`, рядом с patch-билдерами). Тесты едут вместе с кодом.

**Мобильное своё:** `kindCopy.ts` на мобильных ключах (сегмент типа — первым в форме),
`data/receipts.ts` (POST /receipts → PUT presigned → GET /receipts/{id}: `view_url` в
`<Image>`), `data/fx.ts` (оценка «списано» — только текст, в поле не пишется),
`AttachPhotoField` на `expo-image-picker` (добавить зависимость), `SpendCurrencyPicker`
(чипы + «другая валюта»), страна — seam `countryLabel` с фолбэгом флаг+код.

**Хвосты:** D-3 — `accessibilityLabel` в `LabeledInput`; D-4 — Save/Delete в липком
футере `KeyboardAwareForm` над safe-area, во всех четырёх формах.

**Не делаем:** секцию «сумма в базовой валюте» (не в списке), цели, чеки-OCR, часть 3.

**Оценка (агент-минуты):** написание 30–40; гейты 10 (shared, api-client, web, mobile,
mcp-server — последовательно); верификация 45–60 + один круг фикса, если QA найдёт
functional (фото через MinIO из симулятора — первая интеграционная граница мобилки).

## Отклонения от брифа

- `expo-image-picker` не был в проекте — добавлен как зависимость (`~17`, Expo 57).
- Hermes: `Intl.DisplayNames` отсутствует → названия стран через seam, фолбэк «🇬🇪 GE».
