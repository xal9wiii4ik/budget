# mcp.md — packages/mcp-server (stdio MCP поверх нашего API)

## Что это
`@budget/mcp-server` — локальный MCP-сервер (stdio) для Claude Desktop/Code: AI-клиент
читает и пишет бюджет пользователя через API :8010 с personal access token'ом.
Запуск: `node packages/mcp-server/dist/index.js`; env: `BUDGET_PAT` (обязателен,
fail-fast без него), `BUDGET_API_URL` (default `http://localhost:8010`),
`BUDGET_OPENAPI_PATH` (override пути к контракту). Прекомпил в `dist/`, НЕ tsx:
Claude-клиент стартует бинарь голым node вне pnpm-контекста. stdout принадлежит
транспорту — ни одного console.log, весь лог в stderr.

## Генерация инструментов (руками не пишутся)
- `src/allowlist.ts` — курируемая таблица 35 инструментов (20 read + 15 write; вклады — два read) =
  таблица `.tasks/mcp-server/architecture.md` §4 + счета (accounts-and-transfers M1:
  `list_accounts`, `create_account`, `update_account`) + два read-догона 2026-08-23
  (`list_upcoming_recurring` = GET /recurring/upcoming, `get_profile` = GET /profile:
  базовая валюта как единица всех серверных агрегатов; PATCH /profile — «никогда»,
  роутер расщеплён по методу): имена, английские
  guardrail-описания (читает модель), scope read|write. Единственный DELETE —
  `delete_transaction`. Перевод отдельного тула НЕ имеет: `create_transaction`
  с `kind:"transfer"` + counter-полями (flat-схема подхватила их из openapi).
  Так же пришла тройка spend-currency (`original_amount_minor`/`original_currency`/
  `country`): описания к ней курируются в create/update (пара атомарна, на transfer
  запрещена, валюта ≠ валюте счёта), а `amount_minor` в контракте больше НЕ required
  — без original-пары сервер отвечает 422 `AMOUNT_REQUIRED`, с ней выводит списание
  по дневному курсу. Поле без курируемого описания ловит тест
  `curates every field the model can send on a money write`. S3 добавил
  курируемую тройку read-фильтров `list_transactions`: `q` (подстрока по
  merchant/note, джокеров нет), `country` (точный alpha-2 в верхнем регистре),
  `sort` (четыре значения, дефолт `date_desc`; amount-сортировки сравнивают
  minor units БЕЗ конвертации — модель обязана оговорить это в смешанном по
  валютам списке). Export-инструмента в allowlist нет — курировать там нечего.
  goal-planner B4 добавил тройку плана целей: `get_goal_plan` (read, GET
  /goals/{goal_id}/items — плоское дерево, суммы снизу вверх, `ceiling_exceeded`
  это поле ответа, а не ошибка, срок наследуется от родителя/цели),
  `create_goal_item`, `update_goal_item` (write; перенос узла = PATCH `parent_id`,
  перестановка среди сиблингов = `move: "up"|"down"` — `sort_order` в теле
  запроса НЕТ, сервер владеет числами). Тот же контракт принёс `goal_item_id` в
  `create_transaction`/`update_transaction` (expense only, максимум ОДИН узел на
  операцию, id только из `get_goal_plan`; привязка не меняет сумму) и в фильтр
  `list_transactions` (матчит ПОДДЕРЕВО узла), а `update_goal` — пару
  `initial_budget_minor` (ручной ориентир бюджета, ничего не вычисляет) и
  `final_cost_override_minor` (override итога, который иначе считается снизу из
  пунктов). Тулы `create_goal_item`/`update_goal_item` включены в тот же tripwire
  курации, что и транзакционные. B2 добавил четвёртый, read:
  `list_upcoming_goal_deadlines` (GET /goals/upcoming) — окно ближайших дат по
  ВСЕМ живым планам сразу; курируемое описание держит четыре вещи, которых нет в
  схеме: даты считает сервер (`effective_deadline` унаследован, `reminder_date`
  вычислен — модель не арифметит дни сама), `breadcrumb` = цепочка родителей,
  которую надо проговаривать вслух, деньги в minor units и в РАЗНЫХ валютах на
  строку (`currency` у своей цены, `goal_currency` у `paid_minor` — не
  складывать), архивные цели отсутствуют, а `days` 1–90 (default 30) —
  единственный рычаг.
- **Никогда** в allowlist: PATCH /profile (роутер расщеплён по методу — базовую
  валюту меняет только человек), `delete_goal_item` (DELETE
  /goals/{goal_id}/items/{item_id}) — удаление узла каскадом уносит ВСЁ поддерево
  и приложенные файлы пользователя, то есть необратимее `delete_transaction` и
  без построчного подтверждения; такое действие модель не выполняет по реплике в
  чате, кнопка есть в приложении. Пары в `pat_auth.py` — GET/POST/PATCH items,
  DELETE отсутствует (fail-closed на обоих концах).
- `src/openapi.ts` + `src/tools.ts` — при СТАРТЕ читают закоммиченный
  `apps/api/openapi.json` (рантайм-чтение, не codegen: ноль новых генерируемых
  артефактов; `pnpm openapi` подхватывается следующим стартом — после смены
  контракта рестартни сервер в Claude-клиенте). $ref разворачиваются, строится
  ПЛОСКИЙ inputSchema (body-properties разлиты на верхний уровень;
  `anyOf:[X,null]` схлопнут → очистки поля через MCP нет, omit = keep).
  Fail-fast СПИСКОМ ошибок, если allowlist рассинхронизирован с openapi.json.
- `create_transaction`: пакет САМ генерит `client_id = crypto.randomUUID()` на
  каждый логический вызов; поле исключено из inputSchema — модель его не видит.
  Ретрай транспорта с тем же client_id → 200 со СТАРОЙ строкой, не дубль (B-1);
  два разных логических вызова с одинаковыми параметрами → две операции.
- `src/truncate.ts` — сериализованный ответ > 50KB: самый длинный массив режется
  с хвоста, добавляется `_truncated:{shown,total,note}` — модель сужает запрос.
- `src/http.ts` — fetch + `Authorization: Bearer`, таймаут 30с; ошибки API →
  MCP tool-error (`isError:true`) с человеческим текстом (маппинг TOKEN_INVALID /
  TOKEN_SCOPE_READONLY / TOKEN_ENDPOINT_FORBIDDEN / RATE_LIMITED / *_NOT_FOUND /
  422-построчно); no-oracle не размывается — «not found (missing or not yours)».

## Режимы токена
- Скоуп узнаётся при старте через `GET /tokens/self` — единственное PAT-доступное
  исключение на `/tokens/*`, возвращает `{id, scope}` своего токена.
- `read` → публикуются РОВНО 20 read-инструментов; write-инструменты модели не
  видны вовсе. Это UX-фильтр; enforcement — ТОЛЬКО сервер (docs/backend.md,
  `pat_auth.py`: гейты allowlist/scope работают независимо от пакета).
- `full` → все 35, включая единственный необратимый `delete_transaction`
  (описание требует ЯВНОЙ просьбы пользователя, bulk-удаления нет по построению).

## Гайд пользователя
`packages/mcp-server/README.md`: выпуск токена в веб-«Настройках», конфиг
Claude Desktop / `claude mcp add`, пример SQL к `pat_audit_log` (просмотр аудита
в v1 — только SQL, read-эндпоинта нет намеренно).

## Грабли
- `dist/` должен быть собран до запуска (`pnpm --filter @budget/mcp-server build`);
  путь к openapi.json резолвится от dist через `../../../` — завязан на outDir.
- Инварианты денег: MCP не считает и не конвертирует — суммы `amount_minor`
  сквозняком, конвертация только инструментом `convert_currency` (сервер).

## Загрузка чеков (upload_receipt)

- Единственный инструмент, НЕ порождённый из контракта: он читает файл с диска и
  делает три шага (создать чек → PUT байтов в хранилище → прочитать строку).
- Модель передаёт ПУТЬ, а не байты: сервер локальный, картинка через диалог не
  проходит и контекст не занимает.
- Три гейта, в порядке того, насколько легко их обмануть: инструмент не
  существует без `BUDGET_UPLOAD_DIR`; путь после `realpath` обязан лежать внутри
  этого каталога (симлинк наружу отсекается); содержимое обязано быть JPEG
  (магические байты, не расширение). Потолок 10 МБ.
- Публикуется только токену `full`.
- `POST /receipts` и `GET /receipts/{id}` принимают PAT через локальную
  зависимость `_stash_rl_user_any` в роутере чеков. `POST /{id}/parse` — НЕТ:
  он тратит AI-бюджет пользователя, и отказ там приходит на разборе JWT (401),
  что строже отсутствия пары в allowlist.
