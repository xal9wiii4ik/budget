# Extraction evals — ollama/qwen2.5:7b (extract-alfa-v1)

- mode: `record`
- run at: 2026-10-20T13:47:16+00:00
- dataset: `statements.jsonl` (12 statements, 215 gold rows), synthetic by construction

## Rows

- statements extracted: 12/12
- exact row count: 100.0% (12/12 statements)
- rows returned: 215 (gold: 215)
- rows right in EVERY field: 79.5% (171/215)

## Per-field accuracy

| field | rows | correct | accuracy |
| --- | --- | --- | --- |
| date | 215 | 215 | 100.0% |
| amount | 215 | 215 | 100.0% |
| currency | 215 | 215 | 100.0% |
| original_pair | 215 | 214 | 99.5% |
| merchant | 215 | 172 | 80.0% |

Denominator is the GOLD rows, so a line the model did not answer counts as wrong in every field. `currency` is 1.0 for any statement that extracted at all: the server REFUSES a row whose currency is not the header's, so a disagreement shows up as a failed extraction instead.

## Self-check (the arithmetic guard, not the model)

- as the generator built it: 100.0% (12/12)
- passed: 9 · failed: 3

## Cost and latency

- calls: 12
- tokens in/out: 20572/12249
- cost: $0
- latency p50/p95: 38139 ms / 45407 ms
