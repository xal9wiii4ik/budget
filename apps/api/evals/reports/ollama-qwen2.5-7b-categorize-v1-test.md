# Evals — ollama/qwen2.5:7b (categorize-v1)

- mode: `record`
- run at: 2026-10-20T14:29:12+00:00
- dataset: `owner-categorize-v1.jsonl` (63 rows scored), owner-reviewed 2026-10-14
- split: `test` — 152 history rows (the example pool), 63 test rows, disjoint by construction
- prompt sent: `categorize-v1`
- examples per call: 0.0
- confidence threshold: 0.7

## Accuracy

- **accuracy: 49.2%** (31/63)
- ambiguity ceiling: 87.3% — rows sharing a (text, kind) under different labels make the rest unreachable for ANY model
- unsure rate: 4.8% (3) — answered "none" or unusable; counted as wrong
- flagged for review: 7.9% (5) — below threshold or unsure
- unanswered rows: 0

## Seen vs unseen

A test row is **seen** when its `(text.casefold(), kind)` also occurs in the history pool — the row few-shot examples exist for (and the row a merchant map would answer in production). **unseen** is the generalisation half. Never averaged into one claim.

| subset | rows | correct | accuracy | unsure | flagged |
| --- | --- | --- | --- | --- | --- |
| unseen | 14 | 8 | 57.1% | 0 | 0 |
| seen | 49 | 23 | 46.9% | 3 | 5 |

## Cost and latency

- calls: 2
- tokens in/out: 2987 / 883
- cost: $0
- latency p50/p95: 14762 ms / 26221 ms

## By kind

| kind | rows | correct | accuracy |
| --- | --- | --- | --- |
| expense | 63 | 31 | 49.2% |

## By label

| label | kind | support | correct | accuracy |
| --- | --- | --- | --- | --- |
| Продукты | expense | 13 | 13 | 100.0% |
| Кафе и рестораны | expense | 12 | 4 | 33.3% |
| Транспорт | expense | 8 | 2 | 25.0% |
| Напитки | expense | 7 | 4 | 57.1% |
| Сигареты | expense | 6 | 4 | 66.7% |
| Вкусняшки | expense | 3 | 0 | 0.0% |
| Прочее | expense | 2 | 0 | 0.0% |
| Развлечения | expense | 2 | 1 | 50.0% |
| Расходники | expense | 2 | 0 | 0.0% |
| Алкоголь | expense | 1 | 0 | 0.0% |
| Дом и быт | expense | 1 | 0 | 0.0% |
| Жильё | expense | 1 | 0 | 0.0% |
| Налоги и комиссии | expense | 1 | 1 | 100.0% |
| Образование | expense | 1 | 0 | 0.0% |
| Подарки | expense | 1 | 0 | 0.0% |
| Путешествия | expense | 1 | 1 | 100.0% |
| Связь и интернет | expense | 1 | 1 | 100.0% |
