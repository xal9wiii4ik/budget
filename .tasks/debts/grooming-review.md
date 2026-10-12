# grooming-review.md — скоуп `debts`

Дата: 2026-10-12. Решения владельца из task.md не переоткрывались.
Архитектура: `architecture.md` (представление (A): движение долга = обычная
строка `transactions` kind expense|income + тройка `debt_id/debt_role/
debt_amount_minor`; `debts` без денежных колонок; остаток/статус — производные;
одна точка исключения `tx_totals`).

## Команда
- architect — да (новая таблица, представление в леджере, контракт).
- backend-engineer — B1; frontend-engineer — W1 (параллельно против контракта
  из architecture.md); qa-engineer — чеклист API (FULL) + прогон в конце;
  web-qa — чеклист + прогон в конце; code-reviewer — только B1.
- НЕ: mobile-engineer/mobile-qa — мобилка заморожена, нужен только typecheck
  после регенерации контракта (гоняет senior-lead).

## Вердикт senior-lead по архитектуре
Принята. Поправки:
1. Кросс-валютное движение — ЯВНЫЙ второй amount (прецедент transfer), без
   снапшота курса: отклонение от двух опций брифа, принято как более простое
   правило, одно для всех движений, в т.ч. открывающего. Веб префиллит из
   `/fx/convert`.
2. Имя инструмента `record_repayment` → `record_debt_repayment` (плоский список
   инструментов, «repayment» без «debt» двусмысленно рядом с contributions).
3. Навигация: группа Money, после `/deposits`.
4. Сторож replace в statement-import щадит debt-строки — это корректность
   (удаление principal-строки осиротило бы долг), остаётся в скоупе.

## Тиры ревью
| Подзадача | Тир | Причина |
|---|---|---|
| B1 — миграция 0017, enums, модели, domain/services/router, гарды в transactions/export/statement-import, push-семейство, MCP-маркеры, контракт, тесты | FULL | миграция, деньги, смена контракта |
| W1 — страница /debts (две группы + закрытые + сводка), формы долга/возврата, история, nav, блок «Скоро», бейдж в списке операций, i18n | STANDARD | UI в отгруммленном скоупе, денег не считает; self-review `/review-pr` |

## MCP/PAT
Инструменты: `list_debts`, `get_debt` (read), `create_debt`, `update_debt`,
`record_debt_repayment` (write, два POST с managed `client_id`). `# MCP: no`:
DELETE /debts/{id}, PATCH/DELETE repayments (причины в architecture.md).
Пины: `test_pat_auth` 38→43 / NEVER_PAT 27→30; `test_mcp_tools` 20→22 / 35→40.

## Оценки (агент-минуты: написание / гейты / верификация)
| | Написание | Гейты | Верификация |
|---|---|---|---|
| B1 | 60 + 30 тесты | 15 (4 потребителя контракта, pytest) | 20 + 1 круг фикса при functional |
| W1 | 50 | 10 | 30 (браузерный прогон) |

Параллель: W1 стартует сразу с локальным тип-дублем контракта
(`features/debts/types.ts`), замена на сгенерированный — первый шаг после B1.
pytest/vitest не делят БД, конфликта нет.

## QA cadence
Полный прогон qa-checklist.md + qa-web-checklist.md — один раз в конце скоупа
на throwaway-стенде (API 8021, vite 5199, отдельная БД). Mid-scope STOP-probe —
нет (внешних интеграций нет; push покрыт pytest через FakePushSender).

## Решения по открытым вопросам брифа (одной строкой)
- Представление: (A), строки transactions + link-тройка; `_NOT_TRANSFER` →
  `_NOT_TRANSFER_OR_DEBT` в тех же четырёх проходах.
- Валюта: одна у долга, immutable; движение с другого счёта — оба amount от
  пользователя, без курса.
- Переплата: 422 `DEBT_REPAYMENT_EXCEEDS_REMAINING` / `DEBT_PRINCIPAL_BELOW_REPAID`
  под `FOR UPDATE`.
- Закрытие: производное (remaining == 0), `closed_on` = дата последнего возврата;
  закрытый редактируется (note/срок/контрагент), удаление возврата открывает его.
- Правка/удаление через /transactions: 422 `DEBT_MOVEMENT_READONLY`.
- Удаление долга: реальный DELETE с каскадом движений (балансы откатываются).
- Срок: четвёртое семейство в push_jobs/push_digest (имена, без сумм), веб —
  клиентский фильтр кешированного списка (близнец depositDeadlines).
- Сводка: поля `summary` на `GET /debts` (open-долги, курс на сегодня,
  unconverted-счётчики по сторонам).
