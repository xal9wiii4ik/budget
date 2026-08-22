# QA Program: recurring-dates-and-income (ЕДИНАЯ на скоуп)

Слито из api- и web-чеклистов по решению PM 2026-08-22 (потолок 12–15 живых
сценариев на скоуп). Один живой прогон в конце скоупа; промежуточных STOP-проб
нет (новой внешней интеграционной границы скоуп не вводит).

Семантика start_date — по PM-решениям 2026-08-22 (см. architecture.md):
- виджет показывает НЕматериализованные списания с датой ≥ сегодня; строки
  «сегодня» помечены явно;
- дата начала раньше допустимого пола → 422 `START_DATE_TOO_EARLY`
  (create: < today; PATCH: ≤ min(ватермарка, today)). Клэмпа больше НЕТ;
- `START_DATE_AFTER_END_DATE` — одинаковый строковый код с обеих веток.

---

# Секция A — PYTEST-реестр (пишет backend-engineer; vitest — frontend)

## start_date create
- **P-1** будущий start_date: 201, эхо, `next_due_on` ≥ start_date, ватермарка == start−1.
  ✅ `TestStartDate::test_future_start_seeds_the_watermark_so_nothing_books_before_it`
- **P-2** будущий start_date + `materialize_due(<до start>)`: ноль транзакций,
  ватермарка не тронута. Доказательство «ничего не спишется раньше срока».
  ✅ тот же тест (`_materialized() == []`, ватермарка == start−1 после прогона)
- **P-3** start_date == today: ватермарка today−1, сегодняшняя occurrence впереди (== legacy).
  ✅ accept-ветка `test_past_start_date_on_create_is_refused_not_silently_clamped`
- **P-4** (ИЗМЕНЕНО) прошлый start_date на create → 422 `START_DATE_TOO_EARLY`;
  контраст: start_date == today → 201. Клэмп-ветки больше не существует.
  ✅ `test_past_start_date_on_create_is_refused_not_silently_clamped` (обе ветки)
- **P-5** без start_date / явный null на create: legacy не изменился, `start_date: null` в ответе.
  🟡 legacy-ватермарка (== вчера) — `TestCreate::test_create_defaults_and_projection`;
  ни `start_date: null` в ответе create, ни ЯВНЫЙ null в теле create ничем не утверждаются
- **P-6** (ИЗМЕНЕНО) `start_date > end_date` на create → 422 со СТРОКОВЫМ кодом
  `START_DATE_AFTER_END_DATE` (router-level, та же форма, что на PATCH — решение PM №2).
  ✅ create-ветка `test_start_after_end_is_refused_with_the_same_code_on_create_and_patch`

## start_date PATCH
- **P-7** фикс будущего seed'а: создан со start=today+40 → PATCH start=today+3 →
  ватермарка today+2 (точное присваивание после гейта), `next_due_on` съехал вверх.
  ❌ НЕ ПОКРЫТ: ни один тест не PATCH'ит будущий seed на более близкую будущую дату.
  Мутация `payload.start_date <= template.last_materialized_on` вместо `<= floor`
  (запрет чинить опечатку в дате) проходит весь сьют: null-ветка `floor` жива, а
  rewind-тест идёт от ватермарки == today, где min() ничего не меняет
- **P-8** сдвиг позже: PATCH start=today+40 → ватермарка today+39.
  ✅ точное присваивание start−1 на PATCH — forward-ветка
  `test_patch_start_date_cannot_rewind_into_the_booked_region`; тот же стамп на дальней
  дате (today+40 → today+39) — create-сид в `test_explicit_null_start_date_clears...`
- **P-9** явный null: колонка очищена, ватермарка = min(current, today); будущий seed отменён.
  ✅ `test_explicit_null_start_date_clears_the_column_without_rewinding` (обе ветки min)
- **P-10** (ИЗМЕНЕНО, ключевой) сегодня забронировано (ватермарка = today) →
  PATCH start=today → 422 `START_DATE_TOO_EARLY`, строк по-прежнему ровно одна;
  PATCH start=tomorrow → 200, ватермарка = today, повторный `materialize_due(today)`
  не создаёт второй строки.
  ✅ `test_patch_start_date_cannot_rewind_into_the_booked_region` (обе ветки + повторный прогон)
- **P-11** (ИЗМЕНЕНО) null после сегодняшней брони: ватермарка = min(today, today) = today,
  второй строки нет.
  ✅ `test_explicit_null_start_date_clears_the_column_without_rewinding`
- **P-12** композиция `{paused:false, start_date:today+5}` на паузном шаблоне:
  итог = max(вклад unpause today−1, start−1) = today+4; порядок полей в JSON не влияет.
  ❌ НЕ ПОКРЫТ: совместного PATCH paused+start_date нет ни в одном тесте.
  Смягчающее: `max()` на unpause запинен `TestPauseSemantics::test_same_day_pause_unpause_does_not_duplicate`,
  а блоки идут последовательно (результат совпадает при обоих порядках)
- **P-13** PATCH start_date + перенос счёта (B3) в одном запросе: правило ватермарки
  и перештамповка currency не мешают друг другу.
  ❌ НЕ ПОКРЫТ: в `TestPatchAccountMove` нет ни одного `start_date`
- **P-14** effective-pair `START_DATE_AFTER_END_DATE` на PATCH в обе стороны
  (start против сохранённого end; end против сохранённого start; оба в payload);
  равные даты — не ошибка.
  🟡 покрыто: start в payload против СОХРАНЁННОГО end + равные даты (201) —
  `test_start_after_end_is_refused_with_the_same_code_on_create_and_patch`.
  НЕ покрыто: end в payload против сохранённого start и оба ключа в одном payload —
  ветка `eff_end = payload.end_date` не исполняется ни разу
- **P-15** PATCH без start_date в payload (веб шлёт `paused:false` при каждом
  сохранении): ватермарка не тронута, pending catch-up выживает.
  ✅ `TestPauseSemantics::test_non_transition_paused_false_keeps_pending_dates`

## GET /recurring/upcoming
- **P-16** дефолт days=30. ✅ `TestUpcoming::test_days_widens_the_horizon_beyond_the_default_window`
  (45 дней вне дефолта) + точный список `test_window_lists_only_future_charges_across_templates_in_due_order`
  на горизонте today+30; сам `default: 30` запинен в контракте `test_openapi_export`.
- **P-17** границы 0/91 → 422, 1/90 → 200.
  🟡 поведенчески проверен только days=90 → 200; 0/91/1 не вызываются (осознанное
  решение плана: «pure Pydantic»); `minimum:1 / maximum:90` запинены в openapi.json drift-тестом
- **P-18** paused исключён. ✅ точный список `test_window_lists_only_future_charges_across_templates_in_due_order`
  (фикстура `paused` отсутствует; лишняя строка ломает exact-list assert)
- **P-19** end_date обрезает, ровно на end_date — отдаётся. ✅ там же (фикстура `ending`:
  единственная строка ровно на end_date, дальнейшие недельные обрезаны)
- **P-20** будущий старт в окне — присутствует (первая дата ≥ start); за горизонтом — нет.
  ✅ там же (фикстура `late`: start today+5 → первая дата today+8) + `test_days_widens...` (за горизонтом)
- **P-21** weekly в 30 днях == `due_dates_between`. ✅ там же — ожидание строится
  НЕЗАВИСИМЫМ локальным оракулом `_weekly_dates`, а не кодом под тестом
- **P-22** сортировка, тай-брейк created_at. ✅ там же (`late` делит weekday с `weekly` →
  совпадающие даты, порядок по рангу создания)
- **P-23** арреарс не рендерится (отставшая ватермарка → только даты ≥ today) —
  это и есть серверная половина правила «показываем несостоявшееся»: сегодняшняя
  УЖЕ списанная occurrence в ответ не попадает (ватермарка == today), несписанная — попадает.
  🟡 покрыта только половина: арреарс (фикстура `arrears`, ватермарка today−10 —
  today−8/today−1 отсутствуют) и «несписанная сегодняшняя попадает» (фикстура `salary`,
  ватермарка == вчера). НЕ покрыто «уже списанная сегодняшняя НЕ попадает»: ни одна
  фикстура /upcoming не имеет ватермарки == today. Мутация пола на
  `max(watermark, today) − 1` проходит весь сьют, а виджет начинает показывать
  списанное сегодня — это ровно решение PM №1
- **P-24** скоупинг по user_id; пустой ответ `{"items":[]}`.
  ✅ шаблон второго юзера отсутствует в точном списке; `{"items": []}` — `test_days_widens...`
- **P-25** форма элемента (8 полей), category_id null допустим, kind=income отдаётся.
  ✅ точное сравнение dict из 8 ключей на income-шаблоне + category_id у weekly
- **P-26** GET read-only по ватермарке. ❌ НЕ ПОКРЫТ: после `GET /upcoming` ватермарку
  никто не перечитывает. Смягчающее: в хендлере только SELECT, записи нет
- **P-27** PAT-пара в allowlist. ✅ `test_pat_auth.py::TestAllowlistContract::test_every_allowlisted_pair_exists_in_the_exported_openapi`
  (пара `("GET", "/recurring/upcoming")` в `PAT_ALLOWLIST`); живой вызов PAT'ом — LV-10
- **P-28** `_next_due_on` и эндпоинт дают одну дату (общий helper B4).
  🟡 по построению: единственная функция `upcoming_due_dates`, оба вызова через неё;
  прямого assert «next_due_on == первая строка /upcoming того же шаблона» нет

## Контракт, миграция, границы
- **P-29** пара openapi.json ↔ schema.d.ts — существующий drift-тест (ссылка, не дубль).
  ✅ `tests/test_openapi_export.py::test_committed_schema_matches_current_app` пинит
  openapi.json ↔ приложение; `schema.d.ts` перегенерён тем же диффом (эту половину
  теста нет, её страхует typecheck `@budget/api-client`)
- **P-30** миграция **0010**: существующие строки получают NULL, ватермарки не тронуты, downgrade чист.
  🟡 `conftest::_migrated_schema` каждой сессией гоняет `upgrade head` и `downgrade base`,
  так что 0010 применяется и откатывается (в т.ч. на непустых таблицах при откате).
  НЕ покрыто: upgrade НА НЕПУСТЫХ данных (в сьюте схема строится с нуля), т.е. «legacy-строки
  получают NULL и ватермарки не сдвинуты» ничем не утверждено — держится на том, что
  колонка nullable без server_default и backfill'а нет
- **P-31** (НОВЫЙ, обязателен по PM №3) start_date за верхней границей
  (le 2999-12-31) → 422 на обеих схемах, а не 500 из `next_due` за пределами календаря.
  ✅ `test_far_future_start_date_is_refused_instead_of_500` (create + PATCH, оба — массив Pydantic)

## Итог секции A (проверено QA 2026-08-22, прогон `-k "TestStartDate or TestUpcoming"` — 8 passed)
Закрыто полностью: 19 (P-1…P-4, P-6, P-8…P-11, P-15, P-16, P-18…P-22, P-24, P-25, P-27, P-29, P-31).
Частично: 7 (P-5, P-14, P-17, P-23, P-28, P-30 — обоснования выше).
Не закрыто: 4 (P-7, P-12, P-13, P-26).
Приоритет находок для senior-lead: **P-7** и **P-23** (обе мутации проходят весь сьют
и обе видны пользователю), остальные — низкая.

## vitest (frontend, из plan-web.md)
- **V-1/V-2** `buildRecurringTemplatePatch`: start_date omit/null/value.
- **V-3** схема: start>end → issue на поле; '' → null.
- **V-4** `upcomingRows`: кап 5 + hiddenCount + пометка «сегодня» (UTC-сравнение).
- **V-5** `freeBalanceWindow`: перекат года (янв → окт–дек прошлого), UTC против local.

---

# Секция B — ЖИВОЙ ПРОГОН (12 сценариев, один раз в конце скоупа)

## Предусловия
- API :8010, **`RECURRING_SCHEDULER_ENABLED=false FX_SCHEDULER_ENABLED=false`**.
  Критично: boot catch-up (D5) при включённом планировщике собьёт счётчики и
  снимет «сегодняшние» строки из виджета.
- Web :5173 (`pnpm dev`), `apps/web/.env` не трогать.
- Пользователи `qa-rdi-a@budgetqa.dev`, `qa-rdi-b@budgetqa.dev` / `Qa!Test1234`;
  логин по одному разу, токены переиспользуются.
- Все даты — от **UTC**-сегодня; anchor'ы с day_of_month ≤ 28.
- **Не запускать прогон в окне ±15 минут от 00:00 UTC** (решение PM №4: смена
  UTC-дня посреди прогона обесценивает все относительные даты).
- Одинарность списания в день срока ЖИВЬЁМ НЕ ДОКАЗЫВАЕТСЯ (решение PM №3):
  материализатор недостижим по HTTP, тестовой ручки не будет; доказательство —
  **P-2/P-10/P-11**. Прогон идёт с выключенным планировщиком.
- Фикстуры — curl'ом, не кликами: счёт RUB, категории expense/income;
  `T-SOON` weekly без start_date; `T-FUTURE` monthly start=today+20;
  `T-CLAMP` monthly end=today+5, anchor today+20; `T-ENDED` end в прошлом;
  `T-TODAY` monthly anchor=today (планировщик выключен → не материализован →
  обязан висеть в виджете с пометкой «сегодня»).
- Сквозная гигиена (не отдельный TC): ноль консольных ошибок за прогон; никаких
  4xx/5xx кроме намеренных 422; после каждого модального закрытия фокус
  возвращается на триггер (точечно в LV-3/LV-5).

### LV-1 — boot + живой контракт (curl)
`GET /health` 200; `GET /openapi.json` байт-в-байт == apps/api/openapi.json;
в нём `/recurring/upcoming`, `start_date` в Create/Update/Read, `UpcomingCharge*`. **⏸**

### LV-2 — будущий start_date: ничего не происходит раньше срока (curl)
POST шаблон start=today+40 → 201, next_due_on ≥ start; отсутствует в
`upcoming?days=30`; счётчик `/transactions` не изменился. Одинарность в день
срока — закрыта P-2/P-10/P-11 (см. предусловия). **⏸**

### LV-3 — браузер: создание с датой, эхо, исправление «слишком поздно»
Форма /recurring: создать с start=today+40 → строка «следующее списание» ≥ start;
Edit — поле предзаполнено ровно сохранённой датой; сменить на today+3 → Save →
дата следующего списания съехала ВВЕРХ без перезагрузки; PATCH в network-логе
несёт только изменённый ключ. Заодно: Tab доходит до поля, label связан. **⏸**

### LV-4 — браузер: очистка даты
Edit → очистить поле → Save: PATCH несёт `start_date: null` (network-лог, не
догадка); следующее списание вернулось к натуральной дате; Edit снова показывает
пустое поле. **⏸**

### LV-5 — браузер: оба 422 маршрутизируются В ПОЛЕ
(a) start=today+60 при end=today+30 → `START_DATE_AFTER_END_DATE` под полем даты
(не общий баннер), форма живая, повторный Save с исправлением проходит;
(b) start=вчера на создании → `START_DATE_TOO_EARLY` под полем, копия объясняет
«прошлые списания не переписываются»; после 422 нет ловушки фокуса. **⏸**

### LV-6 — браузер: виджет на /transactions (главный пользовательский сценарий)
Блок присутствует; строки по возрастанию даты как отдал сервер; `T-TODAY` виден
С ПОМЕТКОЙ «сегодня» (несписанное сегодняшнее — решение PM №1); `T-SOON` даёт
несколько строк; income-шаблон виден со знаком прихода; `T-ENDED` отсутствует;
`T-CLAMP` обрезан своим end_date; `T-FUTURE` первой датой ≥ start; деньги в ₽
с 2 знаками, даты локализованы; `GET /recurring/upcoming` — 200 БЕЗ CORS-ошибки
преflight (обязательная браузерная проба нового маршрута), один запрос на
загрузку; кап 5 строк + строка «ещё N» со ссылкой на /recurring. **⏸**

### LV-7 — браузер: пауза обновляет виджет без перезагрузки
Запомнить строки `T-SOON` → /recurring → Pause → назад на /transactions БЕЗ F5:
строк нет; Resume → вернулись. Починка только по F5 = FAIL. **⏸**

### LV-8 — браузер: EN-проход по трём новым поверхностям
/settings → English: виджет (даты `Oct 5, 2026`, деньги `RUB 30,000.00`),
форма дохода (вся новая копия переведена, нет сырых ключей и русского в EN),
строка базиса на /goals. Плюс: пустое состояние виджета (все шаблоны на паузе
через curl) — внятный текст со ссылкой, не пустая коробка и не вечный скелет. **⏸**

### LV-9 — браузер: доход целиком (форма → карта → цель)
Новая транзакция: заполнить сумму, выбрать расходную категорию, ввести мерчанта →
переключить на «Доход»: подписи перевернулись («Куда пришло», «Получено»,
«Источник»), категория сброшена, сумма НЕ потеряна, радио «Тип» над счётом;
выбрать категорию дохода, дату — ПОСЛЕДНИЙ ПОЛНЫЙ МЕСЯЦ → Save → 201; строка
в списке с приходной подачей; остаток счёта на /accounts вырос; /goals БЕЗ F5:
свободный остаток УВЕЛИЧИЛСЯ (инвалидация ['goals','list']), строка базиса
называет верное окно (для 2026-08-22 — «май — июль 2026») и видна пояснительная
фраза про текущий месяц; переключение доход→расход возвращает расходные подписи
симметрично. Контраст: доход, датированный СЕГОДНЯ (curl), остаток не меняет —
и это объяснено на экране (пин на объяснение, не на пересчёт). **⏸**

### LV-10 — read-scope PAT проходит allowlist (curl)
POST /tokens scope=read → GET /recurring/upcoming с `bgt_pat_...` → 200, не 403
(живое доказательство совпадения route.path_format со строкой allowlist);
DELETE /tokens/{id}. **⏸**

### LV-11 — 375×812
/transactions: виджет не переполняется по горизонтали, даты/суммы не обрезаны;
форма шаблона: поле даты достижимо, Save не за экраном; форма дохода читается.
Один скриншот на экран. **⏸**

### LV-12 — обновление страницы / deep-link
F5 на /transactions, /recurring, /goals + прямой заход по URL на /transactions:
всё восстанавливается без редиректа на логин и без crash-арма; виджет и строка
базиса на месте после перезагрузки. **⏸**

---

## Реестр вычеркнутого (чем закрыто)
- Одинарность списания в день срока / двойное бронирование — **P-2, P-10, P-11** (по HTTP недостижимо, решение PM №3).
- Сдвиг start позже + окно days=90 — **P-8, P-17, P-20**.
- Композиция unpause+start в одном PATCH, B3-перенос — **P-12, P-13**.
- Прошлый start на create (бывший клэмп-твин L-7) — **P-4** (теперь 422).
- Обе стороны effective-pair — **P-14**; равные даты — там же.
- Границы days и верхняя граница даты — **P-17, P-31**.
- Скоупинг/чужие шаблоны — **P-24** (живьём не гоняем, у LV-прогона один основной пользователь).
- Арреарс и «уже списанное сегодня не показываем» (серверная половина) — **P-23**; браузерная половина — LV-6 (`T-TODAY`).
- Сортировка с тай-брейком — **P-22** (живьём только порядок по датам).
- Идемпотентность GET — **P-26**. Helper-эквивалентность — **P-28**.
- Контрактный дрейф — **P-29**; миграция на непустых данных — **P-30**.
- Patch-builder omit/null/value, схема start>end, кап+«сегодня», окно базиса — **V-1…V-5**.
- Dirty-guard, три канала — vitest `shouldConfirmDiscard` + точечные проверки фокуса в LV-3/LV-5.
- Голы: изменений API нет (решение C) — серверного тестирования нет; UI — LV-8/LV-9.

## Оценка живого прогона (агент-минуты)
~**75**: 10 — окружение+фикстуры+2 логина; 10 — LV-1/LV-2/LV-10 (curl);
~45 — LV-3…LV-9 (браузер); 10 — LV-11/LV-12 + фиксация фактических ответов.

## Итог прогона
Всего live: 12 · Пройдено: — · Провалено: — · Заблокировано: —
**Статус: ⏸ NOT RUN (grooming)**
