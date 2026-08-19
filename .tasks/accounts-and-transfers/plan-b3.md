# Plan B3 — PATCH /recurring/{id} может переносить шаблон на другой счёт

## Что и почему
B2 сознательно не дал `account_id` в `RecurringTemplateUpdate` (комментарий
`schemas/recurring.py:113-116`, `review-b2.md` п.4): «перенос стоячего платежа —
отдельное решение». Решение принято — делаем перенос по прецеденту PATCH
/transactions (`routers/transactions.py:857-861, 896-931`), не изобретая второй
механики. Валюта шаблона остаётся производной от счёта (§4/OQ-1): при переносе
она перештамповывается, поэтому «прислал старую валюту вместе с новым счётом» —
целиком 422, а не половинчатая запись.

## Файлы
- `apps/api/src/budget_api/schemas/recurring.py` — `+ account_id: uuid.UUID | None`
  в `RecurringTemplateUpdate`; переписать устаревшие комментарии 113-116 (нет
  account_id) и про currency (сверка с ЭФФЕКТИВНЫМ счётом).
- `apps/api/src/budget_api/routers/recurring.py` —
  `+ ("account_id", "ACCOUNT_REQUIRED")` в `_REQUIRED_FIELDS`; загрузка счёта
  через существующий `_require_own_account` (404 ACCOUNT_NOT_FOUND / 422
  ACCOUNT_ARCHIVED уже внутри); currency-гейт на `eff_cur`; запись
  `account_id` + перештамп `currency`; комментарии (docstring 362-364,
  «currency is never written»).
- `apps/api/tests/test_recurring_api.py` — новый `TestPatchAccountMove`.
- Контракт: `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts`
  (пара, `pnpm openapi`) — ожидается изменение ТОЛЬКО `RecurringTemplateUpdate`.
- `services/recurring_jobs.py` НЕ меняется (книжит `tpl.account_id`/`tpl.currency`).

## Порядок гейтов в PATCH (load-bearing)
`_load_own` (404) → `_REQUIRED_FIELDS` → `_reject_transfer_kind` → anchor-блок →
`_require_own_account` → `eff_cur` currency → category → запись. Чистые
payload-гейты до любого похода в БД (правило create): ответ на невыразимый
пейлоад не зависит от того, куда указывают id.

## Тесты (только ломаемое)
1. перенос на счёт в другой валюте → новый `account_id` И новая `currency`;
2. `account_id: null` → 422 ACCOUNT_REQUIRED;
3. чужой/несуществующий → 404, тело байт-в-байт одинаковое (no-oracle);
4. архивный → 422 ACCOUNT_ARCHIVED, шаблон не изменён;
5. новый счёт + СТАРАЯ валюта → 422 ACCOUNT_CURRENCY_MISMATCH, ничего не применено;
6. `materialize_due` после переноса → строка на новом счёте в новой валюте.

## Риски
- Перештамп валюты меняет смысл `amount_minor` — принятое поведение §4 (тест 1).
- Watermark смена счёта не трогает — иначе перенос «съел» бы pending catch-up.
