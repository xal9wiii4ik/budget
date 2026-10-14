# Reconciliation evals — fake/fake (reconcile-v1)

> **SYNTHETIC RUN — not a model quality number.** The `fake` provider
> in `llm/fake.py` answers a KNOWN layout with a regex (extraction) or
> a fixed script (the reconcile loop); it is not an oracle and it was
> not tuned to look good. This report exists to show the pipeline and
> to pin its mechanics in CI. No real-model numbers exist until someone
> runs `--mode live` with a key.

- mode: `replay`
- run at: 2026-10-14T18:48:16+00:00
- dataset: `synthetic-reconcile-v1.jsonl` (6 cases, 30 seeded differences), synthetic by construction

## Pre-match (no model involved)

- settled by the server: 100.0% (48 of 48 pairs that must settle)

## The loop

- cases with a report: 6/6
- items reported: 48 (gold: 30)
- open items left unmentioned: 0 rows, 0 transactions — silence is an allowed answer, the app shows the count

## Per kind

| kind | gold | reported | right | precision | recall |
| --- | --- | --- | --- | --- | --- |
| missing_in_app | 6 | 24 | 6 | 25.0% | 100.0% |
| extra_in_app | 6 | 24 | 6 | 25.0% | 100.0% |
| amount_differs | 6 | 0 | 0 | 0.0% | 0.0% |
| date_differs | 6 | 0 | 0 | 0.0% | 0.0% |
| fx_difference | 6 | 0 | 0 | 0.0% | 0.0% |

A triple counts as right only when the kind AND both ids match the seeded difference: reporting the right pair under the wrong kind is a miss on one kind and a false positive on another, which is what the user would see.

## Cost and latency

- steps: 18 (3.0 per case)
- calls: 18
- tokens in/out: 0/0
- cost: $0
- latency p50/p95: 0 ms / 0 ms
