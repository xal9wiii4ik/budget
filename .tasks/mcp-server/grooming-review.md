# grooming-review.md — scope mcp-server (PLAN 5.6)

Вердикт: ГРУММИНГ ЗАВЕРШЁН. Имплементация НЕ начата — ждёт апрува пользователя
(в первую очередь таблицы инструментов, architecture.md §4).

## Команда и артефакты
- architect → `architecture.md` (таблица PAT, PAT-auth, scope-модель, таблица
  инструментов, пакет, guardrails).
- backend-engineer → `plan.md` (S1); frontend-engineer → `plan-web.md` (S2) и
  `plan-mcp.md` (S3–S5); qa-engineer → `qa-checklist.md` (17 TC: STOP-probe S1 ×4,
  STOP-probe S3 ×2, финальный прогон ×11). Мобильная команда не привлекалась.

## Решения senior-lead поверх планов (авторитетны)
1. **Fail-closed allowlist** (моя поправка к architecture §3, принята в plan.md):
   PAT-ветка пускает только пары (метод, путь) из таблицы §4; всё вне списка →
   403 `TOKEN_ENDPOINT_FORBIDDEN`. Код `TOKEN_METHOD_FORBIDDEN` отменён; все три
   артефакта синхронизированы.
2. Аудит write'ов (plan.md OQ1): строка ДО хендлера (логгер `pat_audit`, INFO,
   только write: token_id/user_id/method/path). Статус ответа и id сущности —
   фаза 2, middleware ради них не заводим.
3. `tokenFormSchema` живёт рядом с фичей в apps/web, НЕ в packages/shared
   (plan-web OQ1): второго потребителя нет, мобилка заморожена.
4. Scope-фильтрация инструментов в MCP (plan-mcp OQ2): по умолчанию регистрируем
   все 23 и честно отдаём текст `TOKEN_SCOPE_READONLY`; опциональный env
   `BUDGET_SCOPE=read` прячет write-часть. Introspection-эндпоинт не заводим.
5. Схлопывание null-ветки в PATCH-схемах (plan-mcp OQ1): принято для v1 —
   через MCP поле можно изменить, но не очистить; зафиксировано в описаниях.
6. Порог усечения 50KB — стартовое значение, тюнингуется по живым ответам.

## Известный принятый риск
Два allowlist'а (PAT_ALLOWLIST в pat_auth.py и ALLOWLIST в packages/mcp-server)
из одной таблицы §4; каждый сверяется с openapi.json своим тестом (pytest №11 и
allowlist.test.ts), но не друг с другом. Дрейф проявится как явный 403 с внятным
текстом, не как дыра (fail-closed) — ловится финальным QA.

## Подзадачи, тиры, оценки

| ID | Что | Тир | Зависимости | Токены | Время |
|---|---|---|---|---|---|
| S1 | PAT-бэкенд: миграция 0007, pat_auth, /tokens, rate limit, regen | **FULL** (миграция+auth+контракт) | — | ~90–120k | 2–2.5 ч |
| S2 | Веб-«Настройки»: создание/одноразовый показ/список/отзыв | STANDARD | S1 (regen) | ~50–70k | 1–1.5 ч |
| S3 | packages/mcp-server: генератор, read-инструменты, stdio | STANDARD | live-проверка ждёт S1; генератор/truncate/allowlist пишутся ∥ S1 по закоммиченному openapi.json | ~60–80k | 1.5–2 ч |
| S4 | write-инструменты + guardrail-описания | STANDARD (вся серверная безопасность уже в S1/FULL; S4 — тонкий TS-слой, live write покрыт финальным QA) | S3 | ~25–40k | 0.5–1 ч |
| S5 | README пакета: конфиг Claude Desktop/Code, env, troubleshooting | FAST | S3 | ~10–15k | ~0.5 ч |
| QA | STOP-probes (S1, S3) + финальный прогон + web-qa F-1 | — | конец скоупа | ~60–90k | 1–1.5 ч |

**Итого: ~300–420k токенов, ~5–7 ч wall-clock** при параллели S2∥S3 и S4∥S5.
Порядок: S1 → (S2 ∥ S3) → (S4 ∥ S5) → финальный QA.

## Открытые вопросы ПОЛЬЗОВАТЕЛЮ (апрув плана = ответ на них)

1. **Таблица инструментов** (architecture.md §4): 23 инструмента = 13 read +
   10 write; DELETE недоступен любому токену (исправления — через update);
   «никогда»: auth, users, tokens, receipts, advisor, export.
   **Рекомендация: утвердить как есть.**
2. **users/me GET исключён** из read-списка (отклонение от исходной рамки):
   в UserRead нет базовой валюты, а стоковый fastapi-users-роутер не принимает
   PAT структурно; валюта приходит в `get_stats_summary.currency`.
   **Рекомендация: согласиться с исключением.**
3. **Срок жизни токена**: v1 без `expires_at` — ручной отзыв в UI, `last_used_at`
   виден. **Рекомендация: без TTL; добавить в HTTP-фазе 2.**
4. **Аудит**: log-only (structured-строки), без отдельной таблицы — локальная
   однопользовательская инсталляция. **Рекомендация: log-only; таблица — фаза 2.**
5. **Идемпотентность записи**: v1 без серверной дедупликации (client_id придёт
   со скоупом 5.5); митигируется write-rate-limit 20/min + guardrail-описаниями
   («сначала list, исправляй через update»). **Рекомендация: принять; настоящую
   дедупликацию строить в 5.5, не одноразовый суррогат сейчас.**

## Артефакты
`.tasks/mcp-server/`: task.md · architecture.md · plan.md · plan-web.md ·
plan-mcp.md · qa-checklist.md · grooming-review.md (этот файл).
