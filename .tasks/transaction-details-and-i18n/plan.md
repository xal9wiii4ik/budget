# Implementation Plan (backend): transaction-details-and-i18n — S1/S2/S3

Планирую строго по `architecture.md` (модель S1 принята). Разногласия/находки — §7.
Тестовые конвенции: `~/.claude/skills/pytest-conventions/SKILL.md` (грузить на импле).

## 1. Подзадача B1 — миграция + модели + схемы + роутер транзакций (одна граница)

Одной границей: CHECK без валидатора = 500, проверять раздельно нечего.

- `alembic/versions/0009_original_amounts_country_and_profile_i18n.py`
  - transactions: `original_amount_minor`, `original_currency`, `country` + 6 CHECK'ов (§2).
  - profiles: `country` VARCHAR(2) NULL, `language` VARCHAR(2) NULL (CHECK ru|en),
    **без server_default** (PM-1). Backfill не нужен.
- `models/transaction.py` / `models/profile.py` — те же колонки и CHECK'и слово-в-слово
  (рендер сверяет `alembic check`).
- `schemas/transaction.py`
  - `TransactionCreate`: `amount_minor: int | None` (ge=1, le=MAX), `original_amount_minor`,
    `original_currency` (pattern), `country` (pattern `^[A-Z]{2}$`).
  - `TransactionUpdate`: те же три + **`receipt_id: uuid.UUID | None`** (S3, PM-2) —
    комментарий «re-linking is not a feature» (:195 и :143 в Create) переписать.
  - `TransactionRead`: `original_amount_minor`, `original_currency`, `country`,
    `display_rate: str | None` (см. §7.1 — имя под вопрос).
- `routers/transactions.py`
  - `_serialize`: три поля + `display_rate` через существующую
    `domain.fx.transfer_rate(original…, amount…)` — новой доменной математики нет.
  - `create_transaction`: блок original ПОСЛЕ account-гейтов и ДО snapshot-таблицы;
    выведенная сумма живёт в локальной `effective_amount`, её читают `auto_snapshot` и
    `Transaction(...)` (§7.2 — баг-ловушка).
  - `update_transaction`: пара атомарна через `model_fields_set`; `_CONVERSION_INPUTS`
    дополнить (§7.2); `receipt_id` — `_validate_receipt` при non-null, explicit null =
    detach, новое значение = перепривязка (PM-2), файл в MinIO не трогаем.
  - `_EXPORT_COLUMNS` + `_export_row`: `original_amount` (экспонента `original_currency`),
    `original_currency`, `country` — В КОНЕЦ.
  - Новые коды: `ORIGINAL_CURRENCY_MATCHES_ACCOUNT`, `FX_RATE_UNAVAILABLE`,
    `ORIGINAL_FIELDS_REQUIRED` (полупара), `TRANSFER_ORIGINAL_FORBIDDEN`,
    `AMOUNT_REQUIRED` на create (§7.3).

## 2. Подзадача B2 — роутер `/profile`

- `services/profile_reads.py`: переносим `_get_or_create_profile` из роутера транзакций
  (второй потребитель = триггер извлечения, прецедент tx_totals), поведение не меняется.
- `schemas/profile.py`: `ProfileRead` (base_currency, monthly_income_minor, country,
  language), `ProfileUpdate` (country, language; `Literal['ru','en'] | None`),
  `ProfileError`.
- `routers/profile.py`: `GET ""` (НЕ self-heal, дефолты как в `read_base_currency`),
  `PATCH ""` (self-heal + omit/null/value), обе на `current_active_user` (JWT-only,
  прецедент `routers/tokens.py`); `PAT_ALLOWLIST` не трогаем — PAT упрётся в 401.
- `app.py`: маунт с `prefix="/profile"`. CORS-список верб уже содержит GET/PATCH.

## 3. Подзадача B3 — контракт + компиляция клиентов

- `pnpm openapi` → `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts`
  одним коммитом (drift-тест api-client).
- **Риск для замороженной мобилки:** optional-`amount_minor` и новые поля ЗАПРОСА
  компиляцию не ломают. Ломают новые ОБЯЗАТЕЛЬНЫЕ поля `TransactionRead` — объектные
  литералы-фикстуры: `apps/mobile/src/data/accountLookup.test.ts` и 4 веб-фикстуры
  (`rowDisplay/groupByDay/recurringBadge/transferDisplay.test.ts`), +3 строки в каждой.
  Это касание замороженной мобилки — нужен явный ok senior-lead. Сделать поля Read
  опциональными нельзя: они всегда присутствуют в ответе.

## 4. Тесты (только на реально ломаемое)

`tests/test_core_model.py` (прямой insert, доказывает CHECK'и, а не валидаторы):
полупара; `original_currency == currency`; `original_amount_minor <= 0`; original на transfer.

`tests/test_original_amount.py` (+ правка существующего CSV-теста):
1. create: пара + amount_minor → оба как прислано (курс банка побеждает).
2. create: пара без amount_minor → сервер посчитал списание **и** base-снапшот от него.
3. create: `original_currency` == валюта счёта → 422 `ORIGINAL_CURRENCY_MATCHES_ACCOUNT`.
4. create: пара без amount_minor и без курса → 422 `FX_RATE_UNAVAILABLE`, строка не создана.
5. create: amount_minor нет и original нет → 422 `AMOUNT_REQUIRED`.
6. PATCH: обе null → пара очищена, `amount_minor` не тронут.
7. PATCH: пара без amount_minor → пересчёт списания + base-снапшота.
8. PATCH `account_id` на счёт с валютой original → 422, строка не изменена (refuse-whole).
9. read: `display_rate` — строка нужного формата при паре, null без пары.
10. CSV: три новые колонки в конце, `original_amount` в экспоненте своей валюты.
11. receipt_id (S3): attach (null→value), detach (value→null), перепривязка,
    чужой/несуществующий → 422 `RECEIPT_NOT_FOUND`.
12. `/profile`: GET без строки профиля → дефолты и строка НЕ создана; PATCH пишет
    country/language; `language:'de'` → 422; PAT-токеном → 401.

НЕ пишем: «transfer_rate не изменился», отдельный роундтрип `country` в Read, «MinIO не
вызван на detach» (вызова там нет вовсе).

## 5. Порядок и оценка (агент-минуты)
| # | Подзадача | Написание | Гейты | Верификация |
|---|---|---|---|---|
| B1 | миграция+модели+схемы+роутер tx (S1+S2+S3-бэк) | 40 | 10 | 10 |
| B2 | `/profile` + извлечение get_or_create_profile | 15 | 5 | 5 |
| B3 | контракт + фикстуры клиентов | 10 | 10 | 5 |
| B4 | тесты §4 (пишутся вместе с B1/B2, гоняются целиком) | 35 | 10 | 10 |

Порядок: B1 → B2 → B4 → B3 (регенерация последней). Гейты:
`TEST_DATABASE_URL=…5443/budget_test uv run pytest`, `alembic check`,
`pnpm turbo lint typecheck test`, `/review-pr`.

## 6. S4/S5/S7 — бэк-работ НЕТ (подтверждаю)
S4: `merchant` уже в Create и Update, обучение на create работает (F4). S5: `language`
едет в 0009, имена категорий и коды ошибок не трогаем. S7: `Goal.priority` без изменений.

## 7. Разногласия и находки (senior-lead — решить до старта)

1. **Имя `display_rate`.** Поле ничего не говорит о том, между чем курс. Предлагаю
   `original_rate` — симметрия с `transfer_rate` и с парой `original_*`. Переименование
   после релиза = смена контракта; решаем сейчас. Дефолт — как в архитектуре.
2. **Дырка в §3, обязательно закрыть:** когда сервер САМ выводит `amount_minor` из
   original, поле не попадает в `model_fields_set`, поэтому текущее правило
   «пересчитать base-снапшот, если тронут вход конверсии» НЕ сработает — строка уедет
   со снапшотом от старой суммы. Лечим на обоих путях: create считает снапшот от
   выведенной суммы, PATCH добавляет `original_amount_minor`/`original_currency` в
   `_CONVERSION_INPUTS`.
3. **Коды вместо Pydantic-массива.** Архитектура отдаёт полупару и «нет суммы» схемной
   валидации (422-массив). Дом-стиль — строковые коды; веб-форме нужен именно код,
   чтобы попросить сумму списания. Предлагаю router-level `ORIGINAL_FIELDS_REQUIRED` и
   `AMOUNT_REQUIRED` (код уже существует в PATCH), Pydantic оставить страховкой.
4. **PAT.** `PATCH /transactions/{id}` в allowlist → PAT сможет менять `receipt_id`.
   Ownership держит `_validate_receipt` (чужой == несуществующий → 422, без оракула),
   `/receipts` PAT'у недоступны — эскалации нет, allowlist не трогаем. Ничто в коде,
   кроме комментариев, на «receipt_id create-only» не завязано (грепнул apps+packages).
5. **Follow-up (не в этом скоупе):** осиротевшие объекты MinIO после detach/перепривязки
   не удаляются (PM-2). Уборка — отдельная задача, ТОЛЬКО по явному подтверждению
   пользователя, никакой автоматики по таймеру.
6. Ожидаемо частый `FX_RATE_UNAVAILABLE` (хранятся 6 канонических пар) — веб обязан
   иметь фолбэк «введите сумму списания» с первого дня, иначе фича выглядит сломанной.
7. **Follow-up (NIT-1 ревью B, PM 2026-08-22):** выведенный сервером settlement-amount
   (`convert_minor` в create/PATCH derived-ветках) может превысить `MAX_MINOR_AMOUNT`
   (D14) — `le`-границы схемы проверяют только присланные значения. Известный класс,
   тот же, что давно принят для `base_amount_minor` из `auto_snapshot`; отдельной
   работы сейчас нет.

## 8. Резолюции senior-lead + PM (2026-08-22) — обязательны
1. §7.2 (дырка снапшота) — **закрыть обязательно**, это дефект плана, не улучшение:
   create считает снапшот от `effective_amount`, PATCH добавляет original-поля в
   `_CONVERSION_INPUTS`. Тесты §4.2 и §4.7 обязательны и проверяются МУТАЦИЕЙ:
   снять правку — тест обязан покраснеть (зафиксировать в отчёте имплементации).
2. §7.1 — имя поля: **`original_rate`** (симметрия с transfer_rate). Везде, включая
   контракт и B-2 в qa-checklist.
3. §7.3 — **строковые коды приняты**: `ORIGINAL_FIELDS_REQUIRED` (полупара),
   `AMOUNT_REQUIRED` (нет суммы и нет original), Pydantic — страховка второго эшелона.
4. §3 (фикстуры мобилки) — правка **разрешена PM**: +3 строки в фикстурах для
   типизации монорепы — поддержание работающего, не расширение поверхности.
   Опциональность полей Read ради фикстур — **категорически нет**.
5. §7.5 — подтверждено: follow-up уборки сирот MinIO только по явному подтверждению
   пользователя, без таймера.
