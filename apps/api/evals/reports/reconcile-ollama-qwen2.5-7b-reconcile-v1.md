# Reconciliation evals — ollama/qwen2.5:7b (reconcile-v1)

- mode: `record`
- run at: 2026-10-20T13:19:45+00:00
- dataset: `synthetic-reconcile-v1.jsonl` (6 cases, 30 seeded differences), synthetic by construction

## Pre-match (no model involved)

- settled by the server: 100.0% (48 of 48 pairs that must settle)

## The loop

- cases with a report: 5/6 — aborted: invalid_output=1
- items reported: 19 (gold: 30)
- open items left unmentioned: 5 rows, 3 transactions — silence is an allowed answer, the app shows the count

## Per kind

| kind | gold | reported | right | precision | recall |
| --- | --- | --- | --- | --- | --- |
| missing_in_app | 6 | 2 | 2 | 100.0% | 33.3% |
| extra_in_app | 6 | 4 | 4 | 100.0% | 66.7% |
| amount_differs | 6 | 8 | 2 | 25.0% | 33.3% |
| date_differs | 6 | 5 | 4 | 80.0% | 66.7% |
| fx_difference | 6 | 0 | 0 | 0.0% | 0.0% |

A triple counts as right only when the kind AND both ids match the seeded difference: reporting the right pair under the wrong kind is a miss on one kind and a false positive on another, which is what the user would see.

## Cost and latency

- steps: 12 (2.0 per case)
- calls: 12
- tokens in/out: 17953/1897
- cost: $0
- latency p50/p95: 5136 ms / 15185 ms
