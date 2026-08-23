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
- `src/allowlist.ts` — курируемая таблица 29 инструментов (16 read + 13 write) =
  таблица `.tasks/mcp-server/architecture.md` §4 + счета (accounts-and-transfers M1:
  `list_accounts`, `create_account`, `update_account`) + два read-догона 2026-08-23
  (`list_upcoming_recurring` = GET /recurring/upcoming, `get_profile` = GET /profile:
  базовая валюта как единица всех серверных агрегатов; PATCH /profile — «никогда»,
  роутер расщеплён по методу): имена, английские
  guardrail-описания (читает модель), scope read|write. Единственный DELETE —
  `delete_transaction`. Перевод отдельного тула НЕ имеет: `create_transaction`
  с `kind:"transfer"` + counter-полями (flat-схема подхватила их из openapi).
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
- `read` → публикуются РОВНО 16 read-инструментов; write-инструменты модели не
  видны вовсе. Это UX-фильтр; enforcement — ТОЛЬКО сервер (docs/backend.md,
  `pat_auth.py`: гейты allowlist/scope работают независимо от пакета).
- `full` → все 29, включая единственный необратимый `delete_transaction`
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
