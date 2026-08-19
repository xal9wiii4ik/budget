# Implementation Plan (mcp): S3 read+stdio · S4 write · S5 док-страница
## Подход
Три чистых модуля (`openapi.ts` → `tools.ts` → `truncate.ts`) + тонкий `http.ts` и сшивающий
`index.ts`. Инструменты не пишутся руками: таблица architecture.md §4 живёт в `allowlist.ts`, схемы
строятся из закоммиченного `apps/api/openapi.json` в рантайме при старте (§5). Enforcement — только
сервер; пакет отвечает за форму вызова, объём ответа и человеческий текст ошибки.
## S3.1 Скелет пакета (§5)
- `package.json`: `@budget/mcp-server`, private, `type:module`, `bin:{"budget-mcp":"dist/index.js"}`,
  scripts build/lint/typecheck/test; deps `@modelcontextprotocol/sdk` (пин мажора), dev
  typescript/vitest/@types/node; `tsconfig.json` по образцу `packages/shared` + `outDir: dist`.
- **РЕШЕНИЕ: прекомпил в `dist`, не tsx** — Claude Desktop стартует бинарь как голый `node <abs>`
  вне pnpm-контекста: tsx стал бы рантайм-зависимостью и превращал ошибку типов в невидимый
  stdio-краш вместо красного `build`.
- `turbo.json`: `#build` (outputs `dist/**`), `#test` c `inputs:["$TURBO_ROOT$/apps/api/openapi.json",
  …]` — прецедент `@budget/api-client#test`, иначе кэш переживёт смену контракта.
- `#!/usr/bin/env node`, Node ≥22 (встроенный fetch). **stdout принадлежит транспорту**: ни одного
  `console.log`, весь лог в stderr — ловушка №1 stdio-серверов. `index.ts`: env → load+validate
  openapi → build tools → `McpServer` + `StdioServerTransport`; ошибка старта → stderr + exit 1.
## S3.2 Генератор (`openapi.ts` + `tools.ts`)
- Загрузка: `BUDGET_OPENAPI_PATH` ?? путь от `dist/` (`new URL('../../../apps/api/openapi.json',
  import.meta.url)`) — комментарием зафиксировать, что счёт `../` завязан на outDir. `resolveRef`
  разворачивает только `#/components/schemas/*`; неизвестный `$ref` или цикл → бросок с именем схемы.
- На запись allowlist берём `paths[path][method]` и собираем ОДИН плоский `inputSchema`
  (`type:'object'`, `additionalProperties:false`):
  - `parameters` с `in: path|query` → свойства, `required` из `parameter.required`;
  - `requestBody…['application/json'].schema` → разворачиваем `$ref` и **разливаем properties на
    верхний уровень** (не оборачивая в `body`): модели проще заполнять плоский объект, а коллизия
    имён тела и параметра ловится fail-fast при старте; `required` тела клеим к общему;
  - нормализация: выкидываем `title`; `anyOf:[X,{type:'null'}]` → `X` (поле и так не в `required`);
    сохраняем `format`/`pattern`/`enum`/`minimum`/`maximum`;
  - описания свойств openapi не несёт — берём из `params` allowlist, остальное без описания;
  - [ТРЕЙДОФФ] схлопывание null-ветки убирает ОЧИСТКУ поля в PATCH (`note:null`): в v1 omit = keep,
    очистки через MCP нет — сказано в описании update-инструментов.
- Результат: `BuiltTool {name, description, inputSchema, method, path, pathParams, queryParams,
  bodyProps}` — `http.ts` не разбирает openapi заново.
- **Fail-fast при старте**: отсутствующий путь/метод, неразрешимый `$ref`, коллизия имён,
  header-параметр — собираем ВСЕ ошибки и печатаем списком («allowlist рассинхронизирован с
  openapi.json — перегенерируйте контракт»), а не падаем на первой.
## S3.3 `allowlist.ts`
```ts
export type ToolSpec = {
  name: string;                        // 'list_transactions'
  method: 'get'|'post'|'patch'|'put';  // put только /limits/{category_id}
  path: string;                        // '/goals/{goal_id}/contributions'
  scope: 'read'|'write';
  description: string;                 // курируемая, уходит в MCP как есть
  params?: Record<string,string>;      // свойство -> курируемое описание
};
export const ALLOWLIST: readonly ToolSpec[] = [ /* 24 записи = §4 целиком */ ];
```
Состав строго по §4; единственный DELETE — `delete_transaction` (решение пользователя
2026-08-19), публикуется ТОЛЬКО full-токену. Тексты английские (их читает модель).
- **create_transaction**: «Record ONE transaction. Amounts are INTEGER MINOR UNITS with an explicit
  `currency`: 12.34 EUR → amount_minor 1234; JPY has no minor unit → 500 JPY is 500. Never do money
  math yourself — use convert_currency. BEFORE creating, call list_transactions for the same date and
  amount: if it is there do NOT duplicate — fix it with update_transaction; the id is echoed back.»
  ПАКЕТ (не модель) генерирует `client_id = crypto.randomUUID()` на каждый ЛОГИЧЕСКИЙ вызов
  инструмента и кладёт его в тело: ретрай транспорта с тем же client_id вернёт СОХРАНЁННУЮ строку
  (200), а не вторую операцию (B-1 в S1). `client_id` НЕ входит в inputSchema инструмента —
  модель его не видит и не подделает; генератор исключает это поле из схемы create_transaction.
- **update_transaction**: «Correct ONE existing transaction. Send only the fields that change; omitted
  fields keep their value. PREFER this tool over delete_transaction for fixing mistakes. Take
  transaction_id from list_transactions, never guess it.»
- **delete_transaction** (только full): «PERMANENTLY delete ONE transaction — the ONLY irreversible
  tool. Use it ONLY when the user has EXPLICITLY asked to delete this specific transaction. If in
  ANY doubt, first show the transaction you found (list_transactions) and ask the user to confirm.
  To fix mistakes prefer update_transaction. One entity per call — there is no bulk delete, no
  deletion by filter or by list of ids. Take transaction_id from list_transactions, never guess it.»
- **update_category**: «Rename or ARCHIVE one category. Archiving IS deletion in this product:
  categories are referenced by past transactions, so they are archived, not destroyed — history is
  preserved. There is no delete_category tool by design. System categories are read-only.»
- **convert_currency**: «Convert an amount between currencies at the server's daily rate. Use this for
  ANY cross-currency figure — never multiply amounts yourself. Minor units in and out.»
- **set_category_limit**: «Set the monthly limit for ONE category — a full upsert: what you send
  REPLACES the current limit. amount_minor is in the user's base currency, which the server stamps.
  Call list_limits first to see the current limit and this month's spend.»
Остальным — принцип: строка «что делает» из §4 + откуда взять id + `limit ≤ 100` у списочных.
## S3.4 `truncate.ts`
`THRESHOLD_BYTES = 50_000`, мерим `Buffer.byteLength(JSON.stringify(x))`. Ниже порога — объект как
есть, без пометок. Выше: берём самый длинный массив (топ-уровень или `items`), режем С ХВОСТА
уполовиниванием, пока не влезет, добавляем `_truncated:{shown,total,note:"response truncated, narrow
the query (dates/category/limit)"}`. Один элемент оставляем всегда: если и он перевешивает — отдаём
его с честной пометкой, а не пустоту. Чистый модуль без зависимостей → тестируем.
## S3.5 `http.ts`
- env: `BUDGET_API_URL` (default `http://localhost:8010`, срезаем хвостовой `/`), `BUDGET_PAT`
  обязателен — нет → fail-fast «выпустите токен в веб-«Настройках» и положите в BUDGET_PAT».
- Вызов: `pathParams` в шаблон, `queryParams` → querystring (undefined пропускаем), `bodyProps` →
  JSON-тело для POST/PATCH/PUT; `Authorization: Bearer <pat>`, таймаут 30 c.
- Ошибки — MCP tool-error (`isError:true` + текст), не бросок наружу: модель должна прочитать причину
  и исправиться. Маппинг: `TOKEN_INVALID` → «invalid or revoked — issue a new token in Settings and
  update BUDGET_PAT»; `TOKEN_SCOPE_READONLY` → «your token is read-only — create a `full` token in Settings»;
  `TOKEN_ENDPOINT_FORBIDDEN` → «not available to API tokens» (код `TOKEN_METHOD_FORBIDDEN`
  отменён, см. plan.md); `RATE_LIMITED`
  (429) → «wait a minute»; `*_NOT_FOUND` → «not found (missing or not yours)» одинаково для обоих
  случаев (no-oracle не размываем); 422 pydantic → строки `loc: msg`; НЕИЗВЕСТНЫЙ код отдаём
  дословно; сбой сети → «cannot reach the Budget API at <url> — is the server running?».
## S3.6 Фильтрация по scope — РЕШЕНО (пользователь, 2026-08-19): self-introspection
S1 даёт `GET /tokens/self` — PAT-доступный, возвращает `{id, scope}` СВОЕГО токена
(architecture §4; единственное исключение на /tokens/*, эскалации нет: токен узнаёт лишь
собственные права). Флоу старта в `index.ts`: ПЕРЕД регистрацией инструментов `http.ts` зовёт
`/tokens/self` — (а) это заодно fail-fast валидация PAT (401 `TOKEN_INVALID` → внятный stderr
«token invalid or revoked — issue a new one in Settings», exit 1; сеть недоступна → «is the
server running?», exit 1); (б) `scope=read` → регистрируются только 13 read-инструментов,
`scope=full` → все 24 (в т.ч. `delete_transaction`; read-токен его НЕ видит вовсе). Модель никогда не видит инструменты, которые ей заведомо запрещены, —
нет циклов «вызов → 403». Env-костыль `BUDGET_SCOPE` НЕ нужен — убран. Серверный гейт остаётся
единственным enforcement; текст `TOKEN_SCOPE_READONLY` в http.ts сохраняем как страховку
(смена scope невозможна, но токен могли отозвать и перевыпустить между стартами).
## S4 — почему тонкий слой
Тот же `ALLOWLIST`, генератор и `http`: `requestBody` и JSON-тело живут в коде с S3 (одна ветка), а
записи `scope:'write'` включаются и получают guardrail-описания в S4. Новый код ≈ 0–1 файл; работа —
тексты (минорные единицы + currency, «сначала list — не дублируй», «исправляй через update», одна
сущность за вызов) и проверка, что PATCH-схемы после нормализации не требуют лишних полей. Вся
безопасность (scope-гейт, rate limit, аудит) уехала в S1/FULL.
## S5 — док-страница
**РЕШЕНИЕ: `packages/mcp-server/README.md`, не `docs/mcp.md`** — `docs/*` это мини-доки ДЛЯ АГЕНТОВ с
потолком 150 строк, а тут пользовательская инструкция; указатели строкой в `docs/infra.md` и
`docs/web.md` дописывает senior-lead при закрытии скоупа. Содержимое: выпуск токена (веб → Settings →
scope read/full, строка показывается один раз); `pnpm --filter @budget/mcp-server build`;
сниппет `claude_desktop_config.json` (`mcpServers.budget={command:"node", args:["<abs>/packages/
mcp-server/dist/index.js"], env:{BUDGET_API_URL,BUDGET_PAT}}`); `claude mcp add budget --env
BUDGET_API_URL=… --env BUDGET_PAT=… -- node <abs>/dist/index.js`; таблица env (+`BUDGET_OPENAPI_PATH`); §4-таблица инструментов; troubleshooting (TOKEN_INVALID, read-only токен, API не
поднят, устаревший openapi.json → `pnpm openapi` + rebuild).
## Тесты (vitest, node-only, рядом с модулями)
- `tools.test.ts` — генератор по маленькой рукописной фикстуре: path+query параметры, `$ref` в
  requestBody, схлопывание `anyOf[X,null]`, склейка `required`, коллизия имён → бросок.
- `truncate.test.ts` — под порогом объект не меняется вовсе; над порогом режется с хвоста,
  `_truncated.shown` = фактической длине, первый элемент на месте.
- `allowlist.test.ts` — валидация против РЕАЛЬНОГО `apps/api/openapi.json`: дрифт-гард (эндпоинт
  переименовали → красный тест, а не сломанный старт у пользователя).
Не пишем: таблицу код→текст `http.ts` (вакуумно), сшивку `index.ts`, обёртки SDK.
## Открытые вопросы — РЕШЕНЫ (2026-08-19)
1. Схлопывание null-ветки (нет очистки поля через PATCH в v1) — принято senior-lead.
2. Scope-фильтрация — решение пользователя: introspection через `GET /tokens/self`,
   см. S3.6; `BUDGET_SCOPE` убран.
3. Порог 50KB — стартовое значение §5, уточним после первых живых ответов.
## Риски
- Путь к `openapi.json` из `dist/` — вероятнейшая поломка при переносе пакета; прикрыт env-override
  и внятной ошибкой старта. `console.log` в любой зависимости ломает stdio-протокол.
- Мажор `@modelcontextprotocol/sdk` меняет API регистрации; S3/S4 не проверить без живого S1-токена —
  до него только юнит-гейты.
