# SUPERSEDED per PM 2026-08-23: скоуп переопределён в кнопку-ярлык
# (предзаполнение обычной формы операции). B1 ОТМЕНЁН ЦЕЛИКОМ.
# Файл сохранён для истории решений; не исполнять.

# Implementation Plan: recurring-book-now — B1 (API)

## 0. Верификация несущих утверждений task.md (по коду)
**V1. `due_dates_between(after=watermark, through=due_on) == [due_on]` корректна, но
НЕ достаточна: она не знает про `end_date`.** `due_dates_between` (recurrence.py:74-98)
отдаёт `(after, through]`; клампом `end_date` владеет только `upcoming_due_dates`/джоба,
поэтому `due_on > end_date` дал бы `[due_on]` и прошёл — списание за концом шаблона,
которое D2 требует отказать. Правка в одну строку: `through = min(due_on, end_date)`.
Прочее подтверждено: `due_on <= watermark` → `[]`; дата вне грамматики → список реальных
дат ≠ `[due_on]`; второй pending → длина 2 (арреарс не перепрыгнуть). `limit=2` даёт
тождественный вердикт и ограничивает цикл.

**V2. Ватермарка = будущий `due_on` ничего не ломает — ПОДТВЕРЖДЕНО.** `_due_template_ids`
фильтрует `last_materialized_on < today` (recurring_jobs.py:59) → шаблон невидим джобе до
`due_on+1`, а тогда окно `(due_on, today]` уже без `due_on`. `_next_due_on` и `/upcoming`
идут через `upcoming_due_dates` с полом `max(watermark, today-1)` → следующий срок строго
после `due_on`. Клауза `end_date > last_materialized_on` корректно выводит шаблон из
кандидатов на последнем сроке.

**V3. Второй параллельный запрос детерминированно получает 422 — ПОДТВЕРЖДЕНО** при
READ COMMITTED (движок без `isolation_level`, db.py:22 → дефолт): `FOR UPDATE` второго
блокируется, после коммита первого перечитывает свежую строку → `watermark == due_on`
→ `[]` → 422. Сессия на запрос своя, локирующий SELECT в ней первый — identity-map не мешает.

**V4. Следствие D2 (не опровержение):** при задолженности первый pending < today, а
`/upcoming` его не отдаёт (пол `today-1`) → «+» честно отвечает 422 до прогона джобы.
В проде окно ≤24 ч, в QA/dev с `RECURRING_SCHEDULER_ENABLED=false` это норма — в
qa-checklist, а не чинить кодом. Эндпоинт при этом НЕ требует `due_on >= today`.

## Файлы
- `services/recurring_booking.py` (новый) — D7: единственное место конструирования
  `Transaction` из шаблона; джоба и роутер зовут его.
- `services/recurring_jobs.py` — тело цикла → вызов хелпера (поведение байт-в-байт:
  те же поля, снапшот на `due`).
- `services/tx_reads.py` (новый) — переезд чистого `_serialize` +
  `_transfer_rate_str`/`_original_rate_str` из `routers/transactions.py` как
  `serialize_transaction` (дома так же вынесли `tx_totals`/`profile_reads` — «на
  втором потребителе»); router→router импорт не заводим. 6 call-site правок там же.
- `routers/recurring.py` — `_load_own(..., for_update: bool = False)`; новый роут.
- `schemas/recurring.py` — `RecurringBookRequest`.
- `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts` — пара.
## Скелеты
```python
# services/recurring_booking.py
async def build_template_transaction(
    session: AsyncSession,
    template: RecurringTemplate,
    *,
    occurred_at: date,        # джоба: due; эндпоинт: today
    base_currency: str,       # читается ОДИН раз на шаблон (у джобы — вне цикла)
    amount_minor: int | None = None,  # None -> template.amount_minor (D4 override)
) -> Transaction: ...  # в сессию не добавляет; auto_snapshot на occurred_at и на
                       # ФАКТИЧЕСКУЮ сумму, не на шаблонную

# schemas/recurring.py
class RecurringBookRequest(BaseModel):
    due_on: date
    amount_minor: int | None = Field(default=None, ge=1, le=MAX_MINOR_AMOUNT)

# routers/recurring.py
@router.post("/{template_id}/book", response_model=TransactionRead,
             status_code=201, responses={**_NOT_FOUND, **_UNPROCESSABLE})
async def book_now(template_id, payload, user=Depends(...), session=Depends(get_session))
```
Порядок внутри одной транзакции (D5), всё под замком:
1. `_load_own(…, for_update=True)` → 404 `RECURRING_TEMPLATE_NOT_FOUND` (готовый
   no-oracle путь). 2. `tpl.paused` → 422 `RECURRING_TEMPLATE_PAUSED`.
3. (amended per PM 2026-08-23, task.md D5/D5a) гейта по архивному счёту НЕТ:
   ручной book = та же автоматика, запущенная рукой; книжим на архивный счёт
   verbatim, как джоба (recurring_jobs.py:131-141, решение B2/MINOR-1). Код
   `ACCOUNT_ARCHIVED` на эндпоинте не существует, `_require_own_account` не зовём.
4. `through = min(due_on, tpl.end_date)` (при `end_date is None` — просто `due_on`);
   `due_dates_between(unit, anchors, after=tpl.last_materialized_on,
   through=through, limit=2) != [due_on]` → 422 `DUE_DATE_NOT_PENDING`.
5. `base = await read_base_currency(…)`; `tx = await build_template_transaction(…,
   occurred_at=_today(), base_currency=base, amount_minor=payload.amount_minor)`;
   `session.add(tx)`; `tpl.last_materialized_on = due_on`; `commit`; `refresh(tx)`;
   `serialize_transaction(tx)`.

**Транзакционная граница:** одна сессия `get_session`, ОДИН commit; двухфазный паттерн
джобы не нужен — probe существует ради «не держать сессию через всю работу» в фоновом
цикле, а тут работа = один шаблон внутри запроса. Замок держится 3-4 коротких запроса.
**Курс:** снапшот на `occurred_at = today` (D3) и от ФАКТИЧЕСКОЙ суммы (override).
Обучение merchant→category из POST /transactions не переносим: категория из шаблона.

## D6 — замок на write-путях
`_load_own(session, id, user_id, *, for_update=False)` → `.with_for_update()`; `True` в
`update_template` (закрывает MINOR-1: PATCH перестаёт считать `min(watermark, today)` /
`max(…, today-1)` от протухшего чтения) и в `book_now`. `delete_template` — тоже `True`
ради правила «write = замок», но это НЕ несущее: DELETE и джоба безопасны в обоих
порядках (джоба ловит `tpl is None`). GET-пути не блокируют.

## Периферия
`_UNPROCESSABLE`: правим только комментарий-перечень кодов — envelope generic
(`RecurringError.detail: str`). Роут-конфликтов нет (второй POST — `""`), объявляем
после `/upcoming`. PAT-пару НЕ добавляем (D8): fail-closed 403 приходит сам, тест
allowlist односторонний. CORS: POST уже есть. `pnpm openapi` → пара файлов, один коммит.
## Тесты (`tests/test_recurring_book.py`, через HTTP + прямые проверки БД)
1. Happy (`due_on` в будущем): 201, `occurred_at == today`, поля скопированы (account/
   currency/category/merchant/note/kind/`recurring_template_id`), `last_materialized_on
   == due_on`, `next_due_on` за `due_on`. 2. Повтор того же запроса → 422
   `DUE_DATE_NOT_PENDING`, транзакция ровно одна.
3. Два параллельных запроса (barrier в патче `_load_own` — приём из
   `test_recurring_jobs::test_concurrent_runs_…`): один 201, один 422, одна строка;
   убивает удаление `with_for_update`.
4. Book сегодняшнего срока + `materialize_due(today=…)` → строка не задвоена.
5. Арреарс: ватермарка отстала, pending в прошлом, запрос СЛЕДУЮЩЕЙ даты → 422, строк
   нет (убивает подмену сырой ватермарки полом `/upcoming`). 6. `due_on` за `end_date`
   → 422 (убивает пропажу end-клампа, V1).
7. Override: 201 с новой суммой, `template.amount_minor` не тронут, `base_amount_minor`
   от override (курс засеян). 8. Отказы одним классом: paused →
   `RECURRING_TEMPLATE_PAUSED`, архивный счёт → `ACCOUNT_ARCHIVED`, чужой → 404.

Не пишем: сьют на чистый хелпер (ветки идут через 1-8), PAT-403 (есть в `test_pat_auth`),
barrier-тест на PATCH↔джобу — замок пинает тест 3, отдельный дорог и дублирует
(отклонение фиксирую, senior-lead может настоять).

## Риски
- Переезд сериализатора: 6 call-site, механика, ловится сьютами transactions/transfers.
  Рефактор джобы обязан быть поведенчески пустым — `test_recurring_jobs` проходит БЕЗ
  правок этого файла. V4: 422 при задолженности выглядит багом для QA без шедулера.

## Оценка (агент-минуты): письмо 55 / гейты 12 / верификация 15
