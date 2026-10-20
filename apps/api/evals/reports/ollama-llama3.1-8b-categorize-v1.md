# Evals — ollama/llama3.1:8b (categorize-v1)

- mode: `record`
- run at: 2026-10-20T13:49:26+00:00
- dataset: `owner-categorize-v1.jsonl` (215 rows), owner-reviewed 2026-10-14
- confidence threshold: 0.7

## Accuracy

- **accuracy: 47.0%** (101/215)
- ambiguity ceiling: 86.5% — rows sharing a (text, kind) under different labels make the rest unreachable for ANY model
- unsure rate: 18.1% (39) — answered "none" or unusable; counted as wrong
- flagged for review: 27.4% (59) — below threshold or unsure
- unanswered rows: 0

## Cost and latency

- calls: 5
- cost: $0
- latency p50/p95: 25804 ms / 33807 ms

## By kind

| kind | rows | correct | accuracy |
| --- | --- | --- | --- |
| expense | 215 | 101 | 47.0% |

## By label

| label | kind | support | correct | accuracy |
| --- | --- | --- | --- | --- |
| Продукты | expense | 39 | 31 | 79.5% |
| Кафе и рестораны | expense | 38 | 26 | 68.4% |
| Транспорт | expense | 25 | 14 | 56.0% |
| Напитки | expense | 21 | 0 | 0.0% |
| Сигареты | expense | 20 | 13 | 65.0% |
| Вкусняшки | expense | 9 | 1 | 11.1% |
| Прочее | expense | 8 | 2 | 25.0% |
| Развлечения | expense | 8 | 0 | 0.0% |
| Расходники | expense | 6 | 0 | 0.0% |
| Алкоголь | expense | 5 | 1 | 20.0% |
| Налоги и комиссии | expense | 5 | 2 | 40.0% |
| Связь и интернет | expense | 5 | 2 | 40.0% |
| Дом и быт | expense | 4 | 0 | 0.0% |
| Образование | expense | 4 | 0 | 0.0% |
| Жильё | expense | 3 | 3 | 100.0% |
| Подарки | expense | 3 | 0 | 0.0% |
| Путешествия | expense | 3 | 2 | 66.7% |
| Документы | expense | 2 | 0 | 0.0% |
| Подписки | expense | 2 | 1 | 50.0% |
| Спорт | expense | 2 | 1 | 50.0% |
| Уход и красота | expense | 2 | 2 | 100.0% |
| Авто | expense | 1 | 0 | 0.0% |
