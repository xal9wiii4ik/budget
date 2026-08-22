# Review B (FULL) — transaction-details-and-i18n, подзадачи B1–B4

Ревьюер: code-reviewer. Дата: 2026-08-22.
Скоуп: миграция 0009, модели, схемы, роутеры transactions/profile, profile_reads,
app.py, тесты, контрактная пара, фикстура мобилки. Гейты не перегонялись
(прогнаны senior-lead'ом); одна точечная проба (см. MAJOR-1), файл пробы удалён.

## Findings

### MAJOR-1 — очистка original-пары молча переписывает base-снапшот (теряется ручной override)

`apps/api/src/budget_api/routers/transactions.py:100–112` (`_CONVERSION_INPUTS`)
+ `:1234–1241` (row 5/6 снапшот-блока).

Резолюция §8.1 добавила `original_amount_minor`/`original_currency` в
`_CONVERSION_INPUTS` целиком. В результате PATCH `{"original_amount_minor": null,
"original_currency": null}` — правка, при которой `amount_minor` НЕ меняется —
попадает в ветку «conversion input moved → recompute» и пересчитывает
`base_amount_minor` автоконвертацией.

Доказательство (точечная проба, воспроизведена на живом тестовом Postgres):
создать expense 170.00 BYN (base RUB) с original-парой 50.00 EUR и **ручным**
`base_amount_minor=123456`; затем PATCH, очищающий только пару →
`base_amount_minor` стал `459000` (17000 × 27.00), override 123456 потерян.
При отсутствии курса BYN→RUB на дату снапшот вообще занулился бы
(`auto_snapshot` → NULL/NULL).

Это противоречит: (а) `docs/conventions.md` — «ручная правка пользователя всегда
побеждает автоконвертацию»; (б) собственному комментарию в
`schemas/transaction.py` («clearing a display field must not silently restate
money») — списание не тронуто, а базовые деньги переписаны; (в) духу §8.1,
который закрывал дырку именно на пути «сервер ВЫВЕЛ amount_minor».

Пересчёт нужен только тогда, когда settlement-сумма реально изменилась, т.е.
когда сработала derived-ветка. Минимальный фикс: убрать original-поля из
`_CONVERSION_INPUTS` и расширить условие ветки recompute до
`… or fields & _CONVERSION_INPUTS or derived_amount is not None` (create-путь
не затронут — там снапшот уже считается от `effective_amount`). Тест §4.7
останется зелёным (там пара СТАВИТСЯ, derived_amount не None), плюс нужен
контраст-тест «clear пары не трогает base-override».

Существующие тесты дырку не ловят: в
`tests/test_original_amount.py::test_clearing_the_pair_keeps_the_money…`
у строки нет курса BYN→RUB и нет override, снапшот None до и после.

### MINOR-1 — докстринг `/profile` утверждает несуществующий 403

`apps/api/src/budget_api/routers/profile.py:5–9`: «a personal access token is
stopped twice over and gets the allowlist's 403 before this module is ever
reached». Неверно: allowlist-гейт живёт ВНУТРИ `current_user_jwt_or_pat`, а
`/profile` зависит от `current_active_user` — PAT просто не проходит JWT-декод и
получает **401**, что и утверждают план (§2 «PAT упрётся в 401») и собственный
тест `tests/test_profile.py::TestAuth::test_requires_a_browser_session`.
Поведение правильное; врёт только докстринг — поправить формулировку.

### NIT-1 — выведенный settlement-amount обходит верхнюю границу D14

`routers/transactions.py` (create derived-ветка и PATCH `derived_amount`):
`convert_minor` может вернуть значение > `MAX_MINOR_AMOUNT` (le-границы схемы
проверяют только присланные значения). BigInteger вмещает, и тот же класс
поведения давно принят для `base_amount_minor` из `auto_snapshot` — фиксирую как
известное свойство, действий не требую.

## Проверено без замечаний (по пунктам брифа)

1. **Снапшот-дырка §7.2/§8.1**: create считает base от `effective_amount`
   (`:707–716`), запись строки — от него же; PATCH-путь derived → запись →
   recompute от `tx.amount_minor` согласован. Единственный разъезд — MAJOR-1
   (обратная сторона той же правки).
2. **Присланный amount_minor побеждает**: derived-ветки гейтятся
   `payload.amount_minor is None` (create) / `"amount_minor" not in fields`
   (PATCH); перезаписи нет. Тест `test_sent_settlement_amount_beats_the_daily_rate`.
3. **Экспоненты**: `convert_minor`/`to_major_string` везде с живым currency;
   CSV original — в экспоненте `original_currency`; тесты JPY (0) и KWD (3)
   с контраст-ассертами. ×100 нигде нет.
4. **Скоупинг**: `_validate_receipt` — один код-путь, чужой==несуществующий,
   байт-в-байт (тест сравнивает `resp.text`); PAT-поверхность —
   `pat_auth.py` не тронут, `/profile` вне allowlist (PAT → 401),
   `test_pat_may_edit_receipt_id_but_not_reach_a_strangers_receipt` держит
   ownership и аудит; `/profile` — `session.get(Profile, user.id)`, чужого
   ресурса не существует по построению.
5. **Семантика PATCH**: атомарность пары по field set (полупара и
   «значение+null» → `ORIGINAL_FIELDS_REQUIRED`); clear не трогает
   `amount_minor` (но см. MAJOR-1 про снапшот); refuse-whole на смене счёта
   (`eff_original_currency` vs `eff_cur`, строка не изменена — тест);
   `FX_RATE_UNAVAILABLE` до любых записей полей (derived-блок стоит до
   всех присвоений; тест проверяет, что note не применился).
6. **Миграция 0009**: downgrade полностью симметричен (констрейнты → колонки,
   оба блока); CHECK'и модель↔миграция слово-в-слово (включая f-string
   `_TRANSFER`='transfer'); NULL-поведение всех шести CHECK'ов корректно
   (NULL проходит `~` и `IN`). Тесты CHECK'ов — прямой ORM-insert, ловят
   именно констрейнт.
7. **Идемпотентность client_id**: replay-arm стоит до original-гейтов, «first
   write wins» распространён на новые поля, `_serialize` чист от сессии —
   тест `test_replay_returns_the_stored_original_pair` (включая count==1).
8. **Качество тестов**: контрасты на месте (16500 vs 17000; 445500 vs stale
   27000; "5000" vs "50.00"), вакуумных тестов не нашёл; отказ от
   «country roundtrip»/«no MinIO call» — правильный. Правка мобильной
   фикстуры — ровно 4 разрешённые строки.
9. **Контракт**: openapi.json и schema.d.ts согласованы (original-тройка +
   `original_rate` required в Read, optional в Create/Update, `receipt_id` в
   Update, `/profile` GET/PATCH, ProfileRead/ProfileUpdate с Literal ru|en);
   следов ручной правки schema.d.ts нет.

Принятые отклонения из брифа (нет model_validator'а, нет ProfileError, ge=1
вместо HTTP-арма A-4, +4 строки фикстуры) — не поднимал.

## Вердикт

**Условный APPROVE: один MAJOR к исправлению до коммита.** MAJOR-1 — реальная
потеря пользовательских денег-данных (ручного base-override) на display-only
правке, фикс локальный (одно условие + один контраст-тест). MINOR-1 — правка
докстринга. Остальное — образцово: гейты, no-oracle, деньги и контракт
согласованы, тесты предметные.
