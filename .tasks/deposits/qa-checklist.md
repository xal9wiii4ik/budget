# QA-чеклист: скоуп `deposits` (API-уровень) — 9 сценариев

## Scope

Проверяем ЖИВЬЁМ только то, чего pytest доказать не может: сквозной денежный путь
вклада на реальном HTTP (создание задним числом → перевод → проценты → налог →
матурация → архив), герметичность deposit-счёта поверх собранного приложения и
цифры, которые складываются из нескольких источников (баланс счёта + агрегаты +
начисление). Формулы капитализации, границы валидации, коды ответов на кривой ввод
— целиком pytest бэкенда (см. «Не входит в живой прогон» внизу).

Потолок скоупа 12–15 сценариев делится с web-qa: здесь **9 API-сценариев**, остаток
уходит в веб-чеклист (вкладка, кнопка «рассчитать», индекс имён контрагентов).

Ссылки на решения: `.tasks/deposits/task.md`, `.tasks/deposits/architecture.md`
(§ «Поведение счетов типа deposit», § «Расчёт процентов», § «Ручная правка»,
§ «Налог», § «Эндпоинты и MCP/PAT allowlist», § «Ошибки», AMENDMENT п.1).

## Правила прогона (QA cadence 2026-08-18/19)

- Полный live-прогон — **ОДИН раз в конце скоупа**. Mid-scope гоняются только
  сценарии с пометкой **[stop-probe]**: `D1` и `D3` (самые денежные швы —
  начисление задним числом и «перевод ≠ трата»).
- **LOGIN ONCE**: `qa-dep-a@budgetqa.dev` (владелец) и `qa-dep-b@budgetqa.dev`
  (чужой) логинятся один раз в начале прогона, токены переиспользуются во всех TC.
  Повторный логин — только если сценарий про сам auth (таких здесь нет).
- Реальные данные пользователя не трогаем: только `qa-*@budgetqa.dev`.
- API `http://localhost:8010`. Порты 8000 / 5433 / 8081 — чужие сервисы, не трогать.
- Имена полей `DepositRead` в командах ниже — по архитектуре; сверить с
  `openapi.json` на /test и поправить чеклист, а не гадать.

```bash
export BASE=http://localhost:8010
TOKEN_A=$(curl -s -X POST $BASE/auth/login \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'username=qa-dep-a@budgetqa.dev&password=Qa!Test1234' | jq -r '.access_token')
TOKEN_B=$(curl -s -X POST $BASE/auth/login \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'username=qa-dep-b@budgetqa.dev&password=Qa!Test1234' | jq -r '.access_token')
AUTH_A="-H \"Authorization: Bearer $TOKEN_A\""   # в командах пишем разворачивая
```

**Зависимости по порядку**: D1 создаёт вклад `$DEP1` и его `$ACC_DEP` — их
используют D2, D3, D4, D7, D8. D6 и D5 создают свои вклады. D9 — независим.

---

### D1 [stop-probe] — Создание задним числом: тело из `initial_balance_minor`, проценты считаются от `opened_on`

- **Суть**: главный денежный риск скоупа — вклад, открытый год назад, обязан
  показать накопленное СРАЗУ, и число обязано сходиться с посчитанным руками.
- **Данные (подобраны так, чтобы деление было точным)**: BYN, тело 1000.00
  (100000 минорных), ставка `10.95`, капитализация `none` (простой процент),
  `opened_on` = сегодня − 100 дней, `term_end` = null, налога нет.
  Ручной расчёт actual/365: `100000 × 0.1095 × 100/365 = 3000` минорных = 30.00 BYN.
- **Шаги**:
```bash
  OPENED=$(date -v-100d +%F)
  DEP1=$(curl -s -X POST $BASE/deposits -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d "{\"name\":\"QA back-dated\",\"currency\":\"BYN\",
      \"initial_balance_minor\":100000,\"rate_percent\":\"10.95\",\"capitalization\":\"none\",
      \"opened_on\":\"$OPENED\"}" | jq -r '.id')
  curl -s $BASE/deposits/$DEP1 -H "Authorization: Bearer $TOKEN_A" | jq
  ACC_DEP=$(curl -s $BASE/deposits/$DEP1 -H "Authorization: Bearer $TOKEN_A" | jq -r '.account_id')
```
- **Ожидание**: 201 на создании; в GET — `balance_minor = 100000` (тело приехало в
  `starting_balance_minor` счёта, не бэкдейт-переводом), `accrued_minor = 3000`
  РОВНО, `accrued_after_tax_minor = null`, `status = "active"`, `currency = "BYN"`,
  присутствует `account_id`. Список `GET /deposits` содержит ту же строку с теми же
  цифрами (список и деталь не расходятся).
- **Почему не pytest**: домен закрыт юнитами, но «create → сборка таймлайна из
  starting_balance → сериализация в ответ» проходит только целиком и только живьём.
- **Статус**: ✅ pass (2026-08-27, stop-probe) — 201; `opened_on=2026-05-19` (сегодня−100):
  `balance_minor=100000`, `accrued_minor=3000` ровно (= ручной actual/365),
  `accrued_after_tax_minor=null`, `status="active"`, `currency="BYN"`, `account_id` есть;
  строка списка `GET /deposits` байт-в-байт равна детали (`diff` пустой);
  `GET /transactions?account_id=$ACC_DEP` → `total=0` — тело пришло стартовым балансом,
  а не бэкдейт-переводом.

---

### D2 — Герметичность deposit-счёта: его нет в счетах, им нельзя управлять и на него нельзя тратить

- **Суть**: одна дыра в герметичности — и deposit-деньги протекают в пикеры,
  сводки и расходы; проверяем все четыре двери за один заход.
- **Шаги** (нужен `$ACC_DEP` из D1 и обычный счёт `$ACC_CARD` qa-a):
```bash
  curl -s $BASE/accounts -H "Authorization: Bearer $TOKEN_A" | jq "[.[]|select(.id==\"$ACC_DEP\")] , [.[]|.type] "
  curl -s -o /dev/null -w '%{http_code}\n' $BASE/accounts/$ACC_DEP -H "Authorization: Bearer $TOKEN_A"
  curl -s -X PATCH $BASE/accounts/$ACC_DEP -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d '{"name":"hack"}'
  curl -s -X POST $BASE/accounts -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d '{"name":"fake","type":"deposit","currency":"BYN","starting_balance_minor":0}'
  curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d "{\"kind\":\"expense\",\"account_id\":\"$ACC_DEP\",
      \"amount_minor\":1000,\"currency\":\"BYN\",\"occurred_at\":\"$(date +%F)\",\"category_id\":null}"
```
- **Ожидание**: список счетов НЕ содержит `$ACC_DEP` и вообще ни одного `type`
  = `deposit`; GET и PATCH по нему → **404** `{"detail":"ACCOUNT_NOT_FOUND"}`;
  POST /accounts с `type=deposit` → **422** (ошибка валидации схемы, не 500);
  expense на deposit-счёт → **422** `{"detail":"DEPOSIT_ACCOUNT_TRANSFER_ONLY"}`.
  Никаких строк в БД после отказов (повторный GET /deposits не изменился).
- **Почему не pytest**: pytest закроет каждую дверь по отдельности; живьём
  проверяем, что фильтр «type != deposit» реально в SQL списка на собранном
  приложении, а не в схеме ответа.
- **Статус**: ✅ pass (2026-08-27, финальный прогон) — deposit-счёт герметичен по всем дверям:
  `GET /accounts` → ровно 1 строка (`QA card`), ни одного `type="deposit"`; тот же список с
  `?include_archived=true` — тоже без deposit; `PATCH /accounts/$ACC_DEP` → **404**
  `{"detail":"ACCOUNT_NOT_FOUND"}`; `POST /accounts {"type":"deposit"}` → **422** (enum
  `Input should be 'card' or 'cash'`, не 500); expense на `$ACC_DEP` → **422**
  `{"detail":"DEPOSIT_ACCOUNT_TRANSFER_ONLY"}`; `GET /deposits` после всех отказов не изменился
  (150000 / 3000).
  Поправка чеклиста (не дефект): на `/accounts/{account_id}` в контракте есть **только PATCH**,
  поэтому GET и DELETE отвечают **405** `Method Not Allowed` — контрольная проверка на СВОЁМ
  счёте `$ACC_CARD` даёт тот же 405, значит oracle'а нет; ожидание «GET → 404» в шагах выше
  описывало несуществующий эндпоинт.

---

### D3 [stop-probe] — Перевод счёт → вклад: оба баланса поехали, расход НЕ вырос

- **Суть**: цифра, которую пользователь видит в сводке, складывается из трёх
  источников (баланс счёта, баланс вклада, агрегаты) — перевод на вклад обязан
  двигать первые два и НЕ трогать третий. Это же требование № 3 из task.md.
- **Шаги**:
```bash
  M=$(date +%Y-%m)
  curl -s "$BASE/transactions/summary?month=$M" -H "Authorization: Bearer $TOKEN_A" | jq '.expense_minor // .'
  curl -s "$BASE/stats/summary?period=month&month=$M" -H "Authorization: Bearer $TOKEN_A" | jq
  curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d "{\"kind\":\"transfer\",\"account_id\":\"$ACC_CARD\",
      \"counter_account_id\":\"$ACC_DEP\",\"amount_minor\":50000,\"counter_amount_minor\":50000,
      \"currency\":\"BYN\",\"occurred_at\":\"$(date +%F)\"}"
  # повторить оба GET summary/stats + GET /accounts + GET /deposits/$DEP1
```
- **Ожидание**: 201; баланс `$ACC_CARD` уменьшился ровно на 50000, `balance_minor`
  вклада = 150000; `expense`-итог в `/transactions/summary` и `/stats/summary` —
  **байт-в-байт тот же, что до перевода** (перевод режется одной точкой
  `tx_totals`, второй фильтрации нет); история вклада
  `GET /transactions?account_id=$ACC_DEP` отдаёт эту одну строку.
- **Побочная проверка того же захода**: `accrued_minor` вклада не скакнул задним
  числом на всю новую сумму — пополнение датировано сегодня, сегмент нулевой длины.
- **Почему не pytest**: агрегаты — сумма нескольких сервисов; их согласованность
  видна только на живом снимке до/после.
- **Статус**: ✅ pass (2026-08-27, stop-probe) — 201; `QA card` 193000 → 143000 (ровно −50000),
  `balance_minor` вклада 100000 → 150000; `/transactions/summary?month=2026-08` и
  `/stats/summary?period=month` байт-в-байт те же до и после (`expense_minor=195553` RUB,
  `diff` пустой на обоих) — перевод в расход не попал; `GET /transactions?account_id=$ACC_DEP`
  → ровно одна строка `kind=transfer` 50000/50000; `accrued_minor` остался 3000
  (пополнение датировано сегодня, сегмент нулевой длины).

---

### D4 — Ручной override: прогноз ПРОДОЛЖАЕТ от якоря, `null` возвращает расчёт

- **Суть**: сквозное правило проекта «ручное побеждает расчёт» на деньгах +
  omit/null-семантика PATCH. Ошибка здесь = пользователь видит цифру банка,
  которая назавтра врёт.
- **Шаги**:
```bash
  curl -s -X PATCH $BASE/deposits/$DEP1 -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d '{"accrued_override_minor":9999}'
  curl -s $BASE/deposits/$DEP1 -H "Authorization: Bearer $TOKEN_A" | jq '{accrued_minor,accrued_override_minor,accrued_override_as_of}'
  curl -s -X PATCH $BASE/deposits/$DEP1 -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d '{"name":"QA back-dated (renamed)"}'   # omit = keep
  curl -s -X PATCH $BASE/deposits/$DEP1 -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d '{"accrued_override_minor":null}'
```
- **Ожидание**: после установки — `accrued_override_as_of` = сегодня (ставит
  сервер, не клиент), `accrued_minor` = 9999 на сегодня (сегодня = якорь, набега
  ещё нет); после переименования override НЕ сброшен (omit = keep); после
  `null` — оба поля `null`, `accrued_minor` вернулся к расчётному из D1/D3.
- **Почему не pytest**: доменный расчёт от якоря — юнит; здесь проверяется склейка
  «PATCH ставит дату сервера → чтение берёт якорь как базу» на реальном ответе.
- **Статус**: ✅ pass (2026-08-27, финальный прогон) — PATCH `accrued_override_minor=9999` → 200,
  `accrued_override_as_of="2026-08-27"` (сегодня, поставил сервер), `accrued_minor=9999` (якорь =
  сегодня, набега ещё нет); PATCH `{"name":"QA back-dated (renamed)"}` (override опущен) → override
  и якорь на месте (`9999` / `2026-08-27`), omit = keep; PATCH `accrued_override_minor=null` → оба
  поля `null`, `accrued_minor` вернулся к расчётному **3000** (ручной actual/365:
  100000×0.1095×100/365 = 3000; фикстурное пополнение 50000 датировано сегодня → сегмент нулевой
  длины, вклад в набег 0).

---

### D5 — No-oracle: чужой вклад неотличим от несуществующего

- **Суть**: инвариант проекта. Ответы обязаны совпасть **байт-в-байт**, иначе
  чужой id опознаётся по разнице.
- **Шаги** (qa-b лезет в `$DEP1` qa-a; и он же — в случайный UUID):
```bash
  RAND=$(uuidgen | tr 'A-Z' 'a-z')
  for U in $DEP1 $RAND; do
    curl -s -w '\n%{http_code}\n' $BASE/deposits/$U -H "Authorization: Bearer $TOKEN_B"
    curl -s -w '\n%{http_code}\n' -X PATCH $BASE/deposits/$U -H "Authorization: Bearer $TOKEN_B" \
      -H 'Content-Type: application/json' -d '{"name":"x"}'
  done
  curl -s $BASE/deposits -H "Authorization: Bearer $TOKEN_B" | jq 'length'
```
- **Ожидание**: все четыре ответа — **404** `{"detail":"DEPOSIT_NOT_FOUND"}`,
  тела и коды идентичны (сравнить `diff`); список qa-b не содержит вкладов qa-a;
  проверить также, что архивный чужой вклад не отвечает `DEPOSIT_ARCHIVED`
  (порядок guard'ов not-found → archived).
- **Почему не pytest**: pytest это проверит; живой прогон ловит расхождение,
  которое вносит middleware/сериализация (заголовки, порядок ключей) — то, чего
  TestClient-сравнение не всегда видит.
- **Статус**: ✅ pass (2026-08-27, финальный прогон) — 6 ответов qa-b (GET и PATCH по: чужому
  `$DEP1`, случайному UUID, чужому **архивному** вкладу) — все **404**
  `{"detail":"DEPOSIT_NOT_FOUND"}`, тела совпадают побайтно (`diff` пуст на всех парах), заголовки
  ответов тоже совпадают (сравнение без `Date`); архивный чужой вклад НЕ отвечает
  `DEPOSIT_ARCHIVED` — порядок guard'ов not-found → archived соблюдён; `GET /deposits` под qa-b →
  `[]` (length 0).

---

### D6 — Матурация: `term_end` в прошлом → `status=matured`, начисление заморожено на дате окончания

- **Суть**: после конца срока прогноз обязан перестать расти, иначе приложение
  врёт про деньги каждый день.
- **Шаги**: отдельный вклад: `opened_on` = сегодня − 200 дней, `term_end` =
  сегодня − 100 дней, тело 100000, ставка `10.95`, `capitalization=none`.
```bash
  DEP2=$(curl -s -X POST $BASE/deposits ... | jq -r '.id')
  curl -s $BASE/deposits/$DEP2 -H "Authorization: Bearer $TOKEN_A" | jq '{status,accrued_minor,term_end}'
```
- **Ожидание**: `status = "matured"`; `accrued_minor = 3000` — начисление за 100
  дней ДО `term_end`, а не за 200 (то есть равно значению D1, что и есть проверка
  заморозки); повторный GET на следующий прогон даёт то же число. Вклад остаётся
  в `GET /deposits` (не исчезает), переводы на него по-прежнему разрешены.
- **Почему не pytest**: `min(as_of, term_end)` — юнит; живьём ловим случай, когда
  `as_of` берётся не из серверного «сегодня» (TZ/наивная дата).
- **Статус**: ✅ pass (2026-08-27, финальный прогон) — вклад «QA matured», `opened_on=2026-02-08`
  (сегодня−200), `term_end=2026-05-19` (сегодня−100), тело 100000, ставка 10.95, `none`:
  `status="matured"`, `accrued_minor=**3000**` — ровно ручной расчёт до `term_end`
  (100000×0.1095×100/365 = 3000), а не 6000 за 200 дней ⇒ начисление заморожено на дате окончания;
  повторный GET даёт то же число; вклад присутствует в `GET /deposits`; перевод 1000 с `$ACC_CARD`
  на его счёт → **201**, `balance_minor` 100000 → 101000, `accrued_minor` остался 3000.

---

### D7 — Налог: `accrued_after_tax_minor` считает сервер, без ставки — `null`

- **Суть**: вторая денежная цифра в ответе; клиенту считать её запрещено, значит
  она обязана быть правильной и явно отсутствовать, когда ставки нет.
- **Шаги**: на `$DEP1` (override снят, `accrued_minor` = расчётный, налога нет —
  зафиксировать `G` = gross), затем:
```bash
  curl -s -X PATCH $BASE/deposits/$DEP1 -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d '{"tax_rate_percent":"13.00"}'
  curl -s $BASE/deposits/$DEP1 -H "Authorization: Bearer $TOKEN_A" | jq '{accrued_minor,accrued_after_tax_minor}'
  curl -s -X PATCH $BASE/deposits/$DEP1 -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d '{"tax_rate_percent":null}'
```
- **Ожидание**: с ставкой — `accrued_after_tax_minor = G − round_half_up(G × 0.13)`,
  посчитано руками для конкретного `G` (при G=3000 → 3000 − 390 = **2610**);
  `accrued_minor` (gross) НЕ изменился; после `null` — `accrued_after_tax_minor`
  = `null` (именно null, не равно gross и не 0).
- **Почему не pytest**: цифра, которую видит пользователь, собирается из расчёта +
  ставки; проверяем на живом ответе, что обе части ответа согласованы.
- **Статус**: ✅ pass (2026-08-27, финальный прогон) — база: `G = accrued_minor = 3000`,
  `accrued_after_tax_minor=null`. После PATCH `tax_rate_percent="13.00"`: `accrued_minor=3000`
  (gross не изменился), `accrued_after_tax_minor=**2610**` = 3000 − round_half_up(3000×0.13=390) —
  сходится с ручным; строка списка `GET /deposits` даёт те же две цифры. После PATCH
  `tax_rate_percent=null`: `accrued_after_tax_minor=null` (именно null, не 3000 и не 0),
  `tax_rate_percent=null`.
  Косметика (не дефект): ставка возвращается нормализованной — послано `"13.00"`, в ответе `"13"`
  (у `rate_percent` `"10.95"` сохраняется); отображение округлять/форматировать — на клиенте.

---

### D8 — Архив вклада: архивируется и счёт, перевод на него отбит существующим guard'ом

- **Суть**: архив вклада обязан закрыть денежную дверь; это единственная связка,
  где новая сущность опирается на СТАРЫЙ guard, — проверяем, что связка живая.
- **Шаги**:
```bash
  curl -s -X PATCH $BASE/deposits/$DEP1 -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d '{"archived":true}'
  curl -s -X POST $BASE/transactions -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d "{\"kind\":\"transfer\",\"account_id\":\"$ACC_CARD\",
      \"counter_account_id\":\"$ACC_DEP\",\"amount_minor\":1000,\"counter_amount_minor\":1000,
      \"currency\":\"BYN\",\"occurred_at\":\"$(date +%F)\"}"
  curl -s $BASE/deposits -H "Authorization: Bearer $TOKEN_A" | jq '[.[]|{id,archived,balance_minor}]'
```
- **Ожидание**: PATCH → 200, `archived=true`; перевод → **422**
  `{"detail":"ACCOUNT_ARCHIVED"}` (не `DEPOSIT_*`: дверь закрыл старый guard);
  вклад с ненулевым балансом архивируется УСПЕШНО (AMENDMENT п.3) и остаётся в
  списке с сохранённым `balance_minor`; deposit-счёт по-прежнему не виден в
  `GET /accounts` (архивация не «раскрывает» его в archived-inclusive списке).
- **Почему не pytest**: сшивка двух транзакционных изменений (deposit + account)
  и старого guard'а — межслойная, юнит её мокает.
- **Статус**: ✅ pass (2026-08-27, финальный прогон) — PATCH `{"archived":true}` на вкладе с
  НЕнулевым телом 150000 → **200**, `archived=true` (AMENDMENT п.3 держится); перевод 1000 на
  `$ACC_DEP` → **422** `{"detail":"ACCOUNT_ARCHIVED"}` — дверь закрыл старый account-guard, а не
  `DEPOSIT_*`; вклад остался в `GET /deposits` с сохранённым `balance_minor=150000` и
  `accrued_minor=3000`; `GET /accounts` (и с `?include_archived=true`) по-прежнему показывает
  только `QA card` — архивация не «раскрыла» deposit-счёт; баланс карты после отбитого перевода не
  изменился (149000 = 150000 − 1000 перевода из D6).

---

### D9 — PAT/MCP allowlist fail-closed: чтение вкладов есть, запись — нет

- **Суть**: новый эндпоинт впервые попадает в allowlist; ошибка здесь даёт агенту
  право заводить и править деньги.
- **Шаги** (PAT минтится JWT-ом qa-a, scope `read`):
```bash
  PAT=$(curl -s -X POST $BASE/tokens -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d '{"name":"qa-deposits","scope":"read"}' | jq -r '.token')
  curl -s -o /dev/null -w '%{http_code}\n' $BASE/deposits -H "Authorization: Bearer $PAT"
  curl -s -w '\n%{http_code}\n' $BASE/deposits/$DEP2 -H "Authorization: Bearer $PAT"
  curl -s -w '\n%{http_code}\n' -X POST $BASE/deposits -H "Authorization: Bearer $PAT" \
    -H 'Content-Type: application/json' -d '{"name":"pat","currency":"BYN","rate_percent":"5","capitalization":"none","opened_on":"2026-01-01"}'
  curl -s -w '\n%{http_code}\n' -X PATCH $BASE/deposits/$DEP2 -H "Authorization: Bearer $PAT" \
    -H 'Content-Type: application/json' -d '{"accrued_override_minor":1}'
```
- **Ожидание**: оба GET → **200** с теми же телами, что под JWT; POST и PATCH →
  **403** `{"detail":"TOKEN_ENDPOINT_FORBIDDEN"}` (именно endpoint-гейт, а не
  `TOKEN_SCOPE_READONLY` — эти пары в allowlist не заведены вовсе). Токен после
  прогона отозвать: `DELETE /tokens/{id}` под JWT.
- **Почему не pytest**: allowlist собирается по `route.path_format` собранного
  приложения — расхождение видно только на реально смонтированном роутере.
- **Статус**: ✅ pass (2026-08-27, финальный прогон) — PAT scope `read`: `GET /deposits` → **200**
  и `GET /deposits/$DEP2` → **200**, тела побайтно равны ответам под JWT (`diff` пуст на обоих);
  `POST /deposits` → **403** `{"detail":"TOKEN_ENDPOINT_FORBIDDEN"}` и `PATCH /deposits/$DEP2` →
  **403** тем же кодом (именно endpoint-гейт, не `TOKEN_SCOPE_READONLY`); побочных эффектов нет
  (список вкладов = 3 строки, все `accrued_override_minor=null`). Токен отозван:
  `DELETE /tokens/{id}` → **204**, повторный запрос под ним → **401** `{"detail":"TOKEN_INVALID"}`,
  в `GET /tokens` виден `revoked_at`.

---

## Не входит в живой прогон (закрыто pytest'ом бэкенда)

Отказ от проверки — решение, а не забывчивость. Против каждого — чем закрыт:

| Сценарий | Чем закрыт |
|---|---|
| Формулы compound (monthly/quarterly/at_maturity), капитализация в середине периода | юниты `domain/deposits.py` |
| Високосный год, actual/365, ставка 0, отрицательное тело (`max(principal,0)`) | юниты `domain/deposits.py` (границы перечислены в architecture.md) |
| `term_end <= opened_on` → 422 `DEPOSIT_TERM_BEFORE_OPENING` | тест роутера |
| `rate_percent < 0`, `tax_rate_percent` вне 0..100, `initial_balance_minor < 0` | тесты схем (стандартный 422) |
| CHECK «override_minor и override_as_of оба NULL или оба заданы» | тест миграции/модели |
| `DEPOSIT_ARCHIVED` (422) на PATCH своего архивного вклада | тест роутера |
| Скоупинг списка `GET /deposits` по `user_id` (кроме no-oracle детали в D5) | тест роутера |
| Идемпотентность повторного PATCH одним и тем же значением | тривиальна, покрыта семантикой PATCH проекта |
| Порядок enum `AccountType` и пересборка CHECK `type_valid` в 0012 | тест миграции |
| CORS preflight для новых путей | `tests/test_cors.py` (выводит верб-сет из OpenAPI) |
| Контрактная пара `openapi.json` + `schema.d.ts` | гейт сборки контракта |
| Рейт-лимит PAT, аудит `pat_audit_log` | покрыто скоупом 5.6 |

---

## Итог прогона

Полный прогон — в конце скоупа. Ниже — только mid-scope stop-probe после B1.

### Mid-scope stop-probe, 2026-08-27 (после B1)

- Прогнано: 2 из 9 (D1, D3) — только `[stop-probe]`, остальные не запускались.
- Пройдено: 2 (D1, D3). Провалено: 0. Заблокировано: 0.
- **Статус stop-probe**: ✅ денежные швы держатся, B1 можно продолжать.
- Отклонение чеклиста от контракта (исправлено здесь же): поле даты транзакции в
  `TransactionCreate` называется `occurred_at`, а не `date` — заменено в снипетах
  D2, D3, D8. Остальные имена `DepositRead`/`DepositCreate` сверены с
  `apps/api/openapi.json` и совпадают.
- Среда: alembic `0012` накатана на dev-БД `budget` (5443); API поднят на 8010 с
  `FX_SCHEDULER_ENABLED=false RECURRING_SCHEDULER_ENABLED=false`.
- Оставлено в dev-БД (для финального прогона): пользователи `qa-dep-a@budgetqa.dev`,
  `qa-dep-b@budgetqa.dev`; у qa-dep-a вклад «QA back-dated» + его скрытый счёт,
  счёт «QA card» (BYN, старт 200000), расход 70.00 и перевод 500.00 на вклад.

### Финальный live-прогон, 2026-08-27 (после W1)

- Прогнано: 7 из 9 (D2, D4, D5, D6, D7, D8, D9). D1 и D3 не переигрывались —
  засчитаны по stop-probe выше; их предметы (тело из `starting_balance`, «перевод ≠
  расход») воспроизведены здесь как фикстуры и сошлись: `accrued_minor=3000`,
  тело 100000 → 150000 после перевода 50000.
- Пройдено: **7**. Провалено: **0**. Заблокировано: **0**.
- **Статус: ✅ READY FOR REVIEW** — весь скоуп deposits: 9/9 pass.
- Находки (обе — cosmetic, кода не касаются):
  1. Чеклист (исправлен здесь же, D2): на `/accounts/{account_id}` есть только
     `PATCH`; GET/DELETE отвечают 405 для ЛЮБОГО счёта, включая свой, — oracle'а нет.
  2. `tax_rate_percent` возвращается нормализованным: послано `"13.00"` → в ответе
     `"13"` (D7). Функционально верно, вопрос форматирования на клиенте.
  Functional / major находок нет.
- Среда прогона (отклонение от шапки чеклиста, осознанное): API на
  **`http://localhost:8020`** поверх ОДНОРАЗОВОЙ БД `budget_qa_deposits`. Порт 8010 и
  рабочая БД `budget` не трогались (политика 2026-08-27 после инцидента с миграцией в
  рабочую базу). Прямых подключений к БД и alembic не было — только HTTP.
- Оставлено в `budget_qa_deposits` (уборка — за оркестратором): пользователи
  `qa-dep-a@budgetqa.dev`, `qa-dep-b@budgetqa.dev`; у qa-dep-a счёт «QA card» (BYN,
  старт 200000, итог 149000), вклады «QA back-dated (renamed)» (150000/3000, archived),
  «QA matured» (101000/3000, matured), «QA to-archive» (0/0, archived) + их скрытые
  deposit-счета; 2 перевода. PAT `qa-deposits` отозван (`revoked_at` проставлен).
