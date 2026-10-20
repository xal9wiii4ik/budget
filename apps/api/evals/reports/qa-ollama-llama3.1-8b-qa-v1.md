# Q&A evals — ollama/llama3.1:8b (qa-v1)

- mode: `record`
- run at: 2026-10-20T13:36:05+00:00
- dataset: `queries.jsonl` (27 questions, top 20 operations each)
- retrieval: in-memory, fake embedder, base currency BYN

## Groundedness

- **groundedness: 98.2%** (5 of 277 citations dropped by the verifier — unknown or duplicate keys)
- answered: 27/27
- answers citing nothing: 0 — an allowed answer ("the operations do not answer this")

## Citation recall

- **citation recall: 71.5%** (98/137 of the gold operations the retrieval actually returned)
- citations kept: 272

## Cost and latency

- calls: 27
- cost: $0
- latency p50/p95: 9815 ms / 12487 ms
