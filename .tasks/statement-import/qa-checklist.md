# QA Checklist: statement-import (API-уровень)

## Scope
Интеграционная реальность импорта выписки: multipart+cp1251 живьём, идемпотентность,
деструктивный replace, no-oracle, валютная пара. Юнит-уровень (парсер, matching,
occ_index, fingerprint) — целиком pytest инженера, сюда НЕ входит. Web-сценарии — у
web-qa отдельно. Формат — coverage map (STANDARD-детализация); полный прогон один раз
в конце скоупа, кроме [stop-probe] — они гоняются на /test подзадачи S1.

Данные: только `qa-*@budgetqa.dev` (qa-a = владелец, qa-b = чужой). Реальный файл
выписки в фикстуры НЕ кладём (персональные данные): все сценарии — против
синтетической cp1251-фикстуры из плана инженера (две секции, строка PLN, строка с
нулевым оборотом, «Заблокированные суммы», два байт-одинаковых платежа). Сервер: 8010,
шедулеры off (infra.md).

---

### CT-1 [stop-probe] Upload happy path: multipart + cp1251 живьём
- Цель: первый интеграционный шов — multipart upload, декод cp1251, счётчики сессии.
- Шаги: `curl -F file=@fixture.csv -F account_id=$ACC_BYN -F format=priorbank_csv_v1 :8010/statement-imports`
- Ожидаемое: 201; status=parsed; rows_total/rows_blocked/rows_zero_skipped ровно по
  фикстуре; period_from/to из шапки; GET /{id}/rows отдаёт строки, кириллица не битая.
- Pytest: частично (парсер юнитом); живой прогон обязателен — multipart+декод только тут.

### CT-2 [stop-probe] Повторная загрузка: те же client_id, supersede, ноль дублей строк
- Цель: идемпотентность отпечатка сквозь два реальных POST + вытеснение parsed-сессии.
- Шаги: CT-1 дважды; сравнить client_id строк обеих сессий; GET первой сессии.
- Ожидаемое: множества client_id байт-идентичны (вкл. пару одинаковых платежей —
  occ_index различает); первая parsed-сессия удалена (404); строки не задублированы.
- Pytest: да (fingerprint, supersede) → живой прогон = spot-check.

### CT-3 Apply happy path + валютная строка PLN без конвертации
- Цель: сверка «применить» создаёт транзакции; PLN-строка легла original-парой.
- Шаги: сессия из CT-1 → `POST /{id}/apply`; `GET /transactions?account_id=$ACC_BYN`.
- Ожидаемое: отчёт created=N(new), skipped=(exact+similar по дефолту); status=applied;
  PLN-строка: amount_minor = |оборот BYN| (напр. 143963), original_amount_minor/
  original_currency = 180000/PLN — как в файле, БЕЗ пересчёта на нашей стороне;
  merchant=description; currency проштампована со счёта.
- Pytest: да (apply-сервис) → spot-check, но пара PLN проверяется глазами обязательно.

### CT-4 Идемпотентность повтора end-to-end: re-upload после apply + повторный apply
- Цель: самый дорогой инвариант — ноль дублей транзакций при полном повторе цикла.
- Шаги: после CT-3 снова CT-1 (та же фикстура) → все строки exact (по client_id),
  decision=skip; `POST apply` новой сессии; посчитать транзакции до/после.
- Ожидаемое: match_status=exact у всех бывших new; отчёт created=0,
  already_existed/skipped=N; число транзакций счёта НЕ изменилось.
- Pytest: да (B-1 replay) → живой прогон = spot-check поверх реальной БД.

### CT-5 Replace-preview: счётчики удаляемого и связей ДО подтверждения
- Цель: предупреждение пользователя честное — preview считает то, что реально умрёт.
- Шаги: сеанс parsed; насеять в период счёта: обычную транзакцию, транзакцию с
  receipt_id, с goal_item_id, transfer (нога этого счёта); `GET /{id}/replace-preview?from=X`.
- Ожидаемое: 200; deleted_total=3 (transfer НЕ в удаляемых), по 1 в счётчиках
  receipt/goal_item, transfer в отдельной строке «останутся», created = строки с txn_date≥X.
- Pytest: частично (отбор) → живой прогон обязателен вместе с CT-6 (счётчики vs факт).

### CT-6 Replace: удаляет ТОЛЬКО свой счёт/период, transfer нетронут, факт = preview
- Цель: единственное необратимое действие скоупа режет ровно то, что обещал preview.
- Шаги: к сетапу CT-5 добавить транзакцию на ДРУГОМ счёте qa-a в периоде и транзакцию
  этого счёта ДО X; `POST /{id}/replace {"from_date": X, "confirm_deleted_total": <deleted_total из CT-5>}`;
  пересчитать всё. Дополнительно: то же с числом−1 ⇒ 422 REPLACE_CONFIRMATION_MISMATCH,
  ничего не удалено (сверка senior-lead: дельта S3 в plan.md).
- Ожидаемое: удалены только не-transfer выбранного счёта в [X; period_to], число =
  deleted_total из CT-5; transfer жив (обе ноги), чужой счёт и строки до X нетронуты;
  создано = created из preview; status=replaced; повторный replace → 422 IMPORT_FINISHED.
- Pytest: да (тир FULL, S3) → живой прогон всё равно обязателен: деструктив на общей БД.

### CT-7 No-oracle 404: чужая сессия и чужая строка
- Цель: qa-b не отличает «чужое» от «не существует» ни на одном уровне.
- Шаги: токеном qa-b: GET/PATCH/apply/DELETE на сессию qa-a; PATCH строки qa-a через
  СВОЮ сессию qa-b (чужой row_id); сравнить с ответами на случайные UUID.
- Ожидаемое: везде 404 IMPORT_NOT_FOUND, тела байт-идентичны паре «несуществующий id».
- Pytest: да → живой прогон = spot-check (diff тел через `diff <(curl…) <(curl…)`).

### CT-8 [stop-probe] STATEMENT_CURRENCY_MISMATCH: сессия не создаётся
- Цель: валюта шапки против счёта — отказ до какой-либо записи.
- Шаги: фикстуру BYN залить в USD-счёт qa-a; проверить отсутствие сессии (SQL/повторный GET).
- Ожидаемое: 422 STATEMENT_CURRENCY_MISMATCH; в statement_imports ни строки.
- Pytest: да → spot-check.

### CT-9 [stop-probe] Битый файл: не-cp1251/мусор → 422 без сессии
- Цель: наивный UTF-8 или мусорный файл не роняет 500 и не оставляет хвостов в БД.
- Шаги: (а) та же фикстура, пересохранённая в UTF-8; (б) бинарный мусор; тот же POST.
- Ожидаемое: 422 STATEMENT_PARSE_FAILED (или STATEMENT_FORMAT_UNKNOWN для (б) — по
  реализации, но код из объявленной пары и НЕ 500); сессий в БД нет.
- Pytest: да → живой прогон обязателен для (а): реальный декод-путь — шов stop-probe.

---

## Сознательно НЕ покрыто чеклистом (закрывает pytest инженера или отложено)
- Парсер/секции/итоги/нулевые обороты, matching-проходы и окна, occ_index — юнит.
- PATCH-валидации (IMPORT_FINISHED, DECISION_NEEDS_MATCH, CATEGORY_*), DELETE-отмена,
  пагинация rows, лимит 200 — pytest.
- STATEMENT_TOO_LARGE (гейт 1 МБ), 429 (10/min) — pytest по receipts-прецеденту.
- REPLACE_FROM_OUT_OF_RANGE — pytest (крайние даты); живьём не гоняем.
- bank_category_map/merchant learning и гейт category_user_set — pytest.
- possible_transfer-эвристика, подсказки категорий — pytest + web-qa (отображение).
- TTL 7 дней lazy-cleanup — pytest (время не мокается живьём).
- Производительность на ~1000 строк — вне чеклиста; поднимем отдельно, если S1 покажет
  проблему на 218-строчной фикстуре.

## Summary (заполняется на прогоне в конце скоупа)
- Total: 9 · [stop-probe]: CT-1, CT-2, CT-8, CT-9 (прогон на /test S1)
