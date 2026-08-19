# task.md — scope mcp-server (PLAN 5.6)

## Что строим
MCP-сервер (stdio, локально), через который AI-клиенты (Claude Desktop/Code)
читают И пишут данные бюджета от лица пользователя. Выпуск PAT — только живой
сессией из веб-«Настроек». Мобилка НЕ затрагивается вообще.

## Изменение против прежней договорённости
Запись (create/update) входит в v1 — пользователь явно попросил «чтение и
обновление». HTTP-транспорт и деплой остаются фазой 2.

## Зафиксировано ранее (не переоткрывать)
- Гибрид: инструменты генерируются динамически из закоммиченного
  `apps/api/openapi.json` + allowlist + курируемые описания + лимит объёма
  ответа. Никаких ручных хендлеров по эндпоинту.
- PAT: таблица `personal_access_tokens` (user_id, token_hash, scope,
  revoked_at, last_used_at). MCP ходит в наш же API; скоупинг по user_id
  работает штатно.
- Токеном нельзя выпустить/отозвать токен (нет эскалации). Выпуск — только
  JWT-сессией.
- Веб-UI: «Создать токен», строка показывается ОДИН раз, список с last_used
  и отзывом.
- Пакет: `packages/mcp-server` (TypeScript, pnpm workspace).

## Рамка решений для грумминга (моя, senior-lead; финально утверждает пользователь)

### Allowlist v1 (предварительный — архитектор уточняет, пользователь утверждает)
- READ: transactions list/summary, categories list, goals (list/get/progress/
  contributions list), limits list, recurring list, stats (summary/monthly/
  top-merchants), fx convert, users/me (GET — базовая валюта для контекста).
- WRITE: transactions create/patch; categories create/patch; recurring
  create/patch; limits PUT; goals create/patch + contributions create.
- НИКОГДА: /auth/*, /users/me PATCH (email/пароль), /users/{id}/*, /tokens/*
  (эскалация), /receipts/* (бинарный флоу), /advisor/* (вложенный AI/SSE),
  /transactions/export (стриминговый CSV, объём).
- DELETE — не даём в v1 вообще (включая limits DELETE): разрушительные
  действия через AI — максимальный риск, update покрывает исправления.

### Модель прав
Два скоупа: `read` | `read_write`. Выбор радио-кнопкой при создании токена,
default read. Enforcement НА СЕРВЕРЕ per-call: PAT-auth dependency +
метод-гейт (POST/PATCH/PUT требуют read_write, 403 TOKEN_SCOPE_READONLY).
MCP-пакет дополнительно фильтрует набор инструментов по скоупу.

### Защитные механизмы (паранойя оправдана — деньги)
- Rate limit per PAT (slowapi, ключ = token id): reads ~60/min, writes ~20/min.
- Никаких batch-инструментов; write-инструменты строго одна сущность за вызов.
- Потолок ответа: limit ≤ 100 на списках, усечение тела с честной пометкой.
- Идемпотентность/аудит — проработать в architecture.md (см. открытые вопросы).

### Инварианты (write не должен их сломать)
Сервер остаётся единственной точкой валидации: pydantic-схемы, минорные
единицы, снапшот курса, user_id-скоупинг через PAT.user_id, no-oracle 404 —
всё проходит насквозь. Курируемые описания инструментов обязывают модель
передавать amount_minor + currency и пользоваться fx/convert вместо
самостоятельной арифметики.

## Подзадачи (тиры — предварительные, финал в grooming-review.md)
- S1 PAT-бэкенд: миграция 0007, /tokens router, PAT-auth, scope-гейт,
  rate limits, contract regen — FULL.
- S2 Веб-«Настройки»: создание/одноразовый показ/список/отзыв — STANDARD.
- S3 packages/mcp-server, read-инструменты + stdio — STANDARD.
- S4 write-инструменты + guardrails — тир решается в грумминге.
- S5 конфиг-докстраница Claude Desktop/Code — FAST.

## Артефакты
`architecture.md` (architect), `plan.md` (backend), `plan-web.md` +
`plan-mcp.md` (frontend), `qa-checklist.md` (qa-engineer),
`grooming-review.md` (senior-lead). Имплементация — ТОЛЬКО после апрува
пользователем.
