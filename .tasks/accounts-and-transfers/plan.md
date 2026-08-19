# Implementation Plan: accounts-and-transfers (backend)

Решения — `architecture.md` + аддендум A1–A4; здесь только точки вставки. Три конфликта с
реальным кодом — решить ДО старта B1.

## Конфликты architecture.md ↔ код (senior-lead: подтвердить)

- **C-1 (блокирующий, §7).** `models/recurring_template.py:39` строит свой `kind_valid` итерацией
  по `TransactionKind` → `transfer` МОЛЧА расширит CHECK шаблонов, что §7 запрещает. Фикс:
  пинить кортеж `(expense, income)` с комментарием «byte-identical к 0006». В B1 — иначе
  `alembic check` красный сразу.
- **C-2 (§7).** `schemas/recurring.py` типизирует `kind: TransactionKind` в трёх местах →
  `transfer` валиден на проводе и упадёт 500 на CHECK. Нужен 422
  `RECURRING_TRANSFER_UNSUPPORTED` в POST/PATCH `/recurring` (B2); отдельный enum отвергаю —
  меняет имя компонента в контракте.
- **C-3 (гап §3/A2, отклонение).** `transfer_rate` считается из МАЖОРНЫХ величин обеих ног —
  нужен экспонент валюты цели, которого в строке нет. Предлагаю денормализовать
  `counter_currency` String(3) (штамп от target-счёта; валюта счёта иммутабельна → дрейф
  невозможен) + парный CHECK по образцу `base_snapshot_pair`. Мапа account→currency на запрос
  хуже: `_serialize`/`_export_row` сегодня чистые функции строки, а CSV-колонка
  `counter_amount` без экспонента цели нерендерима. Поле уезжает и в `TransactionRead` (A3).

## B1 — ядро (FULL). Оценка: **45 / 25 / 20** агент-минут

Написание выше нормы 10–20 осознанно: миграция + таблица + роутер + переписанные create/patch
транзакций + ~16 тестов. Запас — в гейтах (25): required `account_id` ломает ~40 call-site'ов в
11 тест-файлах — жду 1–2 круга починки фикстур.

- `enums.py` → `AccountType(StrEnum)` = card, cash (комментарий про load-bearing порядок);
  `transfer` ТРЕТЬИМ в `TransactionKind`.
- `models/account.py` (новый) → таблица §1; CHECK `currency_format`, `type_valid`; `archived`
  Boolean/false; без unique(name). `models/__init__.py` → реэкспорт (иначе alembic не увидит).
- `models/transaction.py` → `account_id` (NOT NULL, FK CASCADE) + `counter_account_id`,
  `counter_amount_minor`, `counter_currency` (nullable); CHECK'и §3 + `counter_pair` (три
  counter-поля вместе или все NULL) + `transfer_no_base_snapshot`; `kind_valid` перестроится
  сам. `models/recurring_template.py` → C-1.
- `alembic/versions/0008_accounts_and_transfers.py` → create `accounts`; add_column ×4;
  `drop_constraint(op.f("ck_transactions_kind_valid"))` + пересоздание под тем же именем с
  `IN ('expense','income','transfer')`; новые CHECK'и; `recurring_templates.account_id` NOT NULL
  FK CASCADE. Симметричный downgrade (conftest гоняет `downgrade base`). NOT NULL без
  server_default легально — таблицы пусты (§11, обнуление делает PM ДО миграции).
- `account_access.py` (новый) → `load_own_account(...)`: копия `load_visible_category` без
  system-ветки, foreign/missing → один `None` (no-oracle).
- `schemas/account.py` (новый) → `AccountCreate` / `AccountUpdate` (omit=keep, без `currency`) /
  `AccountRead` (+ `balance_minor`) / `AccountError`.
- `services/account_balances.py` (новый) → `account_balances(...) -> dict[UUID,int]`, фрагмент 1.
- `routers/accounts.py` (новый) → GET/POST/PATCH по образцу `routers/categories.py`
  (`current_user_jwt_or_pat`, `_NOT_FOUND`/`_UNPROCESSABLE`, `include_archived`). PATCH с
  `currency` → 422 `ACCOUNT_CURRENCY_IMMUTABLE`. DELETE нет. `app.py` → include_router; CORS
  не трогаем (риск 7). `domain/fx.py` → чистая `transfer_rate(...) -> Decimal | None` (фрагмент 2).
- `schemas/transaction.py` → Create: `account_id` required + counter-пара optional (`ge=1`,
  `le=MAX_MINOR_AMOUNT`); Update: те же три optional; Read: + `account_id`, `counter_account_id`,
  `counter_amount_minor`, `counter_currency`, `transfer_rate: str | None`.
- `routers/transactions.py`: `_serialize` → счёт-поля + `transfer_rate` строкой
  (`format(rate,"f")`); `create_transaction` → блок валидации ПОСЛЕ replay-арма в жёстком
  порядке (риск 1), затем штамп `currency` от счёта и `counter_currency` от counter-счёта, у
  transfer base-пара всегда `(None, None)` и `auto_snapshot` не зовётся; `update_transaction` →
  422 `KIND_CHANGE_UNSUPPORTED` на смену kind на/с transfer, `account_id` в `_CONVERSION_INPUTS`,
  `eff_cur` от эффективного счёта (не из тела), у transfer-строк снапшот-блок пропускается.
- Контракт: `pnpm openapi` → `openapi.json` + `schema.d.ts` в одном коммите.

**Тесты: ≈16.** Темы: CRUD счетов + `balance_minor` (обе ноги перевода, валюта с экспонентом 0);
no-oracle на чужом счёте в path И в `counter_account_id`; guard order «чужой архивный →
NOT_FOUND»; иммутабельность валюты; создание перевода (штамп обеих валют, base-пара NULL);
422-семейство (SAME_ACCOUNT, категория у перевода, counter-поля без transfer, transfer без них,
CURRENCY_MISMATCH); PATCH kind на/с transfer; PATCH `account_id` → перештамповка + пересчёт
снапшота; идемпотентный replay перевода; `transfer_rate` юнитами (экспоненты + округление).

### Фрагмент 1 — балансы одним запросом
```python
own = select(
    Transaction.account_id.label("acc"),
    case(
        (Transaction.kind == TransactionKind.income.value, Transaction.amount_minor),
        else_=-Transaction.amount_minor,  # expense И transfer одинаково уходят со счёта
    ).label("delta"),
).where(Transaction.user_id == user_id)
incoming = select(
    Transaction.counter_account_id.label("acc"),
    Transaction.counter_amount_minor.label("delta"),
).where(
    Transaction.user_id == user_id,
    Transaction.kind == TransactionKind.transfer.value,
)
legs = union_all(own, incoming).subquery()
rows = await session.execute(select(legs.c.acc, func.sum(legs.c.delta)).group_by(legs.c.acc))
```
`starting_balance_minor` прибавляется в роутере на уже загруженных строках счетов; счёт без
движений отсутствует в мапе (`.get(id, 0)`). UNION ALL вместо коррелированных подзапросов: одна
проходка, никакой NULL-арифметики.

### Фрагмент 2 — transfer_rate: 6 ЗНАЧАЩИХ цифр, не 6 знаков после запятой (курс VND→USD ~0.0000395)
```python
with localcontext(Context(prec=6, rounding=ROUND_HALF_UP)):
    rate = to_decimal(counter_minor, counter_currency) / to_decimal(amount_minor, currency)
```
`amount_minor == 0` → `None` (схема даёт `ge=1`, но CHECK модели `>= 0` — дешёвая страховка).
Сериализация через `format(rate, "f")`: `str()` на Decimal с prec=6 даёт научную нотацию.

## B2 — агрегаты и периферия (FULL). Оценка: **20 / 12 / 10**

- `services/tx_totals.py` → модульный предикат `_NOT_TRANSFER` в трёх grouped-выборках И в
  `_bucket_three_rows` (риск 5).
- `_read_filters` → `account_id` → `or_(account_id == x, counter_account_id == x)`; параметр в
  `list_transactions` и `export_transactions` (общий хелпер — одно определение на оба).
- `_EXPORT_COLUMNS` / `_export_row` / `_csv_body` → колонки `account`, `counter_account`,
  `counter_amount`; мапа имён счетов грузится рядом с `category_names` (тот же паттерн);
  `counter_amount` = `to_major_string(counter_amount_minor, counter_currency)`.
- `models/recurring_template.py` + `schemas/recurring.py` → `account_id` NOT NULL FK CASCADE /
  поле в Create-Update-Read; `routers/recurring.py` → валидация счёта (`load_own_account` → 422
  `ACCOUNT_NOT_FOUND` / `ACCOUNT_ARCHIVED`) + C-2.
- `services/recurring_jobs.py::materialize_due` → `account_id=tpl.account_id` в `Transaction(...)`.
  Контрактная пара — регенерация (изменились `/transactions` и `/recurring`).

**Тесты: ≈6.** Темы: перевод вне `/transactions/summary` (иностранная валюта бьёт обе ветки
сразу); перевод вне `/stats/monthly`; CSV с новыми колонками в экспоненте цели; фильтр
`account_id` ловит обе ноги; шаблон копирует `account_id` в строку; `kind=transfer` → 422.

## M1 — MCP/PAT (FULL, маленькая). Оценка: **10 / 8 / 5**

- `pat_auth.py::PAT_ALLOWLIST` → `("GET","/accounts")`, `("POST","/accounts")`, `("PATCH","/accounts/{account_id}")`.
- `allowlist.ts` → тулы `list_accounts` (read), `create_account`, `update_account` (write) +
  curated-описания новых полей в `create_transaction`, `update_transaction`,
  `list_transactions`. Имя в `params`, которого нет в контракте, роняет старт → делать ПОСЛЕ
  регенерации openapi. Шапка «All 24 tools» → 27.
- `allowlist.test.ts` → 24 → 27 в двух списках, в тексте `it(...)` и в `toHaveLength`;
  `create_transaction.inputSchema.required` получает `account_id` (порядок = порядок полей в
  Pydantic-модели).

**Тесты: ≈2.** PAT на GET/POST/PATCH `/accounts` (read-скоуп на POST → 403
`TOKEN_SCOPE_READONLY`); плюс правка существующих ts-ассертов (не новые).

## Рисковые места

1. **Guard order / no-oracle на counter-счёте.** Чужой `counter_account_id` идёт через тот же
   `load_own_account` и тот же код `ACCOUNT_NOT_FOUND`, что и отсутствующий. Порядок в create:
   replay → account NOT_FOUND → ARCHIVED → консистентность counter-полей → counter NOT_FOUND →
   SAME_ACCOUNT_TRANSFER → counter ARCHIVED → категория → CURRENCY_MISMATCH. ARCHIVED выше
   NOT_FOUND = оракул.
2. **`kind_valid` byte-identical.** Пересборка CHECK обязана совпасть с рендером модели
   символ-в-символ, включая имя `ck_transactions_kind_valid` (`op.f`), иначе `alembic check`
   красный. Плюс C-1: CHECK шаблонов не должен поехать заодно.
3. **Идемпотентный replay с transfer.** Replay-арм отдаёт строку до всякой валидации — менять
   нельзя; `_serialize` перевода не должен требовать ничего кроме строки (довод за C-3).
4. **PATCH `account_id`.** Тройной эффект: перештамповка `currency`, пересчёт base-снапшота, и
   для transfer-строк запрет снапшота вообще (CHECK). Смешать ветки = 500 вместо 422.
5. **`_bucket_three_rows`.** Фильтр kind нужен в ЧЕТЫРЁХ местах, а не в трёх: base-пара
   перевода всегда NULL, иначе иностранная нога уедет в bucket-3, сконвертируется на чтении, а
   fold-in `monthly` (`income if kind == income else expense`) зачтёт её как РАСХОД.
6. **Массовая починка фикстур** от required `account_id` — вероятный второй круг гейтов B1.
7. **CORS** — новых verb'ов нет (`app.py:196`, GET/POST/PATCH уже в списке), правка не нужна.
