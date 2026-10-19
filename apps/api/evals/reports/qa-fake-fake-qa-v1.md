# Q&A evals — fake/fake (qa-v1)

> **SYNTHETIC RUN — not a model quality number.** Retrieval is
> the hashed-bag-of-words `embeddings/fake.py` and the answers
> come from `llm/fake.py`, which cites every operation sharing a
> literal word with the question and invents nothing. This report
> exists to show the pipeline and to pin its mechanics in CI. No
> real-model numbers exist until someone runs `--mode live`.

- mode: `replay`
- run at: 2026-10-19T08:42:33+00:00
- dataset: `queries.jsonl` (27 questions, top 20 operations each)
- retrieval: in-memory, fake embedder, base currency BYN

## Groundedness

- **groundedness: 100.0%** (0 of 99 citations dropped by the verifier — unknown or duplicate keys)
- answered: 27/27
- answers citing nothing: 8 — an allowed answer ("the operations do not answer this")

## Citation recall

- **citation recall: 22.6%** (31/137 of the gold operations the retrieval actually returned)
- citations kept: 99

## Cost and latency

- calls: 27
- cost: $0
- latency p50/p95: 0 ms / 0 ms
