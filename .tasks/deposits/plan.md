# Implementation Plan: deposits — бэкенд (по architecture.md + AMENDMENT)

Ревью-тир **FULL** (миграция + деньги + контракт) → self-review не делаю, идёт code-reviewer.
Архитектура утверждена, решения не переоткрываю: ниже только «как и где».

## Подход
Вклад = строка `deposits` + скрытый 1:1 счёт `AccountType.deposit`; движение денег — существующий
transfer. Начальное тело — `starting_balance_minor` deposit-счёта (AMENDMENT §1), поэтому таймлайн
процентов сеется `(opened_on, starting_balance_minor)` + transfer-леги. Проценты считаются на чтении
чистым модулем, хранится только ручной якорь. Герметичность deposit-счёта держат гарды в трёх роутерах.

## 1. Схема и модель
- `enums.py`: `AccountType` — append `deposit` СТРОГО в конец (порядок load-bearing:
  `models/account.py:_TYPE_VALUES` пересобирает CHECK); новый `DepositCapitalization`
  (`none|monthly|quarterly|at_maturity`) с тем же комментарием про порядок.
- `alembic/versions/0012_deposits.py` (revises `0011`): (1) drop+create CHECK `type_valid` на
  `accounts` → `('card','cash','deposit')`; (2) create `deposits` со всеми CHECK. Backfill нет.
- `models/deposit.py` — поля по architecture; `_CAPITALIZATION_VALUES` из enum (SQL byte-identical
  миграции); FK `account_id` UNIQUE + `ondelete="RESTRICT"`; CHECK: пара override (оба NULL или оба
  заданы), `term_end > opened_on`, `rate_percent >= 0`, `tax_rate_percent BETWEEN 0 AND 100`.
  Валюты в таблице НЕТ. `models/__init__.py` — экспорт `Deposit`.

## 2. `domain/deposits.py` (pure, no IO)
```python
@dataclass(frozen=True)
class TimelineEntry: on: date; delta_minor: int

@dataclass(frozen=True)
class AccrualInput:
    rate_percent: Decimal; capitalization: DepositCapitalization
    opened_on: date; term_end: date | None; timeline: Sequence[TimelineEntry]
    as_of: date; override: tuple[date, int] | None = None

def accrued_minor(inp: AccrualInput) -> int: ...
def _segments(...) -> list[tuple[date, date, int]]   # (start, end, principal_minor)
def _capitalization_boundaries(...) -> list[date]    # monthly/quarterly от opened_on; at_maturity → [term_end]
def after_tax_minor(gross_minor: int, tax_rate_percent: Decimal | None) -> int | None
```
- Day-count **actual/365 fixed**, константа `_DAYS_IN_YEAR = Decimal(365)`.
- Стоп: `end = min(as_of, term_end or as_of)`; `end <= start` → 0. Никакого float.
- Якорь: старт с `override_as_of`, тело = сумма таймлайна на эту дату, накопленное = `override_minor`
  (для compound якорь входит в тело на ближайшей границе) — прогноз ПРОДОЛЖАЕТ от него.
- Simple (`none`): Σ по сегментам `max(principal,0) * rate/100 * days/365`, ROUND_HALF_UP один раз в конце.
- Compound: промежуточно Decimal без округления; на КАЖДОЙ границе накопленное округляется
  ROUND_HALF_UP до минорных и присоединяется к телу. Тело < 0 → `max(principal, 0)`.

**`tests/test_deposits_domain.py`** (только ломаемое): високосный год (366 дней при делителе 365);
`rate=0` → 0; срок целиком в прошлом (заморожено на `term_end`); пополнение в середине периода
капитализации (contrast simple vs monthly — РАЗНЫЕ числа); снятие в минус; override-якорь
(contrast с тем же вкладом без якоря); `at_maturity` при `term_end IS NULL` = простой процент.

## 3. API
- `deposit_access.py` — `load_own_deposit(...) -> Deposit | None`, копия `account_access.py`
  (архивные возвращаются; порядок гардов решает роутер).
- `schemas/deposit.py`: `DepositRead` (id, name, account_id, currency из счёта, `rate_percent`
  Decimal→строка на wire как `transfer_rate`, capitalization, opened_on, term_end, tax_rate_percent,
  `balance_minor`, `accrued_minor`, `accrued_after_tax_minor|null`, computed `status: active|matured`,
  archived, created_at); `DepositCreate` (+ `initial_balance_minor: int = Field(0, ge=0, le=MAX_MINOR_AMOUNT)`);
  `DepositUpdate` (все Optional, omit/null/value); `DepositError`.
- `routers/deposits.py` (`_NOT_FOUND` + `_UNPROCESSABLE` по образцу accounts):
  - `POST ""` 201 — в ОДНОЙ транзакции `Account(type=deposit, currency, starting_balance_minor=initial)`
    + `Deposit(...)`, один commit; `term_end <= opened_on` → 422 `DEPOSIT_TERM_BEFORE_OPENING`.
  - `GET ""` (+`include_archived`) и `GET /{deposit_id}`: балансы — один `account_balances(...)`,
    таймлайны всех вкладов — один запрос по transfer-легам (`services/deposit_reads.py`, без N+1).
  - `PATCH /{deposit_id}` — 404 `DEPOSIT_NOT_FOUND` → 422 `DEPOSIT_ARCHIVED` (порядок load-bearing)
    → `*_REQUIRED` на NOT NULL-нулях → apply. `accrued_override_minor` значение ⇒ сервер сам ставит
    `accrued_override_as_of = today (UTC)`; null ⇒ обнуляет пару. `archived: true` каскадит на счёт
    в той же транзакции.
  - Монтаж в `app.py` (prefix `/deposits`); `/deposits/upcoming` НЕ делаем.
- `pat_auth.py::PAT_ALLOWLIST` — ровно два пайра: `("GET","/deposits")`, `("GET","/deposits/{deposit_id}")`.

## 4. Герметичность deposit-счёта — ВСЕ точки
- `routers/accounts.py::list_accounts` — `.where(Account.type != AccountType.deposit.value)`.
- `routers/accounts.py::update_account` — после `load_own_account`: `type == deposit` → 404
  `ACCOUNT_NOT_FOUND`. **GET `/accounts/{id}` в кодовой базе НЕ существует** — гард только в PATCH
  (уточнение к architecture, не отклонение).
- `schemas/account.py` — `AccountCreate.type` И `AccountUpdate.type` пинятся на `Literal["card","cash"]`
  (прецедент recurring_template): иначе card «превращается» во вклад патчем.
- `routers/transactions.py::create_transaction` — после `_reject_archived(account)`:
  `not is_transfer and account.type == deposit` → 422 `DEPOSIT_ACCOUNT_TRANSFER_ONLY`
  (counter-нога не проверяется: transfer на вклад легален).
- `routers/transactions.py::update_transaction` — тот же чек в блоке «account moves» после
  `_reject_archived(account)` (`kind` неизменяем, `is_transfer` уже посчитан).
- `routers/recurring.py::_require_own_account` — deposit → 422 `DEPOSIT_ACCOUNT_TRANSFER_ONLY`
  безусловно (шаблоны только expense|income); закрывает POST и PATCH-переезд разом.
- НЕ трогаем: `tx_totals.py`, `account_balances.py`, индекс имён в `/transactions/export`
  (deposit-имена в CSV нужны).

**`tests/test_deposits.py`**: создание с `initial_balance_minor` → `balance_minor`/`accrued_minor` его
видят; чужой и несуществующий вклад → байт-идентичный 404; deposit-счёт невидим в `GET /accounts`,
PATCH по нему → 404; `POST /accounts` и `PATCH type=deposit` → 422; expense на deposit-счёт → 422
(POST и PATCH-переезд), recurring — то же; transfer на вклад 201 и двигает `balance_minor`; архив
каскадит на счёт → перевод туда `ACCOUNT_ARCHIVED`; PAT: GET-ы 200, POST/PATCH → 403
`TOKEN_ENDPOINT_FORBIDDEN`. Существующие `test_openapi_export.py`/`test_cors.py` — без правок.

## 5. Контракт
`pnpm openapi` → `apps/api/openapi.json` + `packages/api-client/.../schema.d.ts` в ОДНОМ коммите
(руками не править). По правилу PM 2026-08-23 гоняю тесты всех четырёх потребителей (`pnpm test`:
web, mobile, api-client, mcp-server); `packages/mcp-server/src/allowlist.test.ts` сверяется с
`openapi.json` — новых MCP-инструментов не добавляю, но дрейф-тест обязан быть зелёным. CORS не расширяется.

## 6. Разбивка
**ОДНА подзадача B1** (миграция+enum+модель+домен+схемы+роутер+гарды+контракт). Согласен с
senior-lead: домен без роутера непроверяем, гарды — правки по 3–6 строк в трёх файлах, дробление
означало бы пересборку контракта дважды. Веб — `plan-web.md`, мобилка заморожена.

## 7. Оценки (агент-минуты)
- Написание кода: **95** (миграция+модель 20, домен 30, роутер+схемы 30, гарды 15) + тесты **45**.
- Гейты (ruff+format, mypy, pytest apps/api, turbo test 4 потребителей): **30**.
- Верификация (прогон сценариев qa-checklist до передачи QA): **20**. Итого ≈ **190**.

## Риски
1. Compound + якорь между границами капитализации — самое ломкое; contrast-тест обязателен.
2. Порядок `AccountType`: вставка не в конец ⇒ CHECK разъедется с 0008/0012.
3. `type != deposit` — единственная точка фильтрации; если веб берёт счета мимо `GET /accounts`,
   вклад протечёт в пикер (проверить в веб-плане).
4. Тело вклада после создания правится только переводами: PATCH по deposit-счёту закрыт 404 (MVP, ок).

## Открытые вопросы
Нет.

## Поправки senior-lead после сверки с plan-web.md (обязательны)
1. `DepositRead` ДОПОЛНИТЕЛЬНО несёт `accrued_override_minor: int|null` и
   `accrued_override_as_of: date|null` — веб рисует по ним бейдж «поправлено
   вручную» и сброс. Без них клиент не отличит расчёт от правки.
2. `GET /deposits` — archived-inclusive БЕЗ query-параметра (паттерн /accounts:
   один архивно-инклюзивный кэш-вход, клиент приглушает сам). Параметр
   `include_archived` из п.3 плана убрать.
