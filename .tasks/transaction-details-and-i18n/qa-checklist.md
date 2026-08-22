# QA Checklist: transaction-details-and-i18n — API-срез (FINAL)

Финализирован (см. секцию «Финализация» внизу); имена кодов — финальные.
Покрывает S1 (original-пара + профиль), S2 (country), S3 (receipt_id в PATCH). НЕ
покрывает S4/S5/S7 и веб-часть — web-qa на имплементации; S6 — мобилка заморожена.

## Секция A — pytest (владелец: backend-engineer)

### S1 — двусторонняя валютная модель
- A-1 create с original-парой (EUR) на BYN-счёте без `amount_minor` → 201, сервер посчитал списание по дневному курсу (nearest-previous), `currency`=BYN.
- A-2 create с original-парой И присланным `amount_minor` → 201, побеждает присланное значение (курс банка), сервер НЕ перезаписывает.
- A-3 create с половиной пары (только `original_amount_minor` / только `original_currency`) → 422 `ORIGINAL_FIELDS_REQUIRED`, обе половины симметрично.
- A-4 `original_amount_minor` ≤ 0 → 422; CHECK в БД тоже держит (прямой insert).
- A-5 original-пара на `kind=transfer` → 422 `TRANSFER_ORIGINAL_FORBIDDEN`; PATCH transfer'а с original — тот же код.
- A-6 PATCH original: omit=keep, пара значений=override, null=clear (обе колонки в NULL); half-null в PATCH → 422. Контраст со snapshot-семантикой обязателен.
- A-7 нет курса на дату операции (пустая `exchange_rates` для пары) + `amount_minor` не прислан → 422 `FX_RATE_UNAVAILABLE`, НЕ 500 и НЕ тихий 0.
- A-8 баланс счёта после A-1/A-2 двигается ровно на `amount_minor` (списание), original в арифметику остатка не входит.
- A-9 `base_amount_minor` снапшот считается от `amount_minor`+`currency` счёта, а не от original (контраст: original в третьей валюте).
- A-10 идемпотентный replay `client_id` с original-парой → 200 и та же строка с теми же original-полями (дубля нет), в т.ч. при повторе с ДРУГИМ original.
- A-11 exponent-0 валюта в original (JPY 5000 → 5000, не 500000) — ×100-порча; и exponent-3 (KWD) для симметрии.
- A-12 `original_currency` == валюта счёта: поведение по решению архитектора (принять как NULL / принять как есть / 422) — тест фиксирует выбранное.
- A-13 profile PATCH `country`/`language`: валидный, лишний регистр, мусор (`'ZZZ'`, `'by '`, `''`) → 422; nullable-дефолты у существующих профилей не ломают GET /users/me.

### S2 — страна траты
- A-14 `transactions.country`: 'BY' ок; 3 символа / цифры / lowercase (нормализация или 422 — по решению) → детерминированный ответ; NULL при создании через PAT/MCP — ок.
- A-15 CSV-экспорт: колонка country присутствует и пуста для старых строк (если колонка войдёт в скоуп) — иначе TC снимается.

### S3 — фото в форме операции
- A-16 create с `receipt_id` чека в статусе pending при ПУСТОМ `anthropic_api_key` → 201, никакого 503 `AI_NOT_CONFIGURED` (гейт живёт только в /parse).
- A-17 PATCH `receipt_id`: null→значение (attach), значение→null (detach, если решено), значение→другое значение (re-link — разрешить или 422, зафиксировать).
- A-18 PATCH/create с чужим `receipt_id` → no-oracle отказ, байт-в-байт равный отказу на несуществующий UUID (код по решению: 404 `RECEIPT_NOT_FOUND` или 422).
- A-19 PAT-аудит: PATCH с `receipt_id` через PAT пишет ровно одну строку `pat_audit_log` с шаблоном роута и `entity_id` — новая колонка контракт аудита не ломает.

## Секция B — живой curl (владелец: qa-engineer, прогон на /test)
Потолок PM: живьём только то, чего pytest не доказывает. 6 сценариев.
- B-1 сервер поднялся после миграции: `GET /health` 200 + `GET /openapi.json` байт-в-байт равен `apps/api/openapi.json`.
- B-2 сквозной пользовательский сценарий из задачи целиком на реальном HTTP: BYN-счёт → трата 50 EUR / списание 165 BYN → операция читается с обеими парами и производным курсом → остаток счёта и `/stats/summary` сходятся до минорной единицы.
- B-3 **STOP-probe (fx)**: реальный `fx_lookup` на дневных курсах БД — операция задним числом на дату без курса и на дату с курсом; проверяем нужный курс, а не «какой нашёлся».
- B-4 **STOP-probe (MinIO)**: presign POST /receipts → реальный PUT файла → attach через PATCH → presigned GET отдаёт ТОТ файл. Мокнутый storage этого не доказывает.
- B-5 профиль: PATCH `country`/`language` → GET /users/me отдаёт сохранённое; контракт `/users/me` не потерял существующие поля.
- B-6 CSV-экспорт скачивается живьём (BOM, content-disposition) и содержит строку с original/country — стрим ломается мимо pytest-клиента.

**Не в живом прогоне** (закрыто pytest'ом): валидация original-пары — A-3/A-4; чужой чек и скоупинг — A-18; идемпотентность — A-10; экспоненты — A-11; запрет original на переводе — A-5; PATCH omit/null — A-6.

## Кандидаты на mid-scope STOP-probe
B-3 (fx) и B-4 (MinIO) — границы, которые pytest мокает. Пауза сразу после того, как бэк закрыл конвертацию (S1) и PATCH receipt_id (S3), ДО веб-части.

## Вопросы архитектору (блокируют финализацию)
1. `original_currency` == валюта счёта — принимать, нормализовать в NULL или 422?
2. Detach `receipt_id` в PATCH — разрешён? Re-link на другой чек? Осиротевший объект в MinIO удаляем или нет?
3. Отсутствие курса при заданном original и НЕ присланном `amount_minor` — какой код 422?
4. `country`/`original_currency` lowercase — нормализуем или 422?
5. `language` — default 'ru' или NULL (иначе замороженная мобилка получит новый обязательный смысл)?
6. Колонка country в CSV — в этом скоупе или нет? (от ответа зависит A-15/B-6)

## Итог прогона

### Mid-scope STOP-probe прогон (2026-08-22, qa-engineer) — только B-1/B-3/B-4
Прогнано 3 из 6 живых сценариев; B-2/B-5/B-6 остаются на финальный прогон скоупа.
Total (в этом прогоне): 3 · Passed: 3 · Failed: 0 · Blocked: 0 · Статус: ✅ STOP-probe PASS.
- B-1 ✅ `GET /health` 200 (`{"status":"ok","database":"ok"}`); `GET /openapi.json` совпадает с
  `apps/api/openapi.json` семантически (канонический sha256 обоих `1014eddc…`). Уточнение к формулировке
  TC: байт-в-байт сравнение невозможно by design — экспортёр пишет pretty-print с сортировкой ключей
  (173 627 б), сервер отдаёт compact (84 056 б); критерий — равенство после канонизации.
- B-3 ✅ (fx, реальные дневные курсы `nbrb` в БД). Дата-дырка 2026-08-13 (курсов 12–14.08 нет):
  5000 EUR minor на BYN-счёте → `amount_minor` 17123 = 50 EUR × 1/0.29201343 (BYN→EUR на **2026-08-11**,
  nearest-previous), `original_rate` "3.4246"; курс 15.08 дал бы 17169, последний известный 22.08 — 17459.
  Точная дата 2026-08-18 → 17471 (= 1/0.28619673), `original_rate` "3.4942". Снапшот базы сошёлся:
  17123 BYN × 27.73155851 (BYN→RUB 13.08) = 474 847 = `base_amount_minor`. Дата до первого хранимого
  курса пары (2025-01-15 при min 2025-07-11) → **422 `FX_RATE_UNAVAILABLE`**, не 500, в логах контейнера
  ни одного traceback.
- B-4 ✅ (MinIO, полный круг). `POST /receipts` 201 → presigned PUT (SignedHeaders=host) → реальный PUT
  2071 б, HTTP 200 → `PATCH /transactions/{id}` c `receipt_id` 200 → чтение операции отдаёт тот же
  `receipt_id` → presigned GET (сгенерирован тем же `services/storage.Storage`) вернул 200,
  content-type image/jpeg, sha256 `9ac40b39…b601377` — совпал с загруженным, `cmp` байт-в-байт.
  Detach (`receipt_id: null`) → 200, объект в MinIO остался (тот же sha256 после detach), re-attach → 200.
- Bring-up: dev-БД уже на `0009`; API-контейнер крутил старый образ (в live-контракте не было
  `original_amount_minor`) — потребовалась пересборка `docker compose up -d --build api` (compose-файл и
  .env не трогались). Пользователь `qa-txdetails-1787401932@budgetqa.dev`.

### Полный прогон скоупа
Total: 25 (pytest 19 / curl 6) · Passed: 0 · Failed: 0 · Blocked: 0 · Статус: ⏸ FINAL, полный прогон не начинался.

## Финализация (senior-lead + PM, 2026-08-22) — сценарии НЕ добирать (PM-4: 25/6 — финал)
Ответы на вопросы архитектору:
1. A-12: `original_currency` == валюта счёта → **422 `ORIGINAL_CURRENCY_MATCHES_ACCOUNT`** (architecture.md §2).
2. A-17: detach И перепривязка **разрешены**; файл в MinIO **не удаляется** (PM-2); уборка сирот — отдельный follow-up.
3. A-7: код — **`FX_RATE_UNAVAILABLE`**, полупара — `ORIGINAL_FIELDS_REQUIRED`, нет суммы и original — `AMOUNT_REQUIRED` (PM п.3).
4. A-14: lowercase/мусор country и original_currency → **422** (pattern-валидация, без нормализации — зеркало `base_currency_format`).
5. A-13: `language` — **NULL без default** (PM-1); GET /users/me с NULL-полями — предмет A-13/B-5.
6. A-15/B-6: country в CSV — **в скоупе** (architecture.md §5), TC остаётся.
Производный курс в B-2 читается полем **`original_rate`** (PM п.2). Статус: ⏸ FINAL, прогон не начинался.
