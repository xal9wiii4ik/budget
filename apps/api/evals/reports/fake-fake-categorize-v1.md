# Evals — fake/fake (categorize-v1)

> **SYNTHETIC RUN — not a model quality number.** The `fake`
> provider is a substring matcher in `llm/fake.py`; this report
> exists to show the pipeline and to pin its mechanics in CI.
> The real-model numbers are in the `ollama-*` reports beside
> this one; nothing here may be quoted as a quality number.

- mode: `replay`
- run at: 2026-10-20T14:34:05+00:00
- dataset: `owner-categorize-v1.jsonl` (215 rows scored), owner-reviewed 2026-10-14
- split: `none` — the whole dataset, no example pool
- prompt sent: `categorize-v1`
- examples per call: 0.0
- confidence threshold: 0.7

## Accuracy

- **accuracy: 9.8%** (21/215)
- ambiguity ceiling: 86.5% — rows sharing a (text, kind) under different labels make the rest unreachable for ANY model
- unsure rate: 89.8% (193) — answered "none" or unusable; counted as wrong
- flagged for review: 89.8% (193) — below threshold or unsure
- unanswered rows: 0

## Seen vs unseen

A test row is **seen** when its `(text.casefold(), kind)` also occurs in the history pool — the row few-shot examples exist for (and the row a merchant map would answer in production). **unseen** is the generalisation half. Never averaged into one claim.

| subset | rows | correct | accuracy | unsure | flagged |
| --- | --- | --- | --- | --- | --- |
| unseen | 215 | 21 | 9.8% | 193 | 193 |
| seen | 0 | 0 | 0.0% | 0 | 0 |

## Cost and latency

- calls: 5
- tokens in/out: 0 / 0
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
