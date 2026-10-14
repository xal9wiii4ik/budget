# Evals — fake/fake (categorize-v1)

> **SYNTHETIC RUN — not a model quality number.** The `fake`
> provider is a substring matcher in `llm/fake.py`; this report
> exists to show the pipeline and to pin its mechanics in CI.
> No real-model numbers exist until someone runs `--mode live`.

- mode: `replay`
- run at: 2026-10-14T16:37:07+00:00
- dataset: `owner-categorize-v1.jsonl` (215 rows), pending owner review
- confidence threshold: 0.7

## Accuracy

- **accuracy: 9.8%** (21/215)
- ambiguity ceiling: 86.5% — rows sharing a (text, kind) under different labels make the rest unreachable for ANY model
- unsure rate: 89.8% (193) — answered "none" or unusable; counted as wrong
- flagged for review: 89.8% (193) — below threshold or unsure
- unanswered rows: 0

## Cost and latency

- calls: 5
- cost: $0
- latency p50/p95: 0 ms / 0 ms

## By kind

| kind | rows | correct | accuracy |
| --- | --- | --- | --- |
| expense | 215 | 21 | 9.8% |

## By label

| label | kind | support | correct | accuracy |
| --- | --- | --- | --- | --- |
| Продукты | expense | 39 | 8 | 20.5% |
| Кафе и рестораны | expense | 38 | 0 | 0.0% |
| Транспорт | expense | 25 | 0 | 0.0% |
| Напитки | expense | 21 | 0 | 0.0% |
| Сигареты | expense | 20 | 13 | 65.0% |
| Вкусняшки | expense | 9 | 0 | 0.0% |
| Прочее | expense | 8 | 0 | 0.0% |
| Развлечения | expense | 8 | 0 | 0.0% |
| Расходники | expense | 6 | 0 | 0.0% |
| Алкоголь | expense | 5 | 0 | 0.0% |
| Налоги и комиссии | expense | 5 | 0 | 0.0% |
| Связь и интернет | expense | 5 | 0 | 0.0% |
| Дом и быт | expense | 4 | 0 | 0.0% |
| Образование | expense | 4 | 0 | 0.0% |
| Жильё | expense | 3 | 0 | 0.0% |
| Подарки | expense | 3 | 0 | 0.0% |
| Путешествия | expense | 3 | 0 | 0.0% |
| Документы | expense | 2 | 0 | 0.0% |
| Подписки | expense | 2 | 0 | 0.0% |
| Спорт | expense | 2 | 0 | 0.0% |
| Уход и красота | expense | 2 | 0 | 0.0% |
| Авто | expense | 1 | 0 | 0.0% |
