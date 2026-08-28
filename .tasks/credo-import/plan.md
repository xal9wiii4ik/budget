# Implementation Plan: Credo (Georgia) xlsx statement import

## Approach

Второй банк = новый модуль-парсер + строка реестра, ровно как обещала
`services/statement_import/__init__.py`. Ничего в роутере, матчере, моделях и
контракте не двигается; вся специфика Credo живёт в `credo.py`.

Формат читаем **openpyxl** (`read_only=True`, `data_only=True`): чистый Python,
только чтение, стриминг по строкам, без pandas/C-расширений. Альтернатива —
свой разбор zip+XML (общие строки, inline-строки, дыры в ссылках ячеек,
1900-эпоха) — это переписывание чужой библиотеки в файле, который читает деньги.
Проверено на настоящем файле: деньги — ТЕКСТОВЫЕ ячейки (`"15,355.04"`,
sharedStrings), даты — числовые serial со стилем `yyyy/MM/dd HH:mm:ss`. Из float
деньги не берём вообще: числовая ячейка в денежной колонке → `StatementParseError`.

Самопроверка по остатку — главный гейт качества разбора: `balance[i] ==
balance[i-1] − DB + Cr` в целых минорных единицах (никакой плавающей точки),
первая строка от `Opening Balance`, финальный остаток от `Closing Balance`, суммы
колонок от `Income`/`Expenses`. Всё это на реальном файле сходится ТОЧНО (73/73),
так что гейт не даёт ложных срабатываний и при этом ловит сдвиг колонки —
единственную поломку, которая иначе молча пишет неверные деньги.

Мерчант: парсер выделяет латинское имя (описание минус известный префикс минус
хвост `<amount> <CCY> <dd.mm.yyyy>`) в новое поле `ParsedRow.merchant`. Транспорт
до `apply` — КОЛОНКА `statement_import_rows.merchant` (миграция 0014) и поле
`RowRead.merchant`. Решение пересмотрено оркестратором после первого прохода —
см. «Решение: колонка вместо `raw["__merchant__"]`» ниже.

## Files to modify
- `apps/api/src/budget_api/services/statement_import/types.py` — `ParsedRow.merchant`
  (опциональное, default None) + общая функция `display_name(merchant, description)`.
- `apps/api/src/budget_api/services/statement_import/fingerprint.py` — версия канона
  становится свойством формата: `FINGERPRINT_VERSIONS = {prior→"prior:v1",
  credo→"credo:v1"}`, `client_ids(...)` получает 4-й аргумент `source_format`.
  `prior:v1` не двигается байт-в-байт.
- `apps/api/src/budget_api/services/statement_import/__init__.py` — строка в `PARSERS`.
- `apps/api/src/budget_api/services/statement_import/apply.py` — merchant транзакции:
  колонка `merchant` строки, если она не пуста, иначе прежний срез описания
  (для prior — байт-в-байт прежнее поведение).
- `apps/api/src/budget_api/routers/statement_imports.py` — `_build_rows` пишет
  колонку `merchant` (`raw` остаётся ячейками verbatim), `_serialize_row` её
  отдаёт (+ вызов `client_ids` с форматом).
- `apps/api/src/budget_api/models/statement_import.py` — колонка `merchant`.
- `apps/api/src/budget_api/schemas/statement_import.py` — поле `RowRead.merchant`.
- `apps/api/src/budget_api/services/statement_import/categories.py` — ключ
  merchant-карты = `normalize_merchant(display_name(merchant, description))`
  на обоих концах (подсказка и learning).
- `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts` — пара,
  перегенерирована `pnpm openapi`.
- `apps/api/pyproject.toml` + `uv.lock` — зависимость `openpyxl`.
- `apps/api/tests/helpers.py` — сборщик синтетического xlsx.
- `apps/api/tests/conftest.py` — фикстура `credo_xlsx_bytes` (session-scoped).
- `apps/api/tests/test_statement_matching.py` — пин канона `prior:v1` + версия по формату.
- `apps/api/tests/test_statement_apply.py` — один тест: applied-строка Credo несёт
  выделенного мерчанта, а не всё описание.

## New files
- `apps/api/alembic/versions/0014_statement_row_merchant.py` — nullable колонка
  `statement_import_rows.merchant`, без backfill и server_default.
- `apps/api/src/budget_api/services/statement_import/credo.py` — парсер `credo_xlsx_v1`.
- `apps/api/tests/test_statement_credo_parser.py` — тесты парсера.

## Code skeletons

```python
# credo.py
FORMAT_ID = "credo_xlsx_v1"
_DETAILS_SHEET, _TX_SHEET = "Account Details", "Transactions"
_HEADERS = ("Date", "Operation", "Turnover (DB)", "Turnover (Cr)", "Balance",
            "Description", "Beneficiary Name", "Beneficiary Account")
_PAIR_RE = re.compile(r"\s(\d+(?:\.\d+)?)\s([A-Z]{3})\s(\d{2}\.\d{2}\.\d{4})$")
_DESCRIPTION_PREFIXES = ("გადახდა", "განაღდება")   # оплата / снятие
_TRANSFER_STEMS = ("ჩარიცხვა", "კონვერტაცია")      # зачисление / конвертация

def parse(data: bytes) -> ParsedStatement: ...
def _details(sheet) -> dict[str, str]: ...          # label → value
def _money(cell: object, currency: str) -> int|None # текст → минорные; число → ошибка
def _serial_date(cell: object) -> date              # datetime | serial (1900)
def _merchant_and_pair(description, currency) -> tuple[str|None, int|None, str|None]
```

```python
# fingerprint.py
FINGERPRINT_VERSIONS: Mapping[str, str] = {
    priorbank.FORMAT_ID: "prior:v1",   # FROZEN — пиновый тест
    credo.FORMAT_ID: "credo:v1",
}
def client_ids(user_id, account_id, rows, source_format) -> list[uuid.UUID]: ...
```

Канон общий: у credo `txn_time=None`, `section` — фиксированный токен
(`StatementSection.card`, единственное, что позволяет CHECK миграции 0013),
`booked_date == txn_date`, описание — ОРИГИНАЛЬНАЯ грузинская строка.

## Тесты (ровно этот список)
`test_statement_credo_parser.py`: (1) serial-даты + текстовые деньги + знак из двух
колонок + счётчики/секция/валюта/период; (2) обе или ни одной колонки → отказ;
(3) самопроверка остатка называет строку расхождения; (4) мерчант и пара из
описания (YANDEX.EDA, кавычки, CHF вне SUPPORTED, валюта пары == валюте счёта →
пара None); (5) неизвестная грузинская фраза — данные, не ошибка + possible_transfer;
(6) числовая денежная ячейка → отказ; (7) сдвиг шапки колонок → отказ.
`test_statement_matching.py`: (8) пин канона `prior:v1` (литеральный uuid);
(9) версия канона — свойство формата (каждый парсер в `FINGERPRINT_VERSIONS`,
одна и та же строка под двумя форматами → разные id).
`test_statement_apply.py`: (10) applied Credo-строка несёт мерчанта `YANDEX.EDA`;
(11) merchant-карта читается и пишется по вырезанному имени, а не по фразе с
суммой и датой.
`test_statement_imports_api.py`: (12) предпросмотр отдаёт `merchant` (Credo —
имя, строка без имени и все строки Приорбанка — `null`).
`test_statement_credo_parser.py` №6 усилен: отказ по числовой денежной ячейке
называет ПРИЧИНУ («банк выгрузил суммы числами, а не текстом») и не тащит саму
ячейку в лог.

## Решение: колонка вместо `raw["__merchant__"]` (оркестратор, 2026-08-28)

Аварийный люк не принят, все три Open questions закрыты одной правкой.

- **Предпросмотр обязан показывать то, что будет создано.** Мерчант влияет на
  результат apply (под каким именем встанет транзакция), а `RowRead` о нём не
  знал: экран показывал предложение целиком, имя было видно только постфактум
  в списке транзакций. Ключ внутри `raw` невидим и для клиента, и для запроса.
- **Подсказки категорий.** `merchant_category_map` ключуется по
  `normalize_merchant(display_name)`; пока имя не было полем, ключом Credo-строки
  была вся фраза с суммой и датой — уникальная на каждую покупку, то есть карта
  для Credo не работала вовсе. Схлопывает бывший follow-up №3.
- **Миграция сейчас бесплатна.** Credo-строк в базе ноль (формат едет в этом же
  скоупе): 0014 — чистый `ADD COLUMN NULL` без backfill и server_default. Позже
  та же колонка была бы правкой живых предпросмотров.

Что НЕ поменялось: отпечаток (канон — производная описания, мерчант в него не
входит; пин `prior:v1` зелёный), `raw` вернулся к «ячейки verbatim», поведение
Приорбанка байт-в-байт прежнее (`merchant IS NULL` → используется описание).
Одна функция `types.display_name(merchant, description)` на оба конца — apply
(имя транзакции) и categories (ключ карты), чтобы они не могли разойтись.

Смена контракта: `RowRead.merchant: string | null`, пара
`openapi.json` + `schema.d.ts` перегенерирована `pnpm openapi`.

### Дефект QA: мерчант трёхзначен (правка после первого прохода)

Первая версия знала два значения — имя и `None` «описание и есть имя», — и
Credo-строка без известного префикса («Currency Exchange», незнакомая грузинская
фраза, комиссия) попадала во второе: описание-ПРЕДЛОЖЕНИЕ уезжало целиком в
`transactions.merchant`. Такого мерчанта банк не называл, это наша выдумка, и она
всплывала в топе мерчантов и в ключе merchant-карты. Семантику `None` не трогали
(живые данные Приорбанка обязаны остаться байт-в-байт), вместо этого поле стало
ТРЁХЗНАЧНЫМ, и три значения — это три РАЗНЫХ утверждения:

- имя → под ним и создаётся транзакция;
- `""` → «парсер посмотрел, мерчанта в этой строке нет». `credo._merchant`
  возвращает `str` всегда и `None` никогда: нет известного префикса, пустой
  остаток после префикса, пустое описание — всё это `""`. Дальше работает уже
  существующий контракт: `clean_merchant("")` → NULL-мерчант транзакции,
  `normalize_merchant("")` → пустой ключ, который обе стороны карты
  (`suggest_categories`, `learn_categories`) и так пропускают — фраза-предложение
  ничему не учит;
- `None` → «формат имён не выделяет вовсе, описание и есть имя»: прежний запасной
  путь, весь Приорбанк.

`types.display_name` поэтому предпочитает колонку, когда она НЕ `None`, ВКЛЮЧАЯ
пустую строку (проверка `.strip()` убрана — она склеивала два разных ответа в
один). Трёхзначность обязана пережить БД: `router._build_rows` пишет
`row.merchant` verbatim, `String(255)` хранит `""` как `""`, `_serialize_row`
отдаёт его как есть — apply читает значение ИЗ строки БД, и схлопывание `""` в
NULL по дороге вернуло бы дефект.

Контракт при этом НЕ менялся: тип поля прежний (`string | null`), а `#:`-комменты
Pydantic в `openapi.json` не попадают (у схем нет `use_attribute_docstrings`) —
перегенерация показала нулевой diff, пара не трогалась.

## Open questions
1. `STATEMENT_PARSE_FAILED` доезжает до клиента ГОЛЫМ кодом — текст причины
   («банк выгрузил суммы числами, а не текстом») живёт только в сообщении
   исключения и в логе роутера. Расширять тело ответа причиной парсера — не в
   этом скоупе; если это нужно пользователю, это отдельный груминг.
2. Веб `RowRead.merchant` пока не рисует: поле в контракте есть, экран
   предпросмотра его не показывает. Отдельная задача фронтенду.

## Risks
- openpyxl сам конвертирует ячейку с датовым numFmt в `datetime` — парсер обязан
  принимать И `datetime`, И числовой serial, иначе на чужом экспорте упадёт.
- Ложное срабатывание самопроверки на файле с округлениями: считаем в целых
  минорных единицах, на настоящем файле 73/73 сходится точно.
- Смена сигнатуры `client_ids` затрагивает 15 мест в существующих тестах —
  механически, но `prior:v1` обязан остаться байт-в-байт (пин №8).
- CHF вне `SUPPORTED_CURRENCIES` — допустимо для `original_currency` (гейт только
  на базовую валюту), экспонента по фолбэку 2.
