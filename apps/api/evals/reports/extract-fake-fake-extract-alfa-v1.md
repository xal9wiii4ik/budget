# Extraction evals — fake/fake (extract-alfa-v1)

> **SYNTHETIC RUN — not a model quality number.** The `fake` provider
> in `llm/fake.py` answers a KNOWN layout with a regex (extraction) or
> a fixed script (the reconcile loop); it is not an oracle and it was
> not tuned to look good. This report exists to show the pipeline and
> to pin its mechanics in CI. No real-model numbers exist until someone
> runs `--mode live` with a key.

- mode: `replay`
- run at: 2026-10-14T19:32:43+00:00
- dataset: `statements.jsonl` (12 statements, 215 gold rows), synthetic by construction

## Rows

- statements extracted: 12/12
- exact row count: 100.0% (12/12 statements)
- rows returned: 215 (gold: 215)
- rows right in EVERY field: 83.3% (179/215)

## Per-field accuracy

| field | rows | correct | accuracy |
| --- | --- | --- | --- |
| date | 215 | 215 | 100.0% |
| amount | 215 | 215 | 100.0% |
| currency | 215 | 215 | 100.0% |
| original_pair | 215 | 215 | 100.0% |
| merchant | 215 | 179 | 83.3% |

Denominator is the GOLD rows, so a line the model did not answer counts as wrong in every field. `currency` is 1.0 for any statement that extracted at all: the server REFUSES a row whose currency is not the header's, so a disagreement shows up as a failed extraction instead.

## Self-check (the arithmetic guard, not the model)

- as the generator built it: 100.0% (12/12)
- passed: 9 · failed: 3

## Cost and latency

- calls: 12
- tokens in/out: 0/0
- cost: $0
- latency p50/p95: 0 ms / 0 ms
