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
- ~~Перештамп валюты меняет смысл `amount_minor` — принятое поведение §4~~ —
  риск ЗАКРЫТ гейтом (амендмент скоуп-QA, ниже), а не принят: расчёт на
  предупреждение в UI не работал, тот же PATCH приходит из MCP без UI.
- Watermark смена счёта не трогает — иначе перенос «съел» бы pending catch-up.

## Амендмент (скоуп-QA): перенос между валютами требует новую сумму
`amount_minor` — целое в минорных единицах ШТАМПА шаблона, а перенос штамп
меняет: 25000 на USD-шаблоне молча становится ¥25000 (JPY экспонента 0), и
материализатор книжит это ежемесячно. Сервер не конвертирует за клиента (это
значило бы выдумать дату курса и правило округления для БУДУЩЕЙ проводки), а
отказывает.

- Гейт: целевой счёт в другой валюте, чем `template.currency`, и `amount_minor`
  НЕ в `model_fields_set` → 422 `AMOUNT_REQUIRED_ON_CURRENCY_CHANGE`. Имя — по
  грамматике роутера (`*_REQUIRED`: NAME_REQUIRED/AMOUNT_REQUIRED/ANCHOR_REQUIRED),
  существительное-поле впереди; отдельный код, потому что `AMOUNT_REQUIRED` уже
  занят явным null.
- Место: сразу после `_require_own_account` (404/ARCHIVED — раньше), ДО
  `eff_cur`-гейта. Порядок с `ACCOUNT_CURRENCY_MISMATCH`: побеждает денежный код —
  оба отказа порождены одним фактом (валюта цели ≠ валюта шаблона), сумму клиент
  обязан переназвать в любом случае, и ответ не зависит от необязательного эха.
- Перенос внутри одной валюты — как был: сумма не требуется.
- Тесты: `test_cross_currency_move_demands_the_amount_be_restated` (422 + шаблон
  не тронут + арм «та же валюта → 200»), `test_the_amount_gate_answers_before_the
  _stale_currency_echo` (порядок). Три прежних арма переноса дописаны суммой —
  RUB→USD без неё теперь законно 422.
