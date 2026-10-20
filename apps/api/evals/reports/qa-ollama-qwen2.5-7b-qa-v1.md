# Q&A evals — ollama/qwen2.5:7b (qa-v1)

- mode: `record`
- run at: 2026-10-20T13:23:51+00:00
- dataset: `queries.jsonl` (27 questions, top 20 operations each)
- retrieval: in-memory, fake embedder, base currency BYN

## Groundedness

- **groundedness: 100.0%** (0 of 94 citations dropped by the verifier — unknown or duplicate keys)
- answered: 27/27
- answers citing nothing: 2 — an allowed answer ("the operations do not answer this")

## Citation recall

- **citation recall: 63.5%** (87/137 of the gold operations the retrieval actually returned)
- citations kept: 94

## Cost and latency

- calls: 27
- cost: $0
- latency p50/p95: 8666 ms / 11413 ms
