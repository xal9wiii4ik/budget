# review-b1.md — code review подзадачи B1 (backend core), 2026-08-24

Ревьюер: code-reviewer (FULL tier). Гейты НЕ перегонялись ревьюером (правило
2026-08-17) — авторитетный прогон у senior-lead: 511 pytest, ruff, pyright,
alembic up/down/check, четыре потребителя контракта (два известных красных:
веб-фикстуры → W1/W2, mcp drift-сторож → B4).

## Findings

1. **MAJOR (test-coverage)** — `tests/test_goal_items.py`, TestDelete. Гарантия
   У2 (`paid_by_anc` GROUP BY (anc, cur) перед `jsonb_object_agg`) реализована,
   но не запинена на уровне дерева: ни один тест не читает rollup paid узла с
   двумя потомками-плательщиками. `jsonb_object_agg` с дублем ключа молча
   оставляет последний — снятие GROUP BY роняет деньги при зелёной сюите.
   Фикс: одна pre-delete assertion на paid_minor предка в TestDelete.
2. **MINOR (concurrency)** — `routers/goal_items.py::_apply_move`. FOR UPDATE
   возвращает строки из identity map без refresh → после ожидания чужого move
   swap может записать устаревший sort_order; плюс голый `next(...)` даёт
   StopIteration → 500 при конкурентном удалении. Фикс: populate_existing +
   next(..., None) → 404.
3. **MINOR (hardening)** — `_TREE_SQL.paid_direct` без owner-предиката на
   transactions (в отличие от `_PAID_BY_GOAL_SQL`). Фикс: `tx.user_id = g.user_id`.
4. **MINOR (semantics, flag)** — план без оценённых листьев → effective target 0
   → `completed=true` при нуле накоплений. Следствие сознательной 0-ветки
   домена; передано в W1 (предупреждение перехода).
5. **NIT** — нет индекса на `goal_item_files.user_id` (FK CASCADE от users).
6. **NIT** — порядок cycle/depth внутри одного walk отличается от plan §1.4;
   cycle-first разумнее. Record-only.

## Чисто по областям

БД-гарантии (У1 составной FK, скаляр+CHECK+SET NULL, триггер §2, симметричный
downgrade); рекурсивный CTE (unnest-rollup, У2, Д1 три ступени, один курс на
корзину, честные счётчики, per-node planned_unconverted_count); наследование
срока без материализации; goal_reads (байт-в-байт для целей без пунктов, ladder
от effective − paid, нет поля paid+saved); гарды (404-до-archived, no-oracle,
move no-op, subtree-фильтр list/export, PAT без DELETE); сквозное (bound params,
нет N+1, autoflush под _cycle_guard, конверт ошибок, консистентность пары
контракта).

**Вердикт: блокеров нет.** Финдинги 1–3, 5 — в фикс-раунд; 4 — W1; 6 — record.
