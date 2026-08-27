# Implementation Plan: statement-import (backend)

Следует `architecture.md` (§1–§9); факты формата сверены по реальному файлу
(218 строк операций, 2 секции, «Заблокированные» — 7 строк с ДРУГОЙ сеткой из
8 колонок, валютные строки USD/EUR/PLN, `1 600,00` с пробелом-тысячным,
дубликаты 4×`PAYBYCARD.BY -1,15` различимы только временем/occ_index).

## Approach

Три backend-подзадачи строго по §9: S1 (parse+match, ничего не мутирует),
S2 (решения+apply+learning), S3 (replace, FULL-ревью). Парсер — потоковый
state-machine по строкам уже декодированного текста (файл ≤1 МБ, целиком в
памяти; никакого csv.DictReader — заголовки секций и итоги ломают сетку).
Apply/replace — сервис, не HTTP-циклы; создание транзакций повторяет стемп-
инварианты POST /transactions напрямую (см. «reuse»), НЕ вызывая роутер.

## Existing patterns to reuse (все подзадачи)

- `account_access.py` — no-oracle загрузка счёта (NOT_FOUND до ARCHIVED).
- `category_access.py` — валидация category_id в PATCH.
- `services/fx_lookup.auto_snapshot` + `get_or_create_profile` — снапшот при apply.
- `domain/money.py` — minor по экспоненте валюты выписки (не ×100).
- `domain/merchant.normalize_merchant` — ключ merchant-подсказки и learning.
- B-1: `_load_by_client_id`/`_recover_replay_race` (transactions.py) — тот же
  паттерн, но батчевый (см. S2).
- Rate limit: `prime_rate_limit` + декоратор как в receipts (10/min).
- Size-гейт: прецедент `receipts.py:363` (content-length), но для multipart
  надёжнее `await file.read(limit+1)` — заголовку клиента верить нельзя.
- 422-юнион `_UNPROCESSABLE`, SCREAMING_SNAKE-коды, роут-порядок «литералы до
  `/{id}`» здесь не нужен (нет коллизий), CORS-вербы уже покрыты (GET/POST/PATCH/DELETE).

## Database changes

Миграция `0012_statement_imports.py` по архитектуре §1 (3 таблицы), стиль 0011:
докстринг с блоками, чистый DDL, симметричный downgrade. Без backfill.

---

## S1 — миграция, парсер, fingerprint, matching, POST/GET/GET rows/DELETE

Новые файлы: `alembic/versions/0012_statement_imports.py`;
`models/statement_import.py` (обе таблицы одним модулем — живут и умирают вместе);
`models/bank_category_map.py`; `services/statement_import/{__init__,types,priorbank,fingerprint,matching}.py`;
`routers/statement_imports.py`; `tests/test_statement_parser.py`,
`tests/test_statement_matching.py`, `tests/test_statement_imports_api.py`,
`tests/fixtures/statement_priorbank_synthetic.csv` (cp1251-байты).
Правки: `app.py` (mount + CORS ничего), `docs/backend.md` — при закрытии скоупа.

Ключевые решения:
- **Декод**: `data.decode("cp1251")`; `UnicodeDecodeError` → STATEMENT_PARSE_FAILED.
  Порядок гейтов POST: auth → account (404/422) → size (читаем limit+1 байт) →
  format (реестр PARSERS) → parse → currency (шапка `Валюта счета:` vs счёт) → БД.
- **State machine**: `Операции по <mask>` открывает секцию (1-я = contract,
  2-я = card — по порядку, mask только в raw: в файле контракт-секция подписана
  маской КАРТЫ, сопоставление по номеру ненадёжно); следующая строка — заголовок
  колонок, сверяется по префиксу `Дата транзакции;Операция;` (защита от дрейфа
  формата → PARSE_FAILED, не мусор в БД); `Всего по…`/`Всего в данной валюте` —
  строка-метка + строка-значения, обе пропускаются, секция закрывается;
  `Заблокированные суммы по` → режим счёта строк (даты-строки считаем, ничего
  не парсим — сетка другая). Строка операции распознаётся регэкспом даты
  `^\d{2}\.\d{2}\.\d{4}` — всё прочее вне секций игнорируется.
- **Числа**: `Decimal(cell.replace("\xa0","").replace(" ","").replace(",","."))`
  → minor по экспоненте валюты выписки. Знак и kind — из «Обороты по счету»
  (кол. 7); amount_minor = abs. Нулевой оборот → skip + rows_zero_skipped.
- **Original-пара**: кол. 3–4, только когда Валюта ≠ валюте выписки; abs;
  minor по экспоненте ЕЁ валюты (PLN=2, но не хардкод).
- **Время**: `00:00:00` → txn_time NULL. Description: `.strip()` в canonical и
  в хранении (в файле хвостовые двойные пробелы), raw хранит ячейки как есть.
- **fingerprint.py**: NS-UUID константа; canonical §3 дословно; occ_index через
  `defaultdict(int)` по canonical-без-индекса в порядке файла.
- **matching.py** — чистая: вход `list[ParsedRow]`, `list[TxCandidate]`
  (frozen dataclass: id, client_id, kind, amount_minor, occurred_at, merchant,
  is_transfer); выход — статусы/кандидаты. Кандидаты одним запросом: фильтр
  «любая нога счёта» как `_read_filters`, `occurred_at ∈ [period_from−1,
  period_to+1]`, только нужные колонки. Жадность §4: `sorted(rows, key=(txn_date,
  row_index))`, `taken: set[tx_id]` для exact; transfer-кандидаты допускаются
  только в similar (никогда exact-by-value).
- **POST — одна БД-транзакция**: delete supersede (parsed того же счёта) +
  lazy-delete parsed старше 7 дней (по created_at, user-scoped) + insert сессии
  и строк (`session.add_all`, chunks не нужны при ≤1000). 201 отдаёт сессию со
  счётчиками (по match_status — агрегатом в память из только что созданных строк).
- **Контракт**: openapi.json + schema.d.ts одним коммитом (`pnpm openapi`);
  прогон тестов ЧЕТЫРЁХ потребителей: apps/web, apps/mobile, packages/api-client,
  packages/mcp-server (дрейф-тесты allowlist/tools). MCP-allowlist не трогаем —
  fail-closed, эндпоинты не добавляются по построению.

Тесты (реально ломаемое):
- Парсер по синтетической cp1251-фикстуре (персональных данных нет; структура:
  шапка BYN, 2 секции с итогами, валютная строка `-1 800,00 PLN`/`-1 439,63 BYN`,
  два байт-идентичных дубля с `00:00:00`, нулевой оборот, «Заблокированные» 2
  строки): границы секций (итоги не стали операциями, счётчик строк точный),
  original-пара только у валютной строки, `1 800,00`→180000, время-NULL,
  blocked/zero посчитаны и не сохранены; не-cp1251 байты → PARSE_FAILED.
- fingerprint: дубли получают occ_index 0/1 и разные client_id; детерминизм
  (два прогона → байт-равные uuid).
- matching (чистые): exact-по-client_id бьёт exact-по-значению; exact по обеим
  датам; окно similar — граничные ±1 внутри, ±2 снаружи; жадное 1:1 (два дубля
  против одной транзакции → exact+new); transfer попадает только в similar.
- API: POST 201 и счётчики; повторный POST того же файла суперсидит сессию и
  даёт те же client_id; STATEMENT_CURRENCY_MISMATCH (USD-счёт); TOO_LARGE;
  чужой/несуществующий id → байт-идентичный 404 (GET/DELETE).

Риски: дрейф формата банка (застрахован строгой сверкой заголовка колонок);
занижение rows_blocked при пустой секции; NBSP vs пробел в тысячных (парсим оба).

Оценка S1: написание 80 / гейты (lint+mypy+pytest+контракт+4 потребителя) 25 /
верификация (ручной прогон на реальном файле из scratchpad, счётчики vs awk) 20.

---

## S2 — PATCH rows, bank_category_map, подсказки, apply, learning

Новые: `services/statement_import/apply.py`; `tests/test_statement_apply.py`.
Правки: `routers/statement_imports.py` (PATCH + POST apply), `priorbank.py`/POST
(заполнение suggested_category_id при parse: merchant-карта > bank-карта, обе
одним батч-select по ключам всех строк — не по-строчно), контрактная пара.

Ключевые решения:
- PATCH: гейты — 404 сессии → 422 IMPORT_FINISHED → 404 строки (no-oracle оба
  уровня: фильтр import_id+row_id одним запросом) → категория через
  `category_access` → DECISION_NEEDS_MATCH. `category_user_set=true` ставится
  только когда PATCH несёт category_id (принятие подсказки без изменения — тоже
  PATCH с явным category_id: гейт честный).
- **Apply — одна транзакция, батчевый B-1**: (1) один select существующих
  client_id по списку (до 1000 значений — IN по частичному индексу) →
  already_existed; (2) profile и категории читаются один раз; (3) INSERT
  остальных строк decision=import объектами Transaction с инвариантами POST:
  currency со счёта, `auto_snapshot(amount, currency, base, txn_date)` (NULL-пара
  без курса — честно), original-пара как есть, merchant=description,
  occurred_at=txn_date; (4) replace_own: DELETE matched_tx (user-scoped) + INSERT;
  (5) learning-upsert'ы; (6) status=applied. IntegrityError на commit (гонка
  двойного apply) → rollback + ОДИН повтор всей процедуры: она идемпотентна по
  построению, повтор классифицирует победившие строки в already_existed.
- Learning: только строки `category_user_set`; distinct-пары в два ON CONFLICT-
  upsert'а (паттерн merchant_category_map); bank_category — stripped verbatim
  (у банка «Поставщик  услуг» с двойным пробелом — ключ байт-стабилен внутри
  формата, не нормализуем).
- Отчёт apply: created/skipped/replaced/already_existed — схема ответа POST apply.

Тесты: PATCH-гейты (finished; чужая категория = 404-код CATEGORY_NOT_FOUND
no-oracle; replace_own без матча); apply создаёт с валютой счёта и original-парой,
snapshot NULL без курса; повторный apply → 0 created, все already_existed;
learning пишет карты ТОЛЬКО с user_set-строк (контраст: принятая молча подсказка
не пишет); replace_own удалил старую и создал новую в одном заходе; skip не тронут.

Риски: двойной apply из двух вкладок (закрыт retry-циклом + статус-гейтом);
рост карт без чистки (принято: capped количеством категорий×мерчантов).

Оценка S2: написание 60 / гейты 20 / верификация 15.

---

## S3 — replace-preview, replace (FULL-ревью: деструктив)

Правки: `routers/statement_imports.py` (GET replace-preview, POST replace),
`apply.py` (общее ядро вставки переиспользуется — отбор другой), контрактная пара.
Новые: `tests/test_statement_replace.py`.

Ключевые решения:
- Валидация from_date: `X < period_from` ИЛИ `X > period_to` → 422
  REPLACE_FROM_OUT_OF_RANGE (второе — расширение архитектуры: пустой диапазон
  удаления при «заменить» — ошибка пользователя, не no-op).
- Preview: один grouped-select по delete-диапазону — total, с receipt_id, с
  goal_item_id, с recurring_template_id, transfer-останутся; will_create =
  count строк txn_date ≥ X. Никаких мутаций, повторяемо.
- Replace: одна транзакция: DELETE `user_id + account_id + kind != 'transfer' +
  occurred_at ∈ [X; period_to]` (source-нога: `account_id ==`, не «любая нога» —
  удалять по counter-ноге значило бы трогать транзакции чужого происхождения);
  затем вставка ядром S2 всех строк `txn_date ≥ X` (decision игнорируется —
  режим «заменить» весь диапазон); статус `replaced`, applied_at=now. Строки с
  client_id, уцелевшие вне диапазона или пережившие как transfer — разруливаются
  батчевым B-1 (already_existed), не дублируются.

Тесты: границы — транзакция на X−1 жива, на X удалена, на period_to удалена;
transfer внутри диапазона жив (и counter-нога чужого счёта нетронута);
`X < period_from` → 422; preview-счётчики с связями (receipt/goal_item/recurring);
повторный POST replace → 422 IMPORT_FINISHED; client_id вне диапазона не
задублирован повторной вставкой.

Риски: главный деструктив скоупа — ошибка в фильтре DELETE (закрыт тестами на
обе ноги и границы + FULL-тир); частичный commit исключён единственной
транзакцией; preview устаревает между показом и replace (принято: гонка
одного пользователя, replace пересчитывает отбор сам).

Оценка S3: написание 40 / гейты 15 / верификация 15.

---

## Open questions (для senior-lead, не блокируют S1)

1. `replace_own` при matched-транзакции kind=transfer: предлагаю 422
   TRANSFER_REPLACE_FORBIDDEN (удаление стёрло бы ногу второго счёта; пользователь
   удаляет перевод руками) — в архитектуре не оговорено.
2. `X > period_to` → 422 тем же кодом (см. S3) — расширение, нужно «ок».
3. Счётчики ответа GET /{id} по decision — считать на лету агрегатом (принято в
   плане) или денормализовать на сессию: на лету, ≤1000 строк.

---

## Дельта после PM-решений (architecture.md §10) — сведение senior-lead 2026-08-26

Вердикты по open questions: (1) TRANSFER_REPLACE_FORBIDDEN — принято;
(2) `X > period_to` тем же кодом — принято; (3) счётчики на лету — принято.
Отклонения S1 (секции по порядку) и батчевый B-1 — приняты.

Обязательные дополнения к плану (контракт см. §10 архитектуры):

**S1:**
- Миграция 0012: колонка `fee_minor` (BigInteger NOT NULL default 0, знак как в
  файле) в `statement_import_rows`; парсер заполняет из кол. 6 (minor по валюте
  выписки). Поле `fee_minor` в RowRead (§10.2).
- RowRead: деньги в форме TransactionRead (§10.1) + `candidates: []`
  мини-представлений через JOIN по candidate_tx_ids (§10.5) — вместо голых id.
- GET /{id}: счётчики в двух разрезах — match_status И decision (§10.4);
  201 POST отдаёт то же.
- STATEMENT_CURRENCY_MISMATCH: тело несёт statement_currency + account_currency
  (§10.7), схема домен-ошибки с полями в _UNPROCESSABLE-union.
- Первый шаг S1 после регенерации контракта: проверка multipart-типа в
  schema.d.ts и FormData-сериализации клиента (риск §10, не «в конце»).

**S2:**
- Новый маршрут POST `/statement-imports/{id}/rows/bulk-decision`
  (body: match_status, decision; ответ — счётчики §10.4; 404/422 IMPORT_FINISHED;
  MCP — НЕТ). Тест: bulk по similar не трогает exact/new и строки с
  category_user_set-выбором не сбрасывает (decision меняется, категория — нет).
- PATCH /rows/{row_id} возвращает обновлённый RowRead 200 (§10.3), не 204.

Поправка оценок: S1 +10 (candidates JOIN, fee, счётчики) → 90/25/20;
S2 +10 (bulk-decision + тест) → 70/20/15. Итого backend ≈ 325 агент-минут.

---

## Дельта S3 (сведение senior-lead 2026-08-27, по PM-риску §10 «подтверждение числом»)

План S3 выше не спустил принятое PM-решение о подтверждении. Обязательные
дополнения; имплементация следует им поверх исходного раздела S3.

1. **POST `/replace` требует `confirm_deleted_total: int` в body** рядом с
   `from_date`. Клиент присылает число из preview; сервер АТОМАРНО сверяет его
   с тем, что реально попадает под удаление СЕЙЧАС (сверка против фактически
   удаляемого набора в той же БД-транзакции; расхождение ⇒ rollback, ничего не
   удалено). Расхождение ⇒ 422 `REPLACE_CONFIRMATION_MISMATCH`, тело — схема
   домен-ошибки с полями в стиле §10.7: присланное число + актуальное
   серверное deleted_total (клиент перерисовывает preview). Галочка клиента —
   защита от опечатки, серверная сверка — от гонки «данные изменились между
   предпросмотром и подтверждением».
2. **`REPLACE_FROM_OUT_OF_RANGE` — обе границы** (`X < period_from` ИЛИ
   `X > period_to`), как принято в §10-сведении. Уже было в плане — остаётся.
3. **Preview тоже гейтится 422 `IMPORT_FINISHED`** (дополнение к таблице §6:
   там у preview только 404/OUT_OF_RANGE). Обоснование: preview по
   applied/replaced-сессии пересчитал бы ТОЛЬКО ЧТО СОЗДАННЫЕ транзакции как
   «удаляемые» — вводящее в заблуждение число поверх необратимой операции.
   Аддитивное расширение контракта, решение senior-lead.
4. **Дополнительные тесты** к списку S3: сверка числа отбивает расхождение
   (сеем транзакцию после «preview»-подсчёта ⇒ 422, ничего не удалено);
   повторный replace той же сессии ⇒ 422 IMPORT_FINISHED и ничего не удаляет
   вторично (уже было); preview на applied-сессии ⇒ 422.
