# Extraction evals — ollama/llama3.1:8b (extract-alfa-v1)

- mode: `record`
- run at: 2026-10-20T13:59:55+00:00
- dataset: `statements.jsonl` (12 statements, 215 gold rows), synthetic by construction

## Rows

- statements extracted: 10/12 — failures: invalid_output=2
- exact row count: 83.3% (10/12 statements)
- rows returned: 178 (gold: 215)
- rows right in EVERY field: 50.2% (108/215)

## Per-field accuracy

| field | rows | correct | accuracy |
| --- | --- | --- | --- |
| date | 215 | 178 | 82.8% |
| amount | 215 | 178 | 82.8% |
| currency | 215 | 178 | 82.8% |
| original_pair | 215 | 178 | 82.8% |
| merchant | 215 | 108 | 50.2% |

Denominator is the GOLD rows, so a line the model did not answer counts as wrong in every field. `currency` is 1.0 for any statement that extracted at all: the server REFUSES a row whose currency is not the header's, so a disagreement shows up as a failed extraction instead.

## Self-check (the arithmetic guard, not the model)

- as the generator built it: 83.3% (10/12)
- passed: 8 · failed: 2

## Cost and latency

- calls: 12
- tokens in/out: 17758/16391
- cost: $0
- latency p50/p95: 53029 ms / 59641 ms
