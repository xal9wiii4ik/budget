# Architecture Plan: S1 — двусторонняя валютная модель операции + профиль country/language

## Context
Представить «трата 50 EUR, банк списал 165 BYN» без слома существующей математики
(балансы, base-snapshot, tx_totals, лимиты, замороженная мобилка). Плюс профильные
поля country/language и transactions.country (S2) — одной миграцией.

## Verdict по модели из task.md
Модель ДЕРЖИТ. `amount_minor`+`currency` остаются списанием в валюте счёта — ни одна
строка tx_totals/балансов/лимитов не меняется. Original-пара — чисто отображающая
надстройка, зеркало counter-пары переводов. Одно несогласие и одно открытие — ниже.

## 1. Инварианты
- Деньги: `original_amount_minor` — целые минорные единицы валюты `original_currency`
  (экспонента по таблице, конвертация через `convert_minor`, Decimal, ROUND_HALF_UP).
- Base-snapshot считается ОТ СПИСАНИЯ (amount_minor/currency), как сейчас. Обоснование:
  списание — то, что реально ушло со счёта (курс банка внутри); конвертация от original
  дала бы двойную конверсию нашим курсом и расхождение агрегатов с балансом счёта.
  `auto_snapshot` не трогаем; tx_totals не видит original вообще.
- Серверная арифметика: original→settlement считает ТОЛЬКО сервер (fx_lookup
  nearest-previous на occurred_at + convert_minor). Присланный amount_minor побеждает
  (семантика override как у base-snapshot). No-oracle не затронут (нет новых lookup'ов
  чужих ресурсов).

## 2. CHECK-констрейнты (transactions)
- `original_pair`: `(original_amount_minor IS NULL) = (original_currency IS NULL)`.
- `original_amount_minor_positive`: `IS NULL OR > 0` (всегда user-supplied, зеркало
  counter_amount_minor_positive).
- `original_currency_format`: `~ '^[A-Z]{3}$'`.
- `original_currency_differs`: `original_currency IS NULL OR original_currency <> currency`.
  РЕШЕНИЕ: равенство ЗАПРЕЩЕНО. NULL уже означает «валюта траты = валюта счёта»; два
  представления одного факта → ветвления в display_rate/CSV/PATCH. API: присланный
  original с валютой счёта → 422 `ORIGINAL_CURRENCY_MATCHES_ACCOUNT`.
- `transfer_no_original`: `kind <> 'transfer' OR (обе NULL)` — у переводов уже есть
  counter-пара; original на transfer → 422 (новый код или COUNTER_FIELDS-паттерн).
- `transactions.country`: char(2) nullable, CHECK `~ '^[A-Z]{2}$'`. Без индекса.

## 3. Семантика create/PATCH
CREATE (amount_minor в схеме становится optional):
| original | amount_minor | результат |
|---|---|---|
| нет | есть | сегодняшнее поведение |
| нет | нет | 422 (валидация схемы, как сейчас) |
| пара | есть | пользовательский курс: пишем оба как прислано |
| пара | нет | сервер: amount_minor = convert_minor(original, rate on occurred_at) |
| половина пары | — | 422 (Pydantic-валидатор; CHECK — страховка) |

`ACCOUNT_CURRENCY_MISMATCH` ОСТАЁТСЯ без изменений: поле `currency` = валюта списания,
штампуется от счёта, несогласное значение → 422. original_currency этим гейтом не
гейтится — это другое поле.

PATCH (пара — атомарная единица, через model_fields_set):
| original в PATCH | эффект |
|---|---|
| omit | не трогаем |
| null (обе) | очистить пару; amount_minor НЕ пересчитываем (списание — источник правды) |
| значение (обе) + amount_minor | пишем оба (пользовательский курс) |
| значение (обе) без amount_minor | пересчитать amount_minor по курсу на occurred_at |
| половина | 422 |
- PATCH amount_minor при существующей original-паре — просто override, original не трогаем.
- PATCH occurred_at НЕ пересчитывает amount_minor (провенанс не храним; деньги не
  переписываем молча). PATCH account_id на счёт с валютой == original_currency →
  422 `ORIGINAL_CURRENCY_MATCHES_ACCOUNT`, refuse-whole (прецедент B3 recurring) —
  пользователь очищает original тем же PATCH'ем.

## 4. Курс отсутствует на дату
РЕШЕНИЕ: 422 `FX_RATE_UNAVAILABLE` (новый код), только на пути «original без
amount_minor». Не делаем amount_minor всегда обязательным: весь UX-выигрыш — «ввёл
50 EUR, сервер посчитал BYN». NULL-деградация (прецедент base-snapshot) невозможна:
amount_minor NOT NULL и участвует в балансе. Клиент по 422 просит сумму списания.
Замечание: хранятся только 6 канонических пар (EUR-cross + NBRB) — для экзотических
валют 422 будет нормой; веб-форма должна уметь этот фолбэк сразу.

## 5. Контракт
- TransactionRead: + `original_amount_minor`, `original_currency`, + read-only
  `display_rate` — как transfer_rate: Decimal-строка, мажорные единицы, ROUND_HALF_UP,
  «валюта счёта за 1 единицу original», null при original NULL. Считается на чтении
  из двух хранимых сумм (не хранится).
- client_id-идемпотентность: без изменений (select-first вернёт сохранённую строку;
  original — обычные поля тела).
- CSV-экспорт: + колонки `original_amount` (форматирование по экспоненте
  original_currency), `original_currency`, `country` — В КОНЕЦ строки.
- Profile: НЕТ HTTP-эндпоинта вообще (открытие: base_currency ставится только
  register-хуком). Нужен НОВЫЙ роутер `/profile`: GET (base_currency,
  monthly_income_minor, country, language) + PATCH (country, language; base_currency
  в этом скоупе не редактируем). JWT-only (настройки, MCP не нужен → pat_auth
  allowlist не трогаем). CORS: GET/PATCH уже в списке верб.

## 6. Миграция 0009 (одна на скоуп)
- transactions: `original_amount_minor` BIGINT NULL, `original_currency` VARCHAR(3)
  NULL, `country` VARCHAR(2) NULL + шесть CHECK'ов из §2.
- profiles: `country` VARCHAR(2) NULL (CHECK `^[A-Z]{2}$`), `language` VARCHAR(2)
  NULL (CHECK `language IN ('ru','en')` OR NULL).
  РЕШЕНИЕ: language NULLABLE БЕЗ default. NULL = «не подтверждён» — естественный
  маркер для first-run подсказки из локали (task.md: подтверждает пользователь);
  default 'ru' врал бы для en-пользователей и стёр бы различие «выбрал/не выбирал».
  Клиент при NULL берёт локаль браузера/кеш.
- Backfill не нужен (все новые колонки NULL-совместимы).

## 7. Затронутые файлы бэка
- models/transaction.py, models/profile.py; alembic/versions/0009_*.py
- schemas/transaction.py (Create/Update/Read), новый schemas/profile.py
- routers/transactions.py (create/PATCH original-логика, display_rate, CSV, country)
- новый routers/profile.py + маунт в app.py
- services/fx_lookup.py — БЕЗ изменений (переиспользуем lookup_rate+convert_minor;
  конверсия original→settlement — инлайн в роутере или мелкий хелпер, решает инженер)
- openapi.json + packages/api-client/schema.d.ts (одним коммитом)
- тесты: CHECK'и/полу-пара, таблица create/PATCH §3, FX_RATE_UNAVAILABLE, CSV-колонки

## What this does NOT decide
- Точное имя хелпера конверсии и место валидаторов пары (инженер).
- Маппинг страна→валюта в packages/shared (фронтовая линия S1).
- Форматы лейблов/отображения (веб), S3–S7.
