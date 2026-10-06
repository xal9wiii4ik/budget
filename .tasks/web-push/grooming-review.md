# Grooming review: web-push (2026-10-06)

Скоуп: Web Push + VAPID для веба (PLAN.md 5.2). Мобилка вне скоупа (PM), только typecheck.
Команда грумминга: architect (две таблицы, третий джоб, внешний seam, контракт), backend-engineer,
frontend-engineer, qa-engineer (FULL → стоп-пробы). Исключены: mobile-engineer/mobile-qa (мобилка
не трогается), web-qa на грумминге (чеклист пишет и гонит одним прогоном после W1).

## Подзадачи

| ID | Состав | Тир | Оценка (а-мин: письмо/гейты/верификация) | Зависимости |
|---|---|---|---|---|
| B1 | 0015 (две таблицы) + Settings + `push_sender` + `push_digest` + `recurring_reads` (вынос) + `push_jobs` + `/push/*` + шедулер + 15 тестов + регенерация контракта | FULL | 25 / 10 / 20 (+1 круг, если стоп-пробы найдут functional) | нет |
| W1 | `sw.js` push/notificationclick + `data/push.ts` + `notificationsState`/`pushKeys`/`useNotifications` + `NotificationsSection` + i18n + 4 теста | STANDARD | 20 / 5 / 15 | typecheck только после regen B1; пишется параллельно |

Порядок: B1 ∥ W1 → гейт senior-lead на оба диффа → qa-engineer (стенд 8021, ~10 стоп-проб) ∥ web-qa
(vite 5199) → code-reviewer только на B1 → мета-ревью только при находках → docs/.

## Решения по открытым вопросам планов

1. **SSRF через `endpoint`** (plan.md OQ-1, qa-checklist Q1) — ПРИНЯТО в минимальной форме: роутер
   проверяет чистой функцией `endpoint_allowed(url, *, allow_insecure)` — только `https`, хост не
   литеральный IP и не `localhost`; отказ → 422 `PUSH_ENDPOINT_INVALID` (anyOf-объявление по дому).
   Вендорный allowlist хостов НЕ делаем: он ломает легитимные браузеры (Samsung, UnifiedPush, будущие).
   Для стенда QA — настройка `push_allow_insecure_endpoints: bool = False` (имя кричит о назначении),
   стенд ставит `true`, чтобы локальный стаб 127.0.0.1 остался живой стоп-пробой. +1 тест: http/IP → 422.
2. **Таймаут** (qa Q2) — уже в плане: `timeout=10` → `failed`.
3. **Разделение сессий B (чтение) / C (запись)** в джобе — принято (правило fx_jobs).
4. **`DigestInput.on: date`** для тега — принято.
5. **Порядок арм** (plan-web OQ-1): `ios-not-installed → unsupported → server-off → denied → on|off` —
   ПРИНЯТО; довод верный (iOS-вкладка не экспортирует PushManager, иначе каждый iPhone получал бы тупик).
6. **Ротация VAPID-ключа при ресинке** (plan-web OQ-2) — ПРИНЯТО: сравнить `applicationServerKey`
   с `public_key`, при расхождении — локальный unsubscribe + POST unsubscribe → арм `off`. Бэкенд-план
   независимо назвал тот же риск (старые подписки → 403 → `failed` навсегда).
7. **Горизонт** = 1 день единообразно для всех семей (архитектура §4). Следствие: напоминание цели
   приходит на D-1 и D. Правило «только reminder_date == today» НЕ вводим — это было бы второе
   определение «скоро», которое PM запретил; `push_reminder_horizon_days` — рычаг.
8. **Ресинк подписки** — только при монтировании секции (не при каждом старте приложения): язык
   доходит до джоба через `profile.language`, который уже PATCH'ит LanguageSection.

## Что уходит оркестратору (env/compose)
`apps/api/.env`: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT=mailto:…`,
`PUSH_SCHEDULER_ENABLED` (по умолчанию true в коде). Compose: если API-контейнер читает `.env`
через `env_file`, добавлять нечего; иначе — прокинуть те же четыре переменные. Точные строки —
в финальном отчёте после B1 (генератор ключей проверяется при установке pywebpush).

## Артефакты
architecture.md, plan.md, plan-web.md, qa-checklist.md (стоп-пробы CT-1…CT-10, стенд: БД
`budget_qa_push`, API 8021, стаб 8097).
