# statement-import — архитектура

Scope: импорт CSV-выписки Приорбанка в выбранный счёт. Мобилка вне скоупа.
Факты о формате и отображение на модель — в `task.md`, здесь не повторяются.

## 1. Таблицы (миграция 0012)

### statement_imports — сессия импорта
| колонка | тип | примечание |
|---|---|---|
| id | Uuid PK | |
| user_id | Uuid FK users CASCADE | скоупинг как везде |
| account_id | Uuid FK accounts CASCADE | выбранный счёт |
| status | String(16) CHECK | `parsed` / `applied` / `replaced` |
| source_format | String(32) | `priorbank_csv_v1` |
| filename | String(255) | для UI |
| statement_currency | String(3) | из шапки; уже сверена со счётом |
| period_from, period_to | Date | из шапки |
| rows_total | Integer | разобранных строк операций |
| rows_blocked | Integer | «Заблокированные суммы» — счётчик, строки НЕ храним |
| rows_zero_skipped | Integer | строки с нулевым оборотом — пропущены парсером |
| created_at, applied_at | DateTime(tz) | applied_at NULL пока parsed |

Индекс `(user_id, account_id)`. Заблокированные не сохраняются строками: их нельзя
применить никогда, а хранение потребовало бы nullable-почти-всё; счётчика для
«пропущено N, потому что не проведены» достаточно.

### statement_import_rows — разобранная строка
| колонка | тип | примечание |
|---|---|---|
| id | Uuid PK; import_id FK CASCADE | индекс (import_id, row_index) |
| row_index | Integer | порядок в файле, для стабильной пагинации |
| section | String(16) | `contract` / `card` — только для отображения |
| txn_date | Date | «Дата транзакции» (дата) |
| txn_time | Time NULL | NULL когда в файле 00:00:00 («время неизвестно») |
| booked_date | Date | «Дата операции по счету» |
| description | Text | «Операция» → станет `merchant` транзакции |
| bank_category | String(255) NULL | «Категория операции» |
| kind | String(16) | expense/income по знаку оборота |
| amount_minor | BigInteger | |оборот по счету|, валюта счёта |
| original_amount_minor, original_currency | BigInteger/String(3) NULL | пара из «Сумма»+«Валюта», только если валюта отличается |
| raw | JSONB | исходные ячейки (комиссия/money-back, цифровая карта…) — не теряем данные, не плодим колонки |
| client_id | Uuid | детерминированный отпечаток, см. §3; вычислен при parse |
| match_status | String(16) | `exact` / `similar` / `new` |
| matched_tx_id | Uuid FK transactions SET NULL, NULL | лучший кандидат |
| candidate_tx_ids | JSONB NULL | все кандидаты при `similar` |
| possible_transfer | Boolean default false | эвристика P2P (CH Debit/CH Payment) |
| suggested_category_id | Uuid FK categories SET NULL, NULL | подсказка |
| suggestion_source | String(16) NULL | `merchant` / `bank_category` |
| category_id | Uuid FK categories SET NULL, NULL | выбор пользователя (или принятая подсказка) |
| category_user_set | Boolean default false | true только после PATCH — гейт обучения |
| decision | String(16) | `import` / `skip` / `replace_own` |

### bank_category_map — зеркало merchant_category_map
PK `(user_id, bank_category)` → `category_id` FK categories CASCADE, `updated_at`.
Тот же upsert-паттерн `ON CONFLICT`.

## 2. Жизненный цикл сессии

```
POST (multipart) ── parse ok ──▶ parsed ──▶ applied   (путь «сверить»)
        │                          │
        └─ parse fail = 422,       └──────▶ replaced  (путь «заменить с даты X»)
           сессия НЕ создаётся
DELETE /{id} в статусе parsed → строка удаляется (отмена)
```

Отступление от брифа (обосновано): `uploaded`, `failed` и `reconciled` как
персистентные статусы не нужны. Разбор 1000 строк cp1251-CSV — миллисекунды,
делается синхронно в POST: невалидный файл — это 422 без строки в БД (нечего
чистить, нечего показывать), а «reconciled частично» — производное от решений на
строках, не состояние сессии. Меньше состояний — меньше недостижимых веток.

TTL/очистка без нового шедулера: POST нового импорта в тот же счёт удаляет
предыдущую `parsed`-сессию этого счёта (supersede), и тот же POST лениво удаляет
все `parsed`-сессии пользователя старше 7 дней. `applied`/`replaced` храним как
журнал (дёшево, полезно для «что я импортировал»).

## 3. Идемпотентность (пункт 2 грумминга)

`client_id = uuid5(NS_STATEMENT_IMPORT, canonical)`, где `NS_STATEMENT_IMPORT` —
зафиксированный в коде UUID, а canonical:

```
user_id | account_id | prior:v1 | section | txn_date ISO | txn_time("" если нет)
| booked_date ISO | signed_amount_minor | original_minor|original_ccy ("" если нет)
| description(strip) | bank_category | occ_index
```

`occ_index` — порядковый номер (0-based) СРЕДИ строк файла с байт-идентичным
canonical-без-индекса, НЕ глобальный номер строки: глобальный сломал бы
идемпотентность между перекрывающимися выписками (те же операции на других
позициях), а без индекса два одинаковых платежа схлопнулись бы в один.
`prior:v1` — версия отпечатка: починка парсера, меняющая canonical, обязана
явно поднять версию (осознанная ротация ключей, не тихая).

Повторная загрузка того же периода ⇒ те же client_id ⇒ POST-механика B-1
(select-first + частичный уникальный индекс) возвращает сохранённые строки — дублей
нет по построению.

## 4. Сопоставление (пункт 1)

Кандидаты: только транзакции выбранного счёта (обе ноги — фильтр как в
`_read_filters`), в окне дат. Три прохода, чистая функция в `matching.py`:

1. **exact по client_id**: существующая транзакция несёт client_id этой строки —
   повторная загрузка, точно по построению.
2. **exact по значению**: `amount_minor` и `kind` равны И `occurred_at ∈
   {txn_date, booked_date}` — ручной ввод датируется днём покупки, но пользователь
   мог ввести и днём проведения.
3. **similar**: сумма и kind равны, `occurred_at ∈ [txn_date−1; booked_date+1]`.
   Обоснование окна: −1 покрывает «ночную» покупку, записанную вчерашним днём;
   +1 после проведения — запись задним числом «когда увидел списание». Шире не
   надо: сумма без даты — слабый сигнал, ложные similar дороже пропусков.
   Плюс в кандидаты similar попадают **transfer-строки**, у которых нога данного
   счёта совпала по сумме в окне (записанный руками перевод против банковской
   P2P-строки — иначе гарантированный дубль).

**Жадное 1:1 (принято предложение оркестратора)**: строки обрабатываются в порядке
(txn_date, row_index); существующая транзакция может быть exact-матчем не более
одной строки — первая занимает, следующая деградирует до similar/new. Банк показал
два одинаковых платежа, у нас записан один ⇒ второй honestly new. Несколько
кандидатов ⇒ `similar` + `candidate_tx_ids`; ранжирование внутри списка — по
близости даты, затем по вхождению нормализованного merchant в description (текст —
только ранжирование, никогда не гейт).

Дефолтные decision: `new` → `import`; `exact` → `skip`; `similar` → `skip`
(безопасный дефолт «оставить своё», не плодим дубли молча; UI подсвечивает
similar как требующие взгляда, но apply не блокируется).

## 5. Категории банка (пункт 5) и P2P (пункт 6)

Подсказка при parse: `merchant_category_map` (по нормализованному description,
`domain/merchant.py`) **>** `bank_category_map` **>** пусто. Мерчант специфичнее
22 банковских корзин — он выигрывает.

Обучение — при **apply**, только для строк с `category_user_set = true` (то есть
пользователь явно выбрал/сменил категорию в PATCH): upsert в обе карты
(merchant_norm → category, bank_category → category). Пассивно принятая подсказка
не обучает — иначе карта самоподтверждается и ошибка закрепляется навсегда.

P2P (пункт 6, позиция принята): `description` начинается с `CH Debit`/`CH Payment`
⇒ `possible_transfer = true`. Авто-transfer невозможен (встречный счёт неизвестен,
kind потом не сменить — `KIND_CHANGE_UNSUPPORTED`). Дефолт — доход/расход; флаг
рисуется в предпросмотре, пользователь может поставить `skip` и создать перевод
руками. Честная цена v1.

Секции (пункт 7, позиция принята): контракт и карта — в один выбранный счёт;
`section` хранится только для отображения. Пересмотрим, если появится выписка,
где секции реально расходятся по деньгам.

## 6. Эндпоинты

Роутер `routers/statement_imports.py`, префикс `/statement-imports`, стиль ошибок
проектный (SCREAMING_SNAKE, `_UNPROCESSABLE`-union, no-oracle 404).

| Метод/путь | Назначение | Ошибки | MCP? |
|---|---|---|---|
| POST `/statement-imports` (multipart: file + account_id + format) | загрузить+разобрать+сматчить; 201 = сессия со счётчиками | 404 ACCOUNT_NOT_FOUND; 422 ACCOUNT_ARCHIVED, STATEMENT_TOO_LARGE (гейт 1 МБ до чтения, receipts-прецедент), STATEMENT_PARSE_FAILED, STATEMENT_CURRENCY_MISMATCH, STATEMENT_FORMAT_UNKNOWN; 429 (10/min) | НЕТ |
| GET `/statement-imports/{id}` | сессия + счётчики по match_status/decision | 404 IMPORT_NOT_FOUND | НЕТ |
| GET `/statement-imports/{id}/rows?offset&limit&match_status=` | предпросмотр, пагинация (limit ≤ 200) | 404 | НЕТ |
| PATCH `/statement-imports/{id}/rows/{row_id}` (decision, category_id) | решение пользователя | 404 (оба уровня no-oracle); 422 IMPORT_FINISHED, CATEGORY_NOT_FOUND/ARCHIVED, DECISION_NEEDS_MATCH (`replace_own` без matched_tx_id) | НЕТ |
| POST `/statement-imports/{id}/apply` | путь «сверить»: исполнить решения | 404; 422 IMPORT_FINISHED | НЕТ |
| GET `/statement-imports/{id}/replace-preview?from=` | посчитать удаляемое ДО подтверждения | 404; 422 REPLACE_FROM_OUT_OF_RANGE | НЕТ |
| POST `/statement-imports/{id}/replace` (body: from_date) | путь «заменить с даты X» | 404; 422 IMPORT_FINISHED, REPLACE_FROM_OUT_OF_RANGE | НЕТ |
| DELETE `/statement-imports/{id}` | отменить parsed-сессию, 204 | 404; 422 IMPORT_FINISHED | НЕТ |

**MCP — НЕТ для всех восьми, механикой allowlist**: пары в fail-closed allowlist
`pat_auth.py` просто не добавляются, роутер JWT-only. Обоснование по группам:
apply/replace — необратимые массовые мутации, AI-агенту недоступны по позиции PM
(поддерживаю: replace удаляет данные, apply создаёт сотни строк, у MCP-агента нет
экрана предпросмотра, значит нет и информированного подтверждения). Upload/GET/
PATCH/DELETE — безопасны по отдельности, но осмысленны только как подготовка к
apply, которого в MCP нет: полу-flow в MCP — приманка без выхода. Пересмотр
возможен отдельным решением, когда появится MCP-паттерн «подготовь — человек
подтвердит в UI».

## 7. Apply и Replace

**Apply** — сервисно (`services/statement_import/apply.py`), НЕ через HTTP POST:
батчу нужны одна БД-транзакция и единый отчёт, а не 1000 независимых HTTP-циклов
с индивидуальными 422. Инварианты создания повторяются вызовом ТЕХ ЖЕ хелперов,
что у POST /transactions: `currency` штампуется со счёта (валюта выписки уже
сверена при upload), `auto_snapshot` по `txn_date` (даёт NULL-пару без курса —
честно), original-пара кладётся как есть (CHECK-и проходят: пара ставится только
при отличающейся валюте; PLN легален — членства в SUPPORTED_CURRENCIES у пары
нет), `description` → `merchant`, категория — из `category_id` строки (валидность
проверена в PATCH). Каждый insert — под client_id с recover-паттерном B-1
(`ON CONFLICT`-гонка ⇒ re-select), так что повторный apply после сетевого обрыва
безопасен. Строки `decision=replace_own`: DELETE matched_tx (user_id-scoped) +
INSERT новой — в той же транзакции. Одна транзакция на весь apply; успех ⇒
`status=applied`, `applied_at=now`. Отчёт: created / skipped / replaced /
already_existed (идемпотентные повторы).

**Replace** — то же ядро, другой отбор. Границы: пользователь даёт `from_date=X`,
диапазон = `[X; period_to]`; `X < period_from` ⇒ 422 REPLACE_FROM_OUT_OF_RANGE
(удалять там, где выписка ничего не даст взамен, — потеря данных). Обе стороны
оперируют `occurred_at`/`txn_date` (дата транзакции: ей датируется и создаваемое,
и матчинг; txn_date ≤ booked_date ≤ period_to, так что верхняя граница честная).

Удаление: `user_id + account_id(source-нога) + kind != 'transfer' + occurred_at ∈
[X; period_to]`. **Transfer-строки не удаляются никогда** (позиция принята): одна
строка — обе ноги, удаление стёрло бы историю второго счёта; их число показывается
в preview отдельной строкой «останутся». Создание: строки выписки с `txn_date ≥ X`,
их client_id уже заняты? — B-1 replay внутри той же транзакции разрулит повтор.
Всё — одна БД-транзакция: delete + insert + status=`replaced`.

**Preview** (проверено по схеме: НИ ОДИН FK не смотрит НА transactions.id;
все связи — исходящие nullable-колонки самой строки): счётчики удаляемых всего /
с receipt_id (чек останется файлом, но отвяжется) / с goal_item_id (выпадут из
«paid» плана цели) / с recurring_template_id (потеря атрибуции) / transfer —
не удаляются / будет создано. Это ровно то предупреждение «до подтверждения»,
которое требует пункт 3 грумминга.

## 8. Модули

```
services/statement_import/
  __init__.py     # PARSERS: {"priorbank_csv_v1": PriorbankParser} — реестр
  types.py        # ParsedStatement / ParsedRow (frozen dataclasses)
  priorbank.py    # cp1251, ';', запятая-десятичная, пробел-тысячные, секции,
                  # пропуск итогов и «Заблокированных», нулевые обороты
  fingerprint.py  # NS-константа, canonical, occ_index
  matching.py     # чистая: (строки, кандидаты) -> статусы; без IO
  apply.py        # apply/replace: одна транзакция, B-1-вставки, learning
```

Интерфейс парсера: `parse(data: bytes) -> ParsedStatement` — второй банк
= новый модуль + строка в реестре; универсальный парсер не строим.

## 9. Порядок подзадач

1. **S1 (безопасная)**: миграция 0012 + parser + fingerprint + matching +
   POST/GET/GET rows/DELETE + контракт (openapi.json + schema.d.ts одним
   коммитом). Ничего не мутирует транзакции.
2. **S2**: PATCH rows + bank_category_map + подсказки + **apply** + learning.
3. **S3 (последняя)**: replace-preview + **replace**. Ревью-тир FULL (деструктив
   + миграции по классификации conventions.md).
4. **S4**: web-клиент (upload → предпросмотр → сверка/замена); может идти
   параллельно с S2 по контракту S1.

## Открытые вопросы (не блокируют S1)

- Колонка «Комиссия/Money-back»: лежит в `raw`; создавать ли отдельную строку
  расхода на комиссию — решение PM после взгляда на реальные значения.
- Показ `applied`-журнала в UI (история импортов) — вне scope, таблица готова.
- Ранжирование similar по тексту: строго ли нужна нормализация merchant для
  кириллических описаний банка — уточнить на реальных данных в S1.

## 10. Контрактные дельты — решения PM 2026-08-26 (поверх §1/§6, обязательны)

Приняты PM после вопросов веб-плана; сведение — senior-lead. Меняют контракт
S1/S2, имплементация обязана им следовать даже там, где planы писались раньше.

1. **Форма строки = форма транзакции.** `RowRead` в GET `/rows` несёт деньги в
   ТОЙ ЖЕ форме, что `TransactionRead`: `amount_minor`+`currency` (валюта счёта)
   + пара `original_amount_minor`/`original_currency`. Веб рендерит парой
   «потрачено/списано» существующим модулем, без адаптера.
2. **Комиссия — типизированное поле.** `fee_minor` (BigInteger, minor units,
   знак как в файле) — колонка `statement_import_rows` и поле `RowRead`, не
   только `raw`. В транзакцию при apply НЕ превращается (v1); клиент показывает
   только ненулевое. Разбор «1 800,00» — сервер, никогда клиент.
3. **PATCH `/rows/{row_id}` возвращает обновлённый `RowRead`** (200), не 204 —
   точечное обновление кеша вместо перезапроса до тысячи строк.
4. **Счётчики сессии в двух разрезах**: по `match_status` (exact/similar/new —
   «что нашлось») И по `decision` (import/skip/replace_own — «что произойдёт
   при apply»). Оба — в GET сессии; подтверждение apply опирается на второй.
5. **Кандидаты встроены в строку.** Вместо голых `candidate_tx_ids` `RowRead`
   несёт `candidates: []` мини-представлений (id, occurred_at, amount_minor,
   currency, kind, merchant, note) — ноль дополнительных запросов с экрана.
   `candidate_tx_ids` в таблице остаётся источником; JOIN на чтении.
6. **Отчёт apply/replace — только в теле ответа POST**, без персистентности (v1).
7. **STATEMENT_CURRENCY_MISMATCH называет обе валюты.** 422, строковый код
   остаётся, но тело несёт `statement_currency` и `account_currency` — в стиле
   проектного `_UNPROCESSABLE`-union (схема домен-ошибки с полями).
8. **Групповое решение — новый маршрут** POST
   `/statement-imports/{id}/rows/bulk-decision` (body: `match_status`,
   `decision`) — одно решение всем строкам статуса; ответ — счётчики §10.4.
   Ошибки: 404 IMPORT_NOT_FOUND, 422 IMPORT_FINISHED. MCP — НЕТ (как §6).

Риски, принятые PM: подтверждение replace — вводом ЧИСЛА удаляемых строк
(сброс при смене даты); селектор категорий в строках — ленивый (не тысяча
дропдаунов); multipart впервые в API — сериализацию через сгенерированный
контракт проверить В НАЧАЛЕ S1, не в конце.
