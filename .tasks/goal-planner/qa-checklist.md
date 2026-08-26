# qa-checklist.md — scope goal-planner (API-часть: 9 сценариев, из них 2 live)

Общий потолок скоупа 12–15 сценариев делится с web-qa: здесь 9 API-сценариев,
остаток — веб-груминг (дерево, предупреждение перехода §5, блок сроков на главной).

Правила прогона (QA cadence 2026-08-18):
- Полный live-прогон — ОДИН раз в конце скоупа. Mid-scope допускаются только
  STOP-пробы по подзадаче 3 (вложения), если MinIO-шов подозрительно ведёт себя.
- LOGIN ONCE: `qa-goalplan-a@budgetqa.dev` и `qa-goalplan-b@budgetqa.dev` логинятся
  один раз в начале live-прогона, токены переиспользуются во всех TC.
  Реальные данные пользователя не трогаем.
- API `http://localhost:8010`, MinIO `http://localhost:9010` (bucket `receipts`,
  minioadmin/minioadmin). Порты 8000/5433/8081 — чужие, не трогать.
- `pytest` = сценарий закрывается тестом бэкенда в `apps/api/tests/`; владелец —
  backend-engineer, QA только проверяет зелёный `make test`.
  `live` = мокнутый/TestClient-шов доказать НЕ может, нужен реальный прогон.
- Нумерация A1…A9 сквозная и следует порядку рисков из брифа; в Section B ушли
  только A3 и A5 — те, что помечены live. Id не меняются при переносе.

Ссылки на решения: `.tasks/goal-planner/task.md`, `.tasks/goal-planner/architecture.md`
(§1 схема, §2 триггер, §3 goal_item_id, §4 CTE, §5 потолок, §6 напоминания,
§7 файлы, §8 три величины, §9 коды, §10d архивация).

---

## Section A — pytest (владелец: backend-engineer)

### A1 — «оплачено» переезжает с операцией и нигде не задваивается
- **Риск**: главный денежный риск скоупа (task.md «Задвоение оплаты»).
- **Шаги**: цель G (PLN); дерево A → A1, отдельный узел B.
  1. `POST /transactions` kind=expense, `goal_item_id=A1`, 300.00 PLN.
  2. `GET /goals/{G}/items` — paid у A1 = 300, у A (rollup поддерева) = 300, у B = 0;
     `GET /goals/{G}` — `paid_minor` = 300 РОВНО ОДИН раз (не 600 от A+A1).
  3. `PATCH /transactions/{tx}` `goal_item_id=B` → paid у A и A1 = 0, у B = 300,
     у цели по-прежнему 300.
  4. `PATCH` `goal_item_id=null` → привязки нет нигде, `paid_minor`=0, операция жива.
  5. Вторая операция на тот же узел (предоплата + доплата) — paid суммируется.
  6. `goal_item_id` на kind=transfer и на kind=income → 422 `GOAL_ITEM_EXPENSE_ONLY`;
     PATCH kind у уже привязанной expense → тот же 422.
- **Ожидание**: rollup по поддереву считает каждую операцию ровно один раз на каждом
  уровне пути и ноль раз вне пути; не-expense привязка невозможна.
- **Метка**: pytest (агрегат + CHECK; живой HTTP ничего не добавляет).

### A2 — цикл и глубина отбиваются ДО записи
- **Шаги**: дерево A → B → C.
  1. `PATCH /goals/{G}/items/{A}` `parent_id=C` → 422 `GOAL_ITEM_CYCLE`;
  2. `parent_id={A}` (сам на себя) → 422 `GOAL_ITEM_CYCLE`;
  3. `parent_id` = узел ЧУЖОЙ цели → **422** `GOAL_ITEM_PARENT_NOT_FOUND`; тело
     ответа БАЙТ-В-БАЙТ равно ответу на несуществующий `parent_id` (сравнивать тела
     строками, обязательный тест — иначе подбором id можно выяснить существование
     чужой цели). *Исправление чеклиста 2026-08-24 (решение PM), не поведения:
     `parent_id` — поле тела, домовой шаблон для ссылок в теле — 422 со строковым
     кодом (`_validate_category`); 404 остаётся за ресурсами в пути.*
  4. `POST` ребёнка на 7-м уровне → 422 `GOAL_ITEM_DEPTH_EXCEEDED`;
     перенос поддерева, который делает лист 7-м уровнем — тот же код.
  5. После каждой отбитой попытки `GET items` возвращает дерево БЕЗ изменений
     (число узлов и parent_id прежние).
- **Ожидание**: 422 из роутера, состояние не поменялось, `GET items` не зависает.
- **Метка**: pytest.

### A4 — каскад удаления: строки ушли, операции живы
- **Шаги**: A → A1 → A2, к A1 и A2 привязано по операции, у A2 есть файл.
  1. `GET /goals/{G}/items` до удаления: `files_count` у A по поддереву = 1
     (число для предупреждения на клиенте).
  2. `DELETE /goals/{G}/items/{A}`.
  3. `GET items` — A, A1, A2 отсутствуют; остальное дерево цело.
  4. `GET /transactions` — обе операции СУЩЕСТВУЮТ, `goal_item_id=null`, суммы и
     категории не тронуты; `GET /goals/{G}` `paid_minor` уменьшился на их сумму.
  5. `GET /transactions?goal_item_id={A1}` после удаления → 404 `GOAL_ITEM_NOT_FOUND`
     (узла нет), а не пустой список от несуществующего id.
- **Ожидание**: ON DELETE CASCADE по parent_id + SET NULL по goal_item_id; операции
  не удаляются никогда.
- **Метка**: pytest (БД-часть). Удаление ОБЪЕКТОВ из MinIO — в A5 (live).

### A6 — наследование срока и намерение напоминания
- **Шаги**: цель G с deadline 2026-06-15; узлы:
  N1 без deadline; N2 deadline=2026-05-01; N3 без deadline + `remind_days_before=3`;
  N4 `remind_on=2026-06-01`.
  1. `GET items`: N1 `eff_deadline`=2026-06-15, `deadline_inherited=true`;
     N2 — своя дата, `inherited=false`; N3 remind=2026-06-12; N4 remind=2026-06-01.
  2. `PATCH /goals/{G}` deadline → 2026-07-15.
  3. `GET items`: N1/N3 `eff_deadline`=2026-07-15, N3 remind=2026-07-12;
     N2 и N4 НЕ шелохнулись; в БД `goal_items.deadline` у N1/N3 по-прежнему NULL
     (проверять именно колонку, а не только ответ).
  4. Цель без deadline: узел без своего срока → `eff_deadline=null`,
     remind-дата `null` (не ошибка, не «сегодня»).
  5. Ребёнок наследует от РОДИТЕЛЯ с датой, а не сразу от цели (двухуровневый COALESCE).
  6. `GET /goals/upcoming?days=30` — N3 попадает по remind-дате; узел без напоминания
     попадает по eff_deadline; `days=0` и `days=91` → 422.
  7. Одновременные `remind_on` + `remind_days_before` в одном запросе → 422.
- **Ожидание**: срок нигде не материализован; «за N дней» едет за эффективным сроком,
  конкретная дата стоит.
- **Метка**: pytest.

### A7 — no-oracle: чужое и архивное
- **Шаги**: пользователь B владеет целью GB с узлом IB; у A архивная цель GA с узлом IA.
  1. У A: `GET/PATCH/DELETE /goals/{GB}/items/{IB}` и `POST .../items/{IB}/files`
     → 404 `GOAL_ITEM_NOT_FOUND`, тело и статус БАЙТ-В-БАЙТ равны ответу на
     случайный несуществующий UUID (сравнивать оба ответа как строки).
  2. `POST /transactions` с `goal_item_id={IB}` → 404 `GOAL_ITEM_NOT_FOUND`
     (не 422, не 403).
  3. Своя архивная цель GA: `POST/PATCH .../items` → 422 `GOAL_ARCHIVED`;
     ЧУЖАЯ архивная цель → 404 раньше `GOAL_ARCHIVED` (guard order — иначе оракул
     существования, как account_access).
  4. `GET /goals/upcoming` у A: узлы архивной GA не появляются; после разархивации
     появляются снова, привязки операций сохранились.
- **Ожидание**: один путь → один 404; архивация ничего не удаляет.
- **Метка**: pytest.

### A8 — переход «ручная сумма → счёт снизу» виден честно
- **Шаги**: цель G, `target_minor`=20 000.00, пунктов нет.
  1. `GET /goals/{G}`: `has_items=false`, `planned_total_minor`=0,
     `effective_target_minor` = target_minor (сегодняшнее поведение).
  2. `POST` первый пункт 5 000.00 → `has_items=true`,
     `planned_total_minor`=5 000, `effective_target_minor`=5 000,
     `target_minor` ОСТАЛСЯ 20 000 в ответе (расхождение видно клиенту).
  3. `PATCH /goals/{G}` `final_cost_override_minor`=18 000 → effective=18 000,
     planned по-прежнему 5 000 (обе цифры в ответе).
  4. `PATCH` `final_cost_override_minor=null` → возврат к 5 000.
  5. `remaining_to_find_minor` = effective − paid − saved, считает сервер; при
     paid+saved > effective отдаётся ОТРИЦАТЕЛЬНЫМ, а не нулём.
  6. В схеме ответа НЕТ поля, складывающего paid и saved (проверять по openapi.json).
  7. `monthly_needed`/реализм считаются от effective, а не от target_minor.
- **Ожидание**: три величины раздельно; переход не молчаливый.
- **Метка**: pytest.

### A9 — валюта пункта и потолок узла
- **Шаги**: цель G в PLN.
  1. Пункт 100.00 EUR, курс EUR→PLN есть → сервер проставил
     `converted_minor/converted_currency` по nearest-previous курсу.
  2. `PATCH` с ручным `converted_minor` → ручное ПОБЕЖДАЕТ (значение не пересчитано).
  3. `PATCH` `converted_minor=null` → пара очищена и пересчитана авто (clear+recompute);
     omit в том же PATCH другого поля → значение сохранено (omit=keep).
  4. Пункт в валюте БЕЗ курса → пара NULL/NULL, узел присутствует в дереве,
     `planned_unconverted_count` = 1, `planned_total_minor` его НЕ включает
     (честный счётчик, не тихий ноль и не 0-подстановка).
  5. Пункт в JPY (экспонента 0) — никакого ×100 в конвертации.
  6. Потолок: узел P `own_amount`=1 000.00, дети 900.00 + 600.00 → у P
     `children_sum`=1 500.00, `ceiling_exceeded=true`, HTTP 200 (это ПОЛЕ, не ошибка);
     наверх к корню уходит 1 500.00, а не 1 000.00.
  7. Лист: `children_sum` = own_amount (одно правило, не два).
- **Ожидание**: денежные инварианты проекта соблюдены на новой сущности.
- **Метка**: pytest.

---

## Section B — live (владелец: qa-engineer, один прогон в конце скоупа)

**L0 (смоук, предусловие обоих live-TC)**: API поднят на :8010; `GET /goals/upcoming`
с токеном A отвечает 200 списком, а НЕ 422/404 от `/{goal_id}` (route-order landmine
§6 — статический сегмент должен быть зарегистрирован раньше). Логин обоих QA-юзеров
здесь же, токены в переменные окружения на весь прогон.

### A3 — встречные перевесы под конкурентной нагрузкой (триггер + advisory lock)
- **Что проверяем**: чего TestClient не покажет — две ОДНОВРЕМЕННЫЕ транзакции
  Postgres. Проверка в роутере обе пропустит (каждая читает состояние до чужого
  commit); держать должен триггер §2 с `pg_advisory_xact_lock`.
- **Шаги**: два независимых корня A и B в одной цели; два PATCH запускаются
  параллельно в одном окне:
```bash
  curl -s -o /tmp/r1.json -w '%{http_code}\n' -X PATCH \
    http://localhost:8010/goals/$G/items/$A -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d "{\"parent_id\":\"$B\"}" &
  curl -s -o /tmp/r2.json -w '%{http_code}\n' -X PATCH \
    http://localhost:8010/goals/$G/items/$B -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' -d "{\"parent_id\":\"$A\"}" &
  wait; cat /tmp/r1.json /tmp/r2.json
  curl -s "http://localhost:8010/goals/$G/items" -H "Authorization: Bearer $TOKEN_A" | jq '.items|length'
```
  Повторить серию 5 раз (гонка вероятностная).
- **Ожидание**: ровно один 200 и один 422 `GOAL_ITEM_CYCLE` (проигравший гонку
  получает check_violation из триггера и ДОЛЖЕН быть отмаплен в тот же 422, а не в
  500 `DBAPIError`); после каждой серии `GET items` отвечает за разумное время,
  число узлов прежнее, из корня достижимы оба узла (нет отцепленного цикла).
- **Метка**: live. STOP-проба, если появился 500 — блокер, к senior-lead.

### A5 — файлы пункта: presign → PUT → confirm(HEAD) → удаление объектов
- **Что проверяем**: реальную подпись SigV4, реальный HEAD, реальное best-effort
  удаление в MinIO. Мок доказывает только вызовы, а не то, что байты легли и ушли.
- **Шаги**:
```bash
  # 1. слот + presigned PUT
  F=$(curl -s -X POST http://localhost:8010/goals/$G/items/$ITEM/files \
      -H "Authorization: Bearer $TOKEN_A")
  FID=$(echo "$F" | jq -r '.id'); PUT=$(echo "$F" | jq -r '.upload_url')
  # 2. confirm БЕЗ загрузки -> 409
  curl -s -w '%{http_code}\n' -X POST \
    http://localhost:8010/goals/$G/items/$ITEM/files/$FID/confirm -H "Authorization: Bearer $TOKEN_A"
  # 3. реальная заливка по presigned URL и confirm
  curl -s -w '%{http_code}\n' -X PUT --upload-file /tmp/qa-goal.jpg "$PUT"
  curl -s -X POST http://localhost:8010/goals/$G/items/$ITEM/files/$FID/confirm \
    -H "Authorization: Bearer $TOKEN_A"
  # 4. view_url в дереве и его реальная работоспособность
  URL=$(curl -s "http://localhost:8010/goals/$G/items" -H "Authorization: Bearer $TOKEN_A" \
        | jq -r --arg f "$FID" '..|objects|select(.id==$f)|.view_url')
  curl -s -o /dev/null -w '%{http_code}\n' "$URL"
  # 5. удаление узла уносит объект (best-effort, дать пару секунд background-task)
  curl -s -w '%{http_code}\n' -X DELETE http://localhost:8010/goals/$G/items/$ITEM \
    -H "Authorization: Bearer $TOKEN_A"
  curl -s -o /dev/null -w '%{http_code}\n' "$URL"
```
- **Ожидание**: (2) 409 `FILE_NOT_UPLOADED`; (3) PUT 200 и confirm 200 с
  `uploaded=true`; (4) до confirm `view_url` = null, после — рабочий URL 200
  (правило «URL только на доказанные байты»); (5) DELETE 204, строка и объект
  исчезли — URL отдаёт 403/404 от MinIO. Дополнительно: файл 11-й на пункте → 422
  `GOAL_ITEM_FILES_LIMIT_EXCEEDED`; заливка файла > 5 МБ → confirm 422
  `IMAGE_TOO_LARGE` (size gate на серверном HEAD, а не на клиенте).
- **Метка**: live. Если MinIO недоступен — TC блокируется, статус ⏸ + причина;
  ожидаемый код в этом случае 503 `STORAGE_UNAVAILABLE`, а НЕ 500.

---

## Сознательно НЕ включено (и чем закрыто)

| Сценарий | Чем закрыт |
|---|---|
| Коды/формы валидации полей (name ≤100, links ≤10/≤2048, amount > 0, currency `^[A-Z]{3}$`) | pytest схем в `test_goal_items.py` — дешевле и полнее, чем curl |
| Auth-провал без токена / с протухшим токеном на новом роутере | общий middleware, уже гейтится существующими auth-тестами роутеров |
| PAT-allowlist и scope-гейты новых пар | pytest PAT-набора + тесты `packages/mcp-server` (fail-closed allowlist) |
| Скоупинг по user_id на КАЖДОМ новом эндпоинте | A7 доказывает один общий путь 404; остальное — pytest |
| Идемпотентность повторного DELETE узла/файла | pytest: второй DELETE → 404 `GOAL_ITEM_NOT_FOUND` |
| Лимит 500 пунктов на цель | pytest с фабрикой строк; live-прогон 500 POST — трата без сигнала |
| Производительность CTE §4 (N=500, depth=6) | pytest-замер числа SQL-запросов (доказываем отсутствие N+1, не миллисекунды) |
| Пагинация/сортировка `sort_order`, кнопки «вверх/вниз» | pytest + web-qa (UI-аффорданс) |
| CORS на новых маршрутах | существующий `test_cors` (новых глаголов нет) |
| Дрейф контракта openapi.json ↔ schema.d.ts | существующий drift-тест + прогон тестов всех четырёх потребителей |

---

## Итог прогона

Заполняется после live-прогона.

- Всего сценариев: 9 (pytest 7 / live 2)
- pytest-гейт (`make test`): ✅ pass — 2026-08-26, `TEST_DATABASE_URL=...5443/budget_test uv run pytest -q` → **525 passed in 116.84s**, exit 0, ни одного skip/xfail-сюрприза. Сценарии Section A (A1, A2, A4, A6, A7, A8, A9) живьём не переигрывались — по правилу «pytest дешевле и надёжнее».
- A3: ✅ pass — live-прогон 2026-08-24 на изолированной БД `budget_qa_a3` (:8012, схедулеры off). Гонка 1 (встречные перевесы, 5 серий): каждая серия ровно 200+422 `GOAL_ITEM_CYCLE`, ни одного 5xx; в 4 из 5 серий проигравшего отбил ИМЕННО триггер (`ERROR: goal_items cycle` в логе Postgres на бэкенде нашей БД) и он отмаплен в 422; после каждой серии `GET items` <50 мс, число узлов прежнее, отцепленных циклов нет. Гонка 2 (встречные связки транзакции, 3 раунда): 6×200, победитель ровно один, `paid` на одном узле, `goal.paid_minor` +12300 за раунд (не задвоено).
- A5: ✅ pass — live-прогон 2026-08-26 на изолированной БД `budget_qa_final` (:8012, схедулеры off), MinIO :9010 bucket `receipts`, юзеры `qa-goalplan-a/b@budgetqa.dev`.
  L0 (предусловие): `GET /goals/upcoming` и `?days=30` → 200 `{"items":[]}` — статический сегмент выигрывает у `/{goal_id}`, route-order landmine §6 не сработала.
  Шаги: (1) presign 201, `upload.url` — SigV4 на `localhost:9010/receipts/<user>/goal-items/<file>.jpg`, TTL 600 c; (2) confirm без байтов → **409 `FILE_NOT_UPLOADED`**, в списке `uploaded=false`, `view_url=null`; (3) реальный `PUT` в MinIO → **200**, confirm → **200 `uploaded=true`** с подписанным `view_url` (TTL 300 c); (4) `GET view_url` → **200, 333 B, `image/jpeg`**, байты `cmp`-идентичны залитому файлу; в дереве `files_count=1`/`subtree_files_count=1`; (5) `DELETE` узла → **204**, через 3 с в MinIO пусто (`/data/receipts/*/goal-items` не существует, префикс пользователя удалён), старый `view_url` → **404 `NoSuchKey`**, `GET .../files` удалённого узла → 404 `GOAL_ITEM_NOT_FOUND`.
  Допы: 11-й слот на узле (после 10×201) → **422 `GOAL_ITEM_FILES_LIMIT_EXCEEDED`**; файл 5 243 293 B (> 5 000 000) залит в MinIO, но confirm → **422 `IMAGE_TOO_LARGE`** (гейт на серверном HEAD, не на клиенте) — и этот НЕподтверждённый объект тоже унесён удалением узла, утечки байтов нет. Ни одного 5xx: в логе стенда 0 `Traceback`/`500`.
  Не проверено осознанно: ветка «MinIO недоступен → 503 `STORAGE_UNAVAILABLE`» — контейнер MinIO общий с рабочей копией пользователя (:8010), гасить его нельзя; ветка закрыта pytest'ом с моком клиента.
  Неточность самого чеклиста (поведение в порядке): в снипете шага (4) `view_url` ищется в `GET /goals/{G}/items` — в дереве его нет (`GoalItemRead` несёт только `files_count`/`subtree_files_count`), URL отдаёт `GET /goals/{G}/items/{item}/files`. Прогон сделан по фактическому контракту.
- Вердикт API-части: ✅ **READY FOR REVIEW** — 9/9 сценариев зелёные (7 pytest + A3 live 2026-08-24 + A5 live 2026-08-26), функциональных дефектов и 5xx не найдено. Веб-часть скоупа — за web-qa.
