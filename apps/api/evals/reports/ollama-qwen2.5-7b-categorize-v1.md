# Evals — ollama/qwen2.5:7b (categorize-v1)

- mode: `record`
- run at: 2026-10-20T13:39:43+00:00
- dataset: `owner-categorize-v1.jsonl` (215 rows), owner-reviewed 2026-10-14
- confidence threshold: 0.7

## Accuracy

- **accuracy: 39.1%** (84/215)
- ambiguity ceiling: 86.5% — rows sharing a (text, kind) under different labels make the rest unreachable for ANY model
- unsure rate: 1.4% (3) — answered "none" or unusable; counted as wrong
- flagged for review: 1.9% (4) — below threshold or unsure
- unanswered rows: 0

## Cost and latency

- calls: 5
- cost: $0
- latency p50/p95: 20225 ms / 29454 ms

## By kind

| kind | rows | correct | accuracy |
| --- | --- | --- | --- |
| expense | 215 | 84 | 39.1% |

## By label

| label | kind | support | correct | accuracy |
| --- | --- | --- | --- | --- |
| Продукты | expense | 39 | 24 | 61.5% |
| Кафе и рестораны | expense | 38 | 13 | 34.2% |
| Транспорт | expense | 25 | 14 | 56.0% |
| Напитки | expense | 21 | 0 | 0.0% |
| Сигареты | expense | 20 | 15 | 75.0% |
| Вкусняшки | expense | 9 | 0 | 0.0% |
| Прочее | expense | 8 | 1 | 12.5% |
| Развлечения | expense | 8 | 1 | 12.5% |
| Расходники | expense | 6 | 0 | 0.0% |
| Алкоголь | expense | 5 | 0 | 0.0% |
| Налоги и комиссии | expense | 5 | 2 | 40.0% |
| Связь и интернет | expense | 5 | 5 | 100.0% |
| Дом и быт | expense | 4 | 0 | 0.0% |
| Образование | expense | 4 | 1 | 25.0% |
| Жильё | expense | 3 | 0 | 0.0% |
| Подарки | expense | 3 | 0 | 0.0% |
| Путешествия | expense | 3 | 2 | 66.7% |
| Документы | expense | 2 | 0 | 0.0% |
| Подписки | expense | 2 | 2 | 100.0% |
| Спорт | expense | 2 | 2 | 100.0% |
| Уход и красота | expense | 2 | 2 | 100.0% |
| Авто | expense | 1 | 0 | 0.0% |
