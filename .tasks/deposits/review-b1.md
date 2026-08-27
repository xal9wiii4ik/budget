# Review B1 — deposits backend (tier FULL)

Ревьюер: code-reviewer, 2026-08-27. Дифф: некоммиченное состояние (см. список файлов в брифе).
Гейты не гонялись (политика PM 2026-08-17); точечные пробы — ниже.

## Вердикт

**Изменения запросить: 1 MAJOR (контракт), остальное — MINOR/NIT.** Деньги, миграция,
герметичность и скоупинг корректны. Три принятые оркестратором отклонения реализованы
верно (константа `DEPOSIT_ACCOUNT_TYPE` + `ACCOUNT_TYPE_VALUES`; каскад имени; разархивация
с двусторонним каскадом — но см. MINOR-3 о её ширине).

## Что проверено и чисто

- **domain/deposits.py.** Контрольные числа пересчитаны независимо (скрипт с помесячной
  капитализацией): 11 520 (monthly), 11 408 (quarterly), 3 873 (top-up mid-period),
  930 (уход в минус), 6 230/6 248 (якорь simple/compound) — все совпали с тестами.
  Float отсутствует; ROUND_HALF_UP ровно в точках «деньги становятся деньгами» (граница
  капитализации + финал); actual/365 с закреплённым тестом на 366/365; заморозка на
  `min(as_of, term_end)`; `max(principal, 0)`; якорь продолжает прогноз и входит в тело
  на ближайшей границе — как в плане. Кламп годовщин через `monthly_due` (31-е → Feb 28 →
  Mar 31), без второй месячной арифметики.
- **Миграция 0012.** CHECK-строки байт-идентичны модели (`type IN ('card', 'cash', 'deposit')`;
  `capitalization IN (...)` рендерится из enum в том же порядке); naming convention даёт
  те же `ck_deposits_*`. RESTRICT+UNIQUE на `account_id`, CASCADE на `user_id`, пара
  override под CHECK, `ix_deposits_user_id`. Downgrade симметричен: DELETE deposit-счетов
  легален — обе ноги транзакций (`account_id`, `counter_account_id`) имеют FK CASCADE,
  recurring на deposit-счёт зарезан гардом, так что RESTRICT-хвостов нет.
- **Герметичность — четыре заслона на месте, пятой двери не нашёл.** SQL-фильтр списка;
  PATCH /accounts/{id} по deposit → тот же байт-идентичный 404; пин типов — все три схемы
  несут двухзначный `AccountType` (wire-enum в openapi остался `['card','cash']`);
  `DEPOSIT_ACCOUNT_TRANSFER_ONLY` в create + PATCH-переезде транзакций (только своя нога,
  counter легален) и безусловно в `_require_own_account` recurring. Проверил стоки:
  stats/limits/summary/advisor/goals идут через `tx_totals` (transfer уже вырезан, а на
  deposit-счетах бывают только transfer'ы); top-merchants — expense-only; goal_item paid —
  expense-only; экспорт CSV строит индекс имён по ВСЕМ счетам пользователя (deposit-имена
  в CSV сохранены — как требовал план); `GET /transactions?account_id=` матчит обе ноги —
  история вклада видима. Импорта выписок в коде ещё нет.
- **Скоупинг/no-oracle.** Все новые запросы (deposit_access, оба запроса deposit_reads,
  каскадный load счёта в PATCH) фильтруют `user_id`. Порядок гардов: not-found → archived;
  тест пинит байт-идентичность 404 на чужом АРХИВНОМ вкладе.
- **deposit_reads.** Три запроса на любое число вкладов (нет N+1); знаки лег дословно
  повторяют `account_balances` (income +, иначе −, counter-нога +) — таймлайн и баланс
  суть два чтения одного леджера; `occurred_at` — Date, совпадает с `TimelineEntry.on`.
- **Схемы/контракт.** Decimal-строки наружу (`rate_percent: str`, normalize+format f),
  Decimal внутрь с bounds, зеркальными Numeric(8,4)/Numeric(5,2) (тест пинит, что
  переполнение — 422, а не DataError); `initial_balance_minor`/`accrued_override_minor`
  ge 0 le MAX (⇒ якорь в домене неотрицателен by construction). `openapi.json` и
  `schema.d.ts` согласованы. PAT_ALLOWLIST — ровно два GET-пайра; тест пинит 403 на
  POST/PATCH под full-токеном. mcp-server: два read-инструмента, write-пары в явном
  never-list (README + заголовок allowlist + тест на отсутствие `create/update/delete_deposit`),
  счёт инструментов 35/20 сходится во всех трёх местах.
- **Тесты.** Все границы из плана покрыты, вакуумных нет: каждый contrast-тест
  действительно контрастирует (leap 10 980 vs 10 950; simple/monthly 3 840 vs 3 873;
  якорь ±0.18; оба CHECK пробиты прямыми INSERT'ами).

## Findings

**MAJOR-1. POST /deposits: 422-арм контракта нечестный.**
`apps/api/src/budget_api/routers/deposits.py:184` — декоратор POST не объявляет
`responses={**_UNPROCESSABLE}`, при этом роут кидает 422 `DEPOSIT_TERM_BEFORE_OPENING`
(строка 194). В `openapi.json` 422 у POST /deposits объявлен как чистый
`HTTPValidationError`, а рантайм отдаёт `{"detail": "DEPOSIT_TERM_BEFORE_OPENING"}` —
строку, которую типизированный клиент по этой схеме не смоделирует. Это прямое нарушение
конвенции AM-5 (`docs/conventions.md`: «422s declared as raw anyOf»); PATCH того же
роутера объявлен правильно, POST /transactions и POST /recurring — прецеденты правильного
POST. Фикс: добавить `responses={**_UNPROCESSABLE}` на POST и перегенерить пару
`openapi.json`+`schema.d.ts` (один коммит).

**MINOR-2. Мёртвая ветка `at_maturity` в `_capitalization_boundaries`.**
`apps/api/src/budget_api/domain/deposits.py:119-122` — условие `start < term_end < end`
невыполнимо: единственный вызов передаёт `end = min(as_of, term_end)`, т.е. `end <= term_end`
всегда. Ветка `return [term_end]` недостижима. Итоговое ЧИСЛО корректно (at_maturity ==
simple для начисления на чтении, тест это пинит), но код в денежном модуле изображает
событие капитализации, которое не может произойти. Упростить до `return []` с комментарием
«граница у as_of/term_end ничего не меняет — см. открытый интервал», либо оставить как
защиту от будущего вызова с другим `end` — но тогда сказать это в докстринге.

**MINOR-3. Разархивация шире принятого отклонения №3.**
`apps/api/src/budget_api/routers/deposits.py:257-265` — принятое отклонение: «архивный
вклад принимает единственную запись — `archived:false`». Реализация пропускает ЛЮБОЙ PATCH,
где среди полей есть `archived:false`, и применяет его целиком (имя, ставка, override — всё
разом). Вреда нет (эквивалентно разархивации + второму PATCH), докстринг это честно
описывает, но это решение шире зафиксированного и в qa-checklist не отражено. Либо сузить
(отклонять посторонние поля рядом с `archived:false`), либо оформить как принятое решение.

**NIT-4.** `deposits.py:_decimal_str` — докстринг обещает «POST's echo and every later GET
must print the same characters», но клиентское `"10.00"` вернётся как `"10"` (normalize).
Поведение нормальное, поправить фразу.

**NIT-5.** `domain/deposits.py:184` — пересчёт `body` суммой всего таймлайна на каждом
ребре — O(edges×timeline). На реальных объёмах (десятки переводов) незаметно; префикс-сумма
уберёт квадрат, если вклады доживут до сотен движений. Не трогать сейчас.

## Пробы

- Repro-скрипт (Decimal): независимый пересчёт 7 контрольных чисел — совпали.
- `python -c` по `openapi.json`: 422-армы POST/PATCH /deposits vs прецеденты — источник MAJOR-1.
- grep-свип `select(Account` / stats / export / advisor — пятой двери нет.
