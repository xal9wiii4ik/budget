# grooming-review.md — scope mcp-server (PLAN 5.6)

Вердикт: ГРУММИНГ ЗАВЕРШЁН, решения пользователя (2026-08-19) внесены во все
артефакты. Имплементация НЕ начата — ждёт отдельного апрува пользователя.

## Команда и артефакты
- architect → `architecture.md`; backend-engineer → `plan.md` (S1);
  frontend-engineer → `plan-web.md` (S2), `plan-mcp.md` (S3–S5);
  qa-engineer → `qa-checklist.md` (18 TC: STOP-probe S1 ×4, S3 ×2, финал ×12).
  Мобильная команда не привлекалась.

## Решения пользователя (внесены, авторитетны)
1. **Скоупы токена: `read` | `full`** (не read_write). `read` — 13 read-инструментов;
   `full` — всё, включая деньги и запись. Модель с запасом под будущее дробление:
   scope — String(32)-enum, гранулярные скоупы позже расширяют CHECK без смены
   схемы (architecture §1).
2. **Self-introspection `GET /tokens/self`** — следствие №1: MCP-сервер при старте
   узнаёт scope и НЕ публикует write-инструменты read-токену (нет циклов
   «вызов → 403»). PAT-доступный, отдаёт ТОЛЬКО `{id, scope}` своего токена — ни
   списка, ни plaintext, ни записи; токен узнаёт лишь собственные права, которые
   и так выяснил бы пробным вызовом → эскалации нет. Единственное исключение из
   «никогда»-списка на `/tokens/*`; заодно fail-fast валидация PAT при старте
   (plan-mcp S3.6). Серверный PAT-allowlist = 24 пары (23 инструмента + self).
3. **Аудит — таблица `pat_audit_log`** (переопределяет log-only), та же миграция
   0007. Строка на каждый PAT-вызов: token_id, user_id, occurred_at, method,
   path (шаблон роута, не сырой URL), status_code, entity_id (write: PATCH/PUT —
   из path, POST — из JSON-ответа). Один индекс (token_id, occurred_at). Пишет
   ASGI-middleware со своей сессией, ошибка вставки не валит запрос; тела
   запросов/ответов НЕ хранятся, объём ограничен rate-limit'ами; retention —
   ручной SQL-prune до фазы 2. Просмотр — только SQL в v1 (read-эндпоинт без
   UI-читателя — мёртвая поверхность; добавит HTTP-фаза 2). architecture §6.

## Решения senior-lead (ранее, в силе)
- Fail-closed allowlist пар (метод, путь) в PAT-ветке; `TOKEN_METHOD_FORBIDDEN`
  отменён. DELETE недоступен любому токену.
- `tokenFormSchema` рядом с фичей в apps/web; схлопывание null-ветки в PATCH
  (через MCP поле меняется, но не очищается — v1); порог усечения 50KB стартовый.
- Без `expires_at` в v1 (ручной revoke, last_used_at виден); TTL — фаза 2.
- `users/me` исключён из allowlist (валюта в `stats/summary.currency`).

## Известный принятый риск
Два allowlist'а (pat_auth.py и packages/mcp-server) из одной таблицы §4; каждый
сверяется с openapi.json своим тестом, но не друг с другом. Дрейф проявится как
явный 403 (fail-closed), не как дыра; ловится финальным QA.

## Подзадачи, тиры, оценки
Оценки разделены: «написание» — агент-минуты чистого кодинга; «гейты» — прогоны
pytest/turbo/regen на круг; «верификация» — ревью/пробы. В часы НЕ суммируются:
wall-clock скоупа определяется числом дефект-кругов (каждый круг ≈ +10–15 мин),
при 0–2 кругах весь скоуп закрывается за один вечер.

| ID | Что | Тир | Токены | Написание | Гейты/круг | Верификация |
|---|---|---|---|---|---|---|
| S1 | PAT-бэкенд: 0007 (PAT + pat_audit_log), pat_auth, аудит-middleware, /tokens (+/self), rate limit, regen | FULL | 100–130k | 15–20 мин | 5–10 мин (pytest+regen+turbo) | STOP-probe ~10 мин + code-review+мета 10–15 мин |
| S2 | Веб-«Настройки» | STANDARD | 50–70k | 10–15 мин | 3–5 мин | self-review ~5 мин; web-qa — в финале |
| S3 | mcp-server read + stdio + introspection | STANDARD | 60–80k | 15–20 мин | ~5 мин | STOP-probe ~10 мин |
| S4 | write-инструменты + guardrail-описания | STANDARD | 25–40k | 5–10 мин | 3–5 мин | покрыт финальным QA |
| S5 | README-конфиг Claude Desktop/Code | FAST | 10–15k | ~5 мин | — | вычитка оркестратором |
| QA | финальный прогон 18 TC + web-qa F-1 | — | 60–90k | — | — | 20–30 мин live + ~10 мин web-qa |

**Итого ~305–425k токенов.** Порядок: S1 → (S2 ∥ S3) → (S4 ∥ S5) → финальный QA;
генератор/truncate/allowlist S3 пишутся параллельно S1 по закоммиченному openapi.json.

## Открытых вопросов НЕТ
Все прежние вопросы закрыты решениями пользователя от 2026-08-19 (см. выше и
architecture §9). Апрув на СТАРТ ИМПЛЕМЕНТАЦИИ — отдельным решением пользователя.

## Артефакты
`.tasks/mcp-server/`: task.md · architecture.md · plan.md · plan-web.md ·
plan-mcp.md · qa-checklist.md · grooming-review.md (этот файл).
