# QA-чеклист: скоуп `debts` (API-уровень) — 11 живых сценариев

## Scope

Проверяем ЖИВЬЁМ только то, чего pytest доказать не может: сквозной денежный путь
долга на реальном HTTP (выдал → частично вернули → закрыли → удалил), согласованность
трёх источников цифр (баланс счёта + агрегаты `/transactions/summary` + `remaining` долга)
и сводку в базовой валюте, которая складывается из курса, стороны и unconverted-счётчиков.
Формулы, границы валидации, коды на кривой ввод, скоупинг списков — pytest бэкенда
(см. «Не входит в живой прогон»).

Решения и контракт — `.tasks/debts/task.md`, `.tasks/debts/architecture.md`
(§ «Currency», § «Overpayment», § «Remaining, status, closed», § «Editing/deleting
через /transactions», § «Delete a whole debt», § Endpoints/Read models),
`.tasks/debts/grooming-review.md` (поправки senior-lead 1–4).

Потолок скоупа 12–15 делится с web-qa: здесь **11 API-сценариев** (CT-1…CT-11);
CT-0 — фикстура, CT-12 — уборка. Остаток потолка — в `qa-web-checklist.md`.

**💰 money-critical** (цифра, которую видит пользователь, собирается из нескольких
источников — провал здесь блокирует скоуп): CT-1, CT-2, CT-4, CT-6, CT-9, CT-10.

---

## Правила прогона (PM policy 2026-08-18/19/27)

- Полный live-прогон — **ОДИН раз в конце скоупа**, после B1 и W1. Mid-scope
  STOP-probe нет (решение grooming-review § QA cadence: внешних интеграций нет).
- Стенд **одноразовый**: API `http://localhost:8021`, БД `budget_qa_debts`
  (создать, накатить alembic туда). Рабочую БД `budget` (5443), порты 8010/5173
  НЕ трогать. Дроп базы — прерогатива оркестратора.
- Поднимать API с `FX_SCHEDULER_ENABLED=false RECURRING_SCHEDULER_ENABLED=false`.
- **LOGIN ONCE**: `qa-debts-a@budgetqa.dev` и `qa-debts-b@budgetqa.dev` логинятся
  один раз в CT-0, токены переиспользуются во всех TC. Повторный логин — только
  если сценарий про сам auth (таких здесь нет). Реальные данные пользователя не трогаем.
- Имена полей ниже — по `architecture.md`. На прогоне сверить с `apps/api/openapi.json`
  и **поправить чеклист**, а не гадать; расхождение имени — находка уровня cosmetic,
  расхождение поведения — дефект.

```bash
export BASE=http://localhost:8021
```

**Зависимости по порядку**: CT-0 → всё. CT-1 создаёт долг `$DEBT1` (BYN, lent) —
его используют CT-2, CT-3, CT-4, CT-7, CT-8, CT-10. CT-5 создаёт `$DEBT2` (USD,
borrowed) — его использует CT-6. CT-9 читает оба. CT-11 независим.

---

## Section A: pytest (owner — backend-engineer)

Темы, которые закрываются кодом в `tests/`; QA их не переигрывает живьём.
Разбор — в `architecture.md` (соответствующие §) и в плане B1.

1. **Движение по балансу**: `movement_kind` все четыре пары (direction × role) и
   знак в `account_balances` для каждой; баланс после principal/repayment/правки.
2. **Исключение из агрегатов**: `_NOT_TRANSFER_OR_DEBT` во всех четырёх проходах
   `tx_totals` + райдеры (stats, limits, tx summary, goals free balance, advisor).
3. **remaining / status / closed_on**: производные, в т.ч. «удаление возврата
   переоткрывает закрытый долг», правка закрытого (note/due/counterparty) разрешена.
4. **Переплата под FOR UPDATE**: `DEBT_REPAYMENT_EXCEEDS_REMAINING`,
   `DEBT_PRINCIPAL_BELOW_REPAID`, возврат по закрытому = тот же отказ.
5. **Валютная пара**: `DEBT_ACCOUNT_AMOUNT_REQUIRED` / `_NOT_APPLICABLE`,
   `AMOUNT_REQUIRED_ON_CURRENCY_CHANGE` на PATCH со сменой валюты счёта.
6. **Консистентность правки/удаления** движений через `/debts` (баланс + remaining
   в одной транзакции) + девять CHECK'ов 0017 и уникальность principal.
7. **Каскад**: `DELETE /debts/{id}` уносит движения; downgrade 0017 оставляет строки.
8. **No-oracle**: `load_own_debt` / `load_own_repayment` — чужой и отсутствующий
   через один `None`-путь, оба уровня (долг и возврат).
9. **Replay** `client_id` на POST /debts и POST репеймента (+ IntegrityError-арм).
10. **Push-семейство и щадящий replace**: `read_upcoming_due`, `DigestInput.debts`,
    счётчик, `_url`; statement-import spare + `debt_movements_kept` + отказ
    `DEBT_MOVEMENT_READONLY`; PAT/MCP пины (38→43 / 27→30, 20→22 / 35→40).

Статус: ⏸ pending — становится ✅, когда `make test` зелёный на прогоне.

---

## Section B: curl (owner — qa-engineer)

### CT-0 — Фикстура: два пользователя, два счёта, базовая валюта BYN

- **Суть**: один вход, одна база для всех остальных TC.
- **Шаги**:
```bash
  for E in qa-debts-a qa-debts-b; do
    curl -s -X POST $BASE/auth/register -H 'Content-Type: application/json' \
      -d "{\"email\":\"$E@budgetqa.dev\",\"password\":\"Qa!Test1234\"}" -w ' %{http_code}\n'
  done
  TOKEN_A=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/x-www-form-urlencoded' \
    -d 'username=qa-debts-a@budgetqa.dev&password=Qa!Test1234' | jq -r '.access_token')
  TOKEN_B=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/x-www-form-urlencoded' \
    -d 'username=qa-debts-b@budgetqa.dev&password=Qa!Test1234' | jq -r '.access_token')
  # база RUB по умолчанию -> ставим BYN: тогда BYN-сторона сводки конвертируется 1:1,
  # а USD-сторона честно зависит от наличия курса (предмет CT-9)
  curl -s -X PATCH $BASE/profile -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d '{"base_currency":"BYN"}' | jq '.base_currency'
  ACC_BYN=$(curl -s -X POST $BASE/accounts -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' \
    -d '{"name":"QA card","type":"card","currency":"BYN","starting_balance_minor":200000}' | jq -r '.id')
  ACC_USD=$(curl -s -X POST $BASE/accounts -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' \
    -d '{"name":"QA cash USD","type":"cash","currency":"USD","starting_balance_minor":50000}' | jq -r '.id')
  curl -s $BASE/accounts -H "Authorization: Bearer $TOKEN_A" | jq '[.[]|{name,currency,balance_minor}]'
```
- **Ожидание**: регистрации 201 (повтор — 400, не 500); оба токена непустые;
  `base_currency="BYN"`; два счёта 201 с `balance_minor` 200000 / 50000.
- **Статус**: ✅ (прогон 2026-10-12, стенд 8021 / `budget_qa_debts`)
  - регистрации 201/201, повторная — **400** `REGISTER_USER_ALREADY_EXISTS` (не 500);
    оба токена по 204 симв.; `base_currency="BYN"`; счета 201:
    `QA card` BYN `balance_minor=200000`, `QA cash USD` USD `50000`.
  - id: `ACC_BYN=c59d5d34-…88a7`, `ACC_USD=8b536a71-…1525`.

---

### CT-1 💰 — Выдача долга: деньги ушли со счёта, в расход НЕ попали

- **Суть**: главное требование task.md № 3. Три источника цифр обязаны разойтись
  ровно так: баланс −10000, расход 0, `remaining` 10000. Плюс движение без
  base-снапшота не должно протечь в `unconverted_count` сводки.
- **Method/Endpoint**: `POST /debts`
- **Body**:
```json
  {"direction":"lent","counterparty":"QA Петя","currency":"BYN","amount_minor":10000,
   "account_id":"$ACC_BYN","opened_on":"<сегодня>","note":"QA lend"}
```
- **Шаги**:
```bash
  M=$(date +%Y-%m); TODAY=$(date +%F)
  curl -s "$BASE/transactions/summary?month=$M" -H "Authorization: Bearer $TOKEN_A" \
    | jq '{expense_minor,income_minor,net_minor,unconverted_count}' > /tmp/sum_before.json
  DEBT1=$(curl -s -X POST $BASE/debts -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d "{\"direction\":\"lent\",\"counterparty\":\"QA Петя\",
      \"currency\":\"BYN\",\"amount_minor\":10000,\"account_id\":\"$ACC_BYN\",
      \"opened_on\":\"$TODAY\",\"note\":\"QA lend\"}" | jq -r '.id')
  curl -s $BASE/debts/$DEBT1 -H "Authorization: Bearer $TOKEN_A" | jq
  curl -s $BASE/accounts -H "Authorization: Bearer $TOKEN_A" | jq --arg a "$ACC_BYN" '.[]|select(.id==$a)|.balance_minor'
  curl -s "$BASE/transactions/summary?month=$M" -H "Authorization: Bearer $TOKEN_A" \
    | jq '{expense_minor,income_minor,net_minor,unconverted_count}' > /tmp/sum_after.json
  diff /tmp/sum_before.json /tmp/sum_after.json && echo SUMMARY-IDENTICAL
  curl -s "$BASE/transactions?account_id=$ACC_BYN" -H "Authorization: Bearer $TOKEN_A" \
    | jq '{total, rows:[.items[]|{kind,amount_minor,debt_id,category_id}]}'
```
- **Ожидание**: 201; в теле `principal_minor=10000`, `repaid_minor=0`,
  `remaining_minor=10000`, `status="open"`, `closed_on=null`, `repayments=[]`,
  `repayments_count=0`, `account_currency="BYN"`, `account_amount_minor=10000`.
  `GET /accounts`: баланс BYN-карты **190000** (ровно −10000).
  `/transactions/summary` до и после — **байт-в-байт тот же** (`expense_minor`
  остался 0, `unconverted_count` НЕ вырос — долг режется одной точкой `tx_totals`,
  а не попадает в «неконвертированные»). `GET /transactions?account_id=` отдаёт
  одну строку `kind="expense"` 10000 с непустым `debt_id` и `category_id=null`.
- **Почему живьём**: баланс и агрегаты — разные сервисы; их расхождение видно
  только на снимке до/после на собранном приложении.
- **Статус**: ✅ 💰
  - `POST /debts` → **201**; `GET /debts/{id}`: `principal_minor=10000`,
    `repaid_minor=0`, `remaining_minor=10000`, `status="open"`, `closed_on=null`,
    `repayments=[]`, `repayments_count=0`, `account_currency="BYN"`,
    `account_amount_minor=10000`, `opened_on=2026-10-12`, `due_on=null`.
  - баланс BYN-карты **190000** (−10000).
  - `/transactions/summary` до/после — `diff` пуст (`SUMMARY-IDENTICAL`):
    `expense_minor=0`, `income_minor=0`, `net_minor=0`, `unconverted_count=0`.
  - `GET /transactions?account_id=`: `total=1`, одна строка `kind="expense"`
    `amount_minor=10000`, `debt_id` непустой, `category_id=null`
    (`base_amount_minor=null`, `base_currency=null` — снапшота нет, и он НЕ протёк
    в `unconverted_count`).

---

### CT-2 💰 — Частичный возврат 40.00: остаток 6000, статус open, баланс +4000

- **Setup**: CT-1.
- **Method/Endpoint**: `POST /debts/$DEBT1/repayments`
- **Body**: `{"amount_minor":4000,"account_id":"$ACC_BYN","occurred_at":"<сегодня>"}`
- **Шаги**:
```bash
  curl -s -X POST $BASE/debts/$DEBT1/repayments -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d "{\"amount_minor\":4000,\"account_id\":\"$ACC_BYN\",
      \"occurred_at\":\"$TODAY\"}" -w '\n%{http_code}\n' | tee /tmp/rep1.json
  REP1=$(jq -r '.repayments[0].id' /tmp/rep1.json)
  curl -s $BASE/accounts -H "Authorization: Bearer $TOKEN_A" | jq --arg a "$ACC_BYN" '.[]|select(.id==$a)|.balance_minor'
  curl -s "$BASE/transactions/summary?month=$M" -H "Authorization: Bearer $TOKEN_A" | jq '{income_minor,expense_minor}'
```
- **Ожидание**: **201**; `repaid_minor=4000`, `remaining_minor=6000`,
  `status="open"`, `closed_on=null`, `repayments_count=1`, в `repayments` одна
  строка (`amount_minor=4000`, `account_amount_minor=4000`, `account_currency="BYN"`).
  Баланс карты **194000** (190000 + 4000). `income_minor` в сводке по-прежнему **0**
  (возврат полученных денег — не доход).
- **Статус**: ✅ 💰
  - **201**; `repaid_minor=4000`, `remaining_minor=6000`, `status="open"`,
    `closed_on=null`, `repayments_count=1`; `repayments[0]`: `amount_minor=4000`,
    `account_amount_minor=4000`, `account_currency="BYN"`, `occurred_at=2026-10-12`.
  - баланс карты **194000**; сводка `income_minor=0`, `expense_minor=0`.

---

### CT-3 — Переплата 70.00 при остатке 60.00 → 422, ничего не записано

- **Setup**: CT-2 (остаток 6000).
- **Method/Endpoint**: `POST /debts/$DEBT1/repayments`, body `{"amount_minor":7000,...}`
- **Ожидание**: **422** `{"detail":"DEBT_REPAYMENT_EXCEEDS_REMAINING"}`; после отказа
  `GET /debts/$DEBT1` не изменился (`remaining_minor=6000`, `repayments_count=1`)
  и баланс карты остался **194000** — отказ не оставил полузаписи.
- **Почему живьём**: pytest держит правило; живьём проверяется, что откат
  транзакции реально случился на боевом движке (`FOR UPDATE` + rollback), а не
  только в TestClient-сессии.
- **Статус**: ✅
  - **422** `{"detail":"DEBT_REPAYMENT_EXCEEDS_REMAINING"}`; после отказа
    `remaining_minor=6000`, `repaid_minor=4000`, `repayments_count=1`,
    `status="open"`, баланс карты **194000** — полузаписи нет, rollback реальный.

---

### CT-4 💰 — Добивающий возврат 60.00: closed, `closed_on`, баланс вернулся к старту

- **Setup**: CT-2/CT-3.
- **Method/Endpoint**: `POST /debts/$DEBT1/repayments`, body
  `{"amount_minor":6000,"account_id":"$ACC_BYN","occurred_at":"<сегодня>"}`
- **Ожидание**: **201**; `repaid_minor=10000`, `remaining_minor=0`,
  `status="closed"`, `closed_on` = дата последнего возврата (= сегодня),
  `repayments_count=2`. Баланс карты **200000** — ровно стартовый (деньги ушли и
  вернулись, долг закрылся: кольцо сходится). Долг остаётся в `GET /debts`
  (не исчезает). Правка закрытого разрешена: `PATCH /debts/$DEBT1
  {"note":"QA closed"}` → **200**, `status` остался `closed`.
- **Статус**: ✅ 💰
  - **201**; `repaid_minor=10000`, `remaining_minor=0`, `status="closed"`,
    `closed_on="2026-10-12"`, `repayments_count=2`; баланс карты **200000** —
    ровно стартовый (кольцо сошлось).
  - долг остался в `GET /debts` (`status=closed`, `remaining_minor=0`).
  - `PATCH {"note":"QA closed"}` → **200**, `status` остался `closed`,
    `closed_on` не сдвинулся.

---

### CT-5 — Заём в USD со сроком: деньги зачислились на USD-счёт

- **Method/Endpoint**: `POST /debts`
- **Body**:
```json
  {"direction":"borrowed","counterparty":"QA Банк Друга","currency":"USD",
   "amount_minor":20000,"account_id":"$ACC_USD","opened_on":"<сегодня>",
   "due_on":"<сегодня+3д>","note":"QA borrow"}
```
- **Ожидание**: **201**; `direction="borrowed"`, `principal_minor=20000`,
  `remaining_minor=20000`, `status="open"`, `due_on` проставлен; баланс USD-счёта
  **70000** (50000 + 20000 — заём зачисляет). В `GET /transactions?account_id=$ACC_USD`
  одна строка `kind="income"` с `debt_id`; `income_minor` сводки не вырос.
  Контроль `DEBT_DUE_BEFORE_OPENING` (тот же заход, отдельный POST с
  `due_on` = сегодня−1) → **422** `{"detail":"DEBT_DUE_BEFORE_OPENING"}`, долг не создан.
- **Сохранить**: `DEBT2=<id>`.
- **Статус**: ✅
  - **201**; `direction="borrowed"`, `currency="USD"`, `principal_minor=20000`,
    `remaining_minor=20000`, `status="open"`, `due_on="2026-10-15"`,
    `account_currency="USD"`, `account_amount_minor=20000`.
  - баланс USD-счёта **70000**; `GET /transactions?account_id=$ACC_USD`:
    `total=1`, `kind="income"` 20000, `debt_id` непустой, `category_id=null`;
    сводка `income_minor=0`.
  - `due_on`=сегодня−1 → **422** `{"detail":"DEBT_DUE_BEFORE_OPENING"}`,
    долг «QA Bad Due» в списке отсутствует (0 строк).

---

### CT-6 💰 — Кросс-валютный возврат: без второго amount отказ, с ним — две разные цифры

- **Суть**: единственное место, где одна строка несёт ДВЕ денежные величины
  (`amount_minor` в валюте долга, `account_amount_minor` в валюте счёта). Ошибка
  здесь = остаток долга считается в деньгах счёта, т.е. молча врёт.
- **Setup**: CT-5 (`$DEBT2`, USD-долг), BYN-карта `$ACC_BYN`.
- **Шаги**:
```bash
  curl -s -X POST $BASE/debts/$DEBT2/repayments -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d "{\"amount_minor\":5000,\"account_id\":\"$ACC_BYN\",
      \"occurred_at\":\"$TODAY\"}" -w '\n%{http_code}\n'
  curl -s -X POST $BASE/debts/$DEBT2/repayments -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d "{\"amount_minor\":5000,\"account_amount_minor\":17000,
      \"account_id\":\"$ACC_BYN\",\"occurred_at\":\"$TODAY\"}" -w '\n%{http_code}\n'
  curl -s $BASE/accounts -H "Authorization: Bearer $TOKEN_A" | jq '[.[]|{name,balance_minor}]'
```
- **Ожидание**: первый вызов → **422**
  `{"detail":"DEBT_ACCOUNT_AMOUNT_REQUIRED"}`, ничего не записано; второй → **201**,
  `remaining_minor=15000` (считается в USD, по `amount_minor`, НЕ 20000−17000),
  `repayments[-1]`: `amount_minor=5000`, `account_amount_minor=17000`,
  `account_currency="BYN"`. Баланс BYN-карты **183000** (200000 − 17000);
  USD-счёт не изменился (**70000**). Третий контроль того же захода: репеймент на
  USD-счёт **с** `account_amount_minor`, отличающимся от `amount_minor` → **422**
  `{"detail":"DEBT_ACCOUNT_AMOUNT_NOT_APPLICABLE"}`.
- **Статус**: ✅ 💰
  - (1) без `account_amount_minor` → **422** `{"detail":"DEBT_ACCOUNT_AMOUNT_REQUIRED"}`,
    долг не изменился (`remaining_minor=20000`, `repayments_count=0`).
  - (2) с `account_amount_minor=17000` → **201**; `remaining_minor=15000`
    (считается в USD по `amount_minor`, НЕ 20000−17000), `repaid_minor=5000`,
    `repayments[-1]`: `amount_minor=5000`, `account_amount_minor=17000`,
    `account_currency="BYN"`. Балансы: BYN **183000** (200000−17000), USD **70000**
    (не изменился).
  - (3) на USD-счёт с `account_amount_minor=3100 ≠ amount_minor=3000` → **422**
    `{"detail":"DEBT_ACCOUNT_AMOUNT_NOT_APPLICABLE"}`, `repayments_count` остался 1.

---

### CT-7 — Движение долга нельзя править/удалять через `/transactions`

- **Setup**: CT-1/CT-2 (id principal-строки и возврата `$REP1`).
- **Шаги**:
```bash
  TX_PRINCIPAL=$(curl -s "$BASE/transactions?account_id=$ACC_BYN" -H "Authorization: Bearer $TOKEN_A" \
    | jq -r --arg d "$DEBT1" '[.items[]|select(.debt_id==$d)][0].id')
  for ID in $TX_PRINCIPAL $REP1; do
    curl -s -X PATCH $BASE/transactions/$ID -H "Authorization: Bearer $TOKEN_A" \
      -H 'Content-Type: application/json' -d '{"amount_minor":1}' -w '\n%{http_code}\n'
    curl -s -X DELETE $BASE/transactions/$ID -H "Authorization: Bearer $TOKEN_A" -w '\n%{http_code}\n'
  done
```
- **Ожидание**: все четыре ответа **422** `{"detail":"DEBT_MOVEMENT_READONLY"}`;
  `GET /debts/$DEBT1` и балансы после попыток не изменились. Контроль: `TransactionRead`
  несёт `debt_id` (бейдж есть), но НЕ несёт `debt_amount_minor`/`debt_role`.
- **Почему живьём**: сторож стоит в ЧУЖОМ роутере сразу после 404 — проверяем на
  смонтированном приложении, что он не обойдён порядком зависимостей.
- **Статус**: ✅
  - все четыре ответа **422** `{"detail":"DEBT_MOVEMENT_READONLY"}`
    (PATCH+DELETE на principal-строке и на `$REP1`).
  - после попыток долг цел (`principal_minor=10000`, `repaid_minor=10000`,
    `remaining_minor=0`, `status="closed"`), балансы 183000 / 70000 не сдвинулись.
  - `TransactionRead` долговой строки несёт `debt_id` и НЕ несёт
    `debt_amount_minor` / `debt_role` (сверено по полному списку ключей).

---

### CT-8 — No-oracle: чужой долг и возврат неотличимы от несуществующих

- **Суть**: инвариант проекта; ответы обязаны совпасть **байт-в-байт**.
- **Шаги** (qa-b лезет в `$DEBT1`/`$REP1` qa-a и в случайные UUID):
```bash
  RAND=$(uuidgen | tr 'A-Z' 'a-z'); RAND2=$(uuidgen | tr 'A-Z' 'a-z')
  for U in $DEBT1 $RAND; do
    curl -s -D- -o /tmp/b_get_$U.txt $BASE/debts/$U -H "Authorization: Bearer $TOKEN_B" -w '%{http_code}\n'
    curl -s -X PATCH $BASE/debts/$U -H "Authorization: Bearer $TOKEN_B" \
      -H 'Content-Type: application/json' -d '{"note":"x"}' -w '\n%{http_code}\n'
    curl -s -X DELETE $BASE/debts/$U -H "Authorization: Bearer $TOKEN_B" -w '\n%{http_code}\n'
  done
  # второй уровень: свой/чужой долг + чужой/случайный возврат
  curl -s -X PATCH $BASE/debts/$DEBT1/repayments/$REP1 -H "Authorization: Bearer $TOKEN_B" \
    -H 'Content-Type: application/json' -d '{"amount_minor":1}' -w '\n%{http_code}\n'
  curl -s -X DELETE $BASE/debts/$DEBT1/repayments/$RAND2 -H "Authorization: Bearer $TOKEN_B" -w '\n%{http_code}\n'
  curl -s $BASE/debts -H "Authorization: Bearer $TOKEN_B" | jq '{n:(.items|length), summary}'
```
- **Ожидание**: ВСЕ ответы — **404** `{"detail":"DEBT_NOT_FOUND"}`, тела совпадают
  побайтно (`diff` по парам «чужой vs случайный» пуст), заголовки совпадают
  (сравнение без `Date`); на втором уровне чужой возврат тоже `DEBT_NOT_FOUND`
  (не `*_REPAYMENT_NOT_FOUND`, прецедент `IMPORT_NOT_FOUND`); `GET /debts` под qa-b →
  `items=[]`, `summary` с нулями и нулевыми unconverted-счётчиками (не null).
  Долг qa-a после всех попыток цел.
- **Статус**: ✅
  - 6 из 6 ответов qa-b (GET/PATCH/DELETE × {чужой `$DEBT1`, случайный UUID}) —
    **404** `{"detail":"DEBT_NOT_FOUND"}`; `cmp` тел «чужой vs случайный» пуст
    для всех трёх пар, заголовки (без `Date`) совпадают.
  - второй уровень: qa-b PATCH чужого возврата → **404** `DEBT_NOT_FOUND`;
    qa-b DELETE «чужой долг + случайный возврат» → **404** `DEBT_NOT_FOUND`;
    контроль — qa-a DELETE «свой долг + случайный возврат» тоже **404**
    `DEBT_NOT_FOUND` (не `*_REPAYMENT_NOT_FOUND`).
  - `GET /debts` под qa-b: `items=[]`, `summary` = нули
    (`base_currency="RUB"` — его собственный профиль, счётчики 0, не null).
  - долг qa-a после всех попыток цел (`note="QA closed"`, `status=closed`).

---

### CT-9 💰 — Сводка `GET /debts`: две стороны в базовой валюте + честные unconverted

- **Суть**: единственная цифра скоупа, собранная из трёх источников (остатки по
  открытым долгам + курс на сегодня + базовая валюта профиля). Нет курса — сторона
  обязана попасть в счётчик, а НЕ сложиться как ноль.
- **Setup**: CT-4 (BYN-долг закрыт), CT-6 (USD-долг borrowed, остаток 15000);
  плюс один открытый BYN-долг «мне должны» — создать здесь:
```bash
  DEBT3=$(curl -s -X POST $BASE/debts -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d "{\"direction\":\"lent\",\"counterparty\":\"QA Маша\",
      \"currency\":\"BYN\",\"amount_minor\":8000,\"account_id\":\"$ACC_BYN\",\"opened_on\":\"$TODAY\"}" | jq -r '.id')
  curl -s "$BASE/fx/convert?amount_minor=15000&from=USD&to=BYN" -H "Authorization: Bearer $TOKEN_A" -w '\n%{http_code}\n'
  curl -s $BASE/debts -H "Authorization: Bearer $TOKEN_A" | jq '{summary, items:[.items[]|{counterparty,direction,status,remaining_minor,currency}]}'
```
- **Ожидание**: `summary.base_currency="BYN"`;
  `owed_to_me_minor = 8000` (только ОТКРЫТЫЙ BYN-долг; закрытый из CT-4 в сумму
  НЕ входит, его остаток 0 и статус closed); `i_owe_minor` — остаток USD-долга
  **15000, сконвертированный в BYN** по курсу на сегодня, если курс в стенде есть
  (сверить с ответом `/fx/convert` тем же числом), иначе **0 при
  `i_owe_unconverted_count = 1`** — но никогда 15000 как BYN и никогда «0 без
  счётчика». `owed_to_me_unconverted_count = 0`. `items` содержит ВСЕ долги
  (открытые + закрытый), без `?status=`; строки списка по цифрам совпадают с
  деталями `GET /debts/{id}` (сравнить `remaining_minor`/`status`/`closed_on` на
  `$DEBT1` и `$DEBT2`).
- **Статус**: ✅ 💰
  - `summary.base_currency="BYN"`; `owed_to_me_minor=8000` (только ОТКРЫТЫЙ
    BYN-долг; закрытый из CT-4 не вошёл), `owed_to_me_unconverted_count=0`.
  - курса USD→BYN на одноразовом стенде НЕТ: `GET /fx/convert?…from=USD&to=BYN`
    → **200** `{"converted_minor":null,"rate":null,"rate_as_of":null}`.
    Соответственно сработала ветка exclude-and-flag: `i_owe_minor=0`
    **при** `i_owe_unconverted_count=1` — не 15000 как BYN и не «0 без счётчика».
  - `items` = 3 строки без `?status=` (два открытых + закрытый); цифры строк
    совпадают с деталями: `$DEBT1` `remaining=0/closed/closed_on=2026-10-12`,
    `$DEBT2` `remaining=15000/open/closed_on=null`.

---

### CT-10 💰 — `DELETE /debts/{id}`: 204, баланс откатился, движения исчезли

- **Setup**: `$DEBT3` из CT-9 (открыт, 8000 ушло с карты) — удаляем его, чтобы
  проверка «баланс вернулся к значению до долга» была чистой.
- **Шаги**:
```bash
  BEFORE=$(curl -s $BASE/accounts -H "Authorization: Bearer $TOKEN_A" | jq --arg a "$ACC_BYN" '.[]|select(.id==$a)|.balance_minor')
  curl -s -X DELETE $BASE/debts/$DEBT3 -H "Authorization: Bearer $TOKEN_A" -w '%{http_code}\n'
  curl -s $BASE/accounts -H "Authorization: Bearer $TOKEN_A" | jq --arg a "$ACC_BYN" '.[]|select(.id==$a)|.balance_minor'
  curl -s "$BASE/transactions?account_id=$ACC_BYN" -H "Authorization: Bearer $TOKEN_A" \
    | jq --arg d "$DEBT3" '{total, left:[.items[]|select(.debt_id==$d)]|length}'
  curl -s $BASE/debts/$DEBT3 -H "Authorization: Bearer $TOKEN_A" -w '\n%{http_code}\n'
  # и удаление возврата переоткрывает закрытый долг (производный статус)
  REP_LAST=$(curl -s $BASE/debts/$DEBT1 -H "Authorization: Bearer $TOKEN_A" | jq -r '.repayments[-1].id')
  curl -s -X DELETE $BASE/debts/$DEBT1/repayments/$REP_LAST -H "Authorization: Bearer $TOKEN_A" -w '%{http_code}\n'
  curl -s $BASE/debts/$DEBT1 -H "Authorization: Bearer $TOKEN_A" | jq '{status,closed_on,remaining_minor,repaid_minor}'
```
- **Ожидание**: DELETE → **204**; баланс карты = `BEFORE + 8000` (каскад вернул
  деньги в ТОЙ ЖЕ операции); ни одной строки с `debt_id=$DEBT3` в
  `/transactions?account_id=` и `total` уменьшился на 1; `GET /debts/$DEBT3` → **404**
  `DEBT_NOT_FOUND`. Удаление последнего возврата `$DEBT1` → **204**,
  долг снова `status="open"`, `closed_on=null`, `remaining_minor=6000`,
  баланс карты уменьшился на 6000 (деньги «не возвращены»).
- **Почему живьём**: откат балансов делает БД (ON DELETE CASCADE), а цифру считает
  сервис — согласованность двух слоёв видна только на реальном Postgres.
- **Статус**: ✅ 💰
  - `DELETE /debts/$DEBT3` → **204**, тело пустое; баланс карты 175000 → **183000**
    (`BEFORE+8000`); `/transactions?account_id=`: `total` 5→**4**, строк с
    `debt_id=$DEBT3` — **0**; `GET /debts/$DEBT3` → **404** `DEBT_NOT_FOUND`.
  - удаление последнего возврата `$DEBT1` → **204**; долг переоткрылся:
    `status="open"`, `closed_on=null`, `remaining_minor=6000`, `repaid_minor=4000`,
    `repayments_count=1`; баланс карты 183000 → **177000** (−6000).

---

### CT-11 — Replay `client_id`: второй POST не создаёт второй долг

- **Шаги**:
```bash
  CID=$(uuidgen | tr 'A-Z' 'a-z')
  for i in 1 2; do
    curl -s -X POST $BASE/debts -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
      -d "{\"direction\":\"lent\",\"counterparty\":\"QA Replay\",\"currency\":\"BYN\",
        \"amount_minor\":1500,\"account_id\":\"$ACC_BYN\",\"opened_on\":\"$TODAY\",\"client_id\":\"$CID\"}" \
      -o /tmp/replay_$i.json -w '%{http_code}\n'
  done
  jq -r '.id' /tmp/replay_1.json /tmp/replay_2.json
  curl -s $BASE/debts -H "Authorization: Bearer $TOKEN_A" | jq '[.items[]|select(.counterparty=="QA Replay")]|length'
  curl -s $BASE/accounts -H "Authorization: Bearer $TOKEN_A" | jq --arg a "$ACC_BYN" '.[]|select(.id==$a)|.balance_minor'
```
- **Ожидание**: первый вызов **201**, второй **200** с ТЕМ ЖЕ `id` (тела равны
  побайтно); в списке ровно **один** долг «QA Replay»; баланс карты сдвинулся
  на 1500 **один раз** (денежная сторона идемпотентности). Тот же replay на
  `POST /debts/{id}/repayments` (один `client_id`, два вызова) → 201, затем 200,
  `repayments_count` вырос на 1, `remaining` сдвинулся один раз.
- **Статус**: ✅
  - `POST /debts` #1 **201**, #2 **200** с тем же `id`, тела равны побайтно (`cmp`);
    в списке ровно **один** «QA Replay»; баланс 177000 → **175500** (−1500 один раз).
  - replay репеймента (`client_id` × 2): **201**, затем **200**, тела равны;
    `repaid_minor=500`, `remaining_minor=1000`, `repayments_count=1`;
    баланс 175500 → **176000** (+500 один раз).
  - контроль обратной стороны (вне исходного чеклиста): `client_id` обычной
    транзакции, переигранный на `POST /debts` → **422** `{"detail":"CLIENT_ID_IN_USE"}`,
    долг не создан — ожидаемо по реализации.
  - наблюдение (cosmetic, НЕ дефект): зеркальный случай асимметричен —
    `POST /transactions` с `client_id`, принадлежащим ДОЛГОВОМУ движению, отвечает
    **200** и отдаёт сохранённую долговую строку как `TransactionRead`
    (first-write-wins, новой строки и движения денег нет: `total` и баланс не
    изменились). Т.е. `/debts` отказывает кодом, а `/transactions` молча реплеит.

---

### CT-12 — Уборка

- Удалить свои долги: `GET /debts` → `DELETE /debts/{id}` по каждому (под qa-a),
  убедиться, что балансы счетов вернулись к стартовым (200000 / 50000).
- Удалений на уровне БД НЕ делать, базу `budget_qa_debts` НЕ дропать —
  доложить оркестратору список оставшегося (пользователи, счета, остатки).
- **Статус**: ✅
  - удалены все 3 оставшихся долга (`DELETE /debts/{id}` → 204 ×3);
    `GET /debts` → `items=[]`, `summary` нули.
  - балансы вернулись к стартовым: BYN **200000**, USD **50000**
    (`balance_minor == starting_balance_minor`); `/transactions` по обоим счетам
    `total=0`; `/transactions/summary` нули.
  - на уровне БД ничего не удалялось, базу не дропали.

---

## Не входит в живой прогон (закрыто pytest'ом бэкенда)

Отказ от проверки — решение, а не забывчивость. Против каждого — чем закрыт:

| Сценарий | Чем закрыт |
|---|---|
| Четыре пары (direction × role) → kind, знак в балансе | юниты `domain/debts.py` + PT-1 |
| `_NOT_TRANSFER_OR_DEBT` в stats/limits/goals free balance/advisor context | PT-2 (четыре прохода `tx_totals`) |
| `DEBT_PRINCIPAL_BELOW_REPAID` на PATCH principal | PT-4 (тест роутера) |
| Гонка двух возвратов под `FOR UPDATE` | PT-4 (конкурентный тест сервиса) |
| `ACCOUNT_NOT_FOUND` / `ACCOUNT_ARCHIVED` / `DEPOSIT_ACCOUNT_TRANSFER_ONLY` на движении долга | существующие `transaction_guards` + PT-6 (порядок гардов) |
| `DEBT_<FIELD>_REQUIRED` (null в NOT NULL), границы `amount_minor`, `counterparty` 100 симв., `currency` паттерн, unicode/длинные строки | тесты схем (стандартный 422) |
| Отсутствие `direction`/`currency` в `DebtUpdate` (иммутабельность) | тест схемы + контрактный гейт |
| Девять CHECK'ов 0017, уникальность principal, downgrade | тест миграции (PT-6/PT-7) |
| Скоупинг `GET /debts` по `user_id` (кроме no-oracle детали в CT-8) | тест роутера |
| Возврат по закрытому долгу (= та же переплата), возврат датой до `opened_on` (разрешён) | PT-3/PT-4 |
| Push-семейство: `read_upcoming_due`, окно «скоро», отсутствие сумм в `DigestInput`, счётчик `debts`, `_url` | PT-10 + FakePushSender |
| Statement-import: щадящий replace, `debt_movements_kept`, `DEBT_MOVEMENT_READONLY` на `replace_own` | PT-10 (тесты apply/preview) |
| CSV-колонка `debt_id`, пустые base-ячейки на debt-строках | тест экспорта |
| PAT allowlist / MCP tool counts (38→43, 27→30, 20→22, 35→40), `# MCP: no` на трёх маршрутах | `test_pat_auth.py` / `test_mcp_tools.py` (производные от маркеров) |
| CORS preflight новых путей | `tests/test_cors.py` (выводит верб-сет из OpenAPI) |
| Контрактная пара `openapi.json` + `schema.d.ts` | гейт сборки контракта |
| Auth 401 на `/debts/*` | общий dep роутеров, покрыт один раз в `test_pat_auth` |

---

## Итог прогона

- Прогнано: **11 из 11** (CT-1…CT-11) + CT-0 фикстура + CT-12 уборка.
- Пройдено: **13** / Провалено: **0** / Заблокировано: **0**.
- **Статус**: ✅ READY FOR REVIEW (API-часть скоупа). Все шесть 💰-сценариев
  (CT-1, CT-2, CT-4, CT-6, CT-9, CT-10) зелёные: три источника цифр — баланс
  счёта, агрегаты `/transactions/summary` и `remaining_minor` долга — ни разу
  не разошлись, долговые движения ни разу не попали в расход/доход.
- Среда: 2026-10-12, API `http://localhost:8021` (одноразовый стенд, схема
  `budget_qa_debts` @ alembic 0017, шедулеры off). Рабочую БД `budget` (5443)
  и порты 8010/5173 не трогали. LOGIN ONCE: по одному логину на qa-debts-a и
  qa-debts-b, токены переиспользованы во всех CT.
- Сверка имён полей с `apps/api/openapi.json` (п. «Правила прогона»): живой
  `/openapi.json` байт-в-байт равен репозиторному; все имена из чеклиста
  подтверждены (`DebtRead`/`DebtDetailRead`/`DebtRepaymentRead`/`DebtSummaryRead`,
  `SummaryRead.{expense_minor,income_minor,net_minor,unconverted_count}`,
  `FxConvertRead.{converted_minor,rate,rate_as_of}`). Расхождений имён нет,
  правок в чеклист по контракту не потребовалось.
- Отклонения от ожиданий чеклиста: одно, и оно свойство стенда, а не кода —
  в CT-9 курса USD→BYN на свежей базе нет, поэтому проверена ветка
  exclude-and-flag (`i_owe_minor=0` при `i_owe_unconverted_count=1`), а не ветка
  «сконвертировано по курсу». Конвертирующая ветка остаётся за pytest.
- Наблюдение уровня cosmetic (НЕ дефект, подробности в CT-11): `client_id`
  долгового движения, переигранный на `POST /transactions`, отвечает 200 и
  отдаёт долговую строку, тогда как обратное направление отвечает 422
  `CLIENT_ID_IN_USE`. Денег и строк не добавляется.
- Оставлено в `budget_qa_debts` (уборка — за оркестратором): два пользователя
  `qa-debts-a@budgetqa.dev` (base_currency переставлена на BYN) и
  `qa-debts-b@budgetqa.dev`; два счёта qa-a — `QA card` BYN 200000 и
  `QA cash USD` USD 50000, оба на стартовых балансах; системные категории
  миграции 0003 у обоих. Долгов, транзакций и долговых движений не осталось
  (`GET /debts` → `items=[]`, `/transactions` по обоим счетам `total=0`).
  Удалений на уровне БД не делалось, база не дропалась.
