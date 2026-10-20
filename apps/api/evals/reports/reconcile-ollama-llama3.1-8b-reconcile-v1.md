# Reconciliation evals — ollama/llama3.1:8b (reconcile-v1)

- mode: `record`
- run at: 2026-10-20T13:31:29+00:00
- dataset: `synthetic-reconcile-v1.jsonl` (6 cases, 30 seeded differences), synthetic by construction

## Pre-match (no model involved)

- settled by the server: 100.0% (48 of 48 pairs that must settle)

## The loop

- cases with a report: 6/6
- items reported: 0 (gold: 30)
- open items left unmentioned: 24 rows, 24 transactions — silence is an allowed answer, the app shows the count

## Per kind

| kind | gold | reported | right | precision | recall |
| --- | --- | --- | --- | --- | --- |
| missing_in_app | 6 | 0 | 0 | 0.0% | 0.0% |
| extra_in_app | 6 | 0 | 0 | 0.0% | 0.0% |
| amount_differs | 6 | 0 | 0 | 0.0% | 0.0% |
| date_differs | 6 | 0 | 0 | 0.0% | 0.0% |
| fx_difference | 6 | 0 | 0 | 0.0% | 0.0% |

A triple counts as right only when the kind AND both ids match the seeded difference: reporting the right pair under the wrong kind is a miss on one kind and a false positive on another, which is what the user would see.

## Cost and latency

- steps: 18 (3.0 per case)
- calls: 18
- tokens in/out: 23710/699
- cost: $0
- latency p50/p95: 2600 ms / 12836 ms
