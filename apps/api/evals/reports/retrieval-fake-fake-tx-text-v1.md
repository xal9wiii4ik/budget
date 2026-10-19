# Retrieval evals — fake/fake (tx-text-v1)

> **SYNTHETIC RUN — not a model quality number.** The `fake`
> embedder in `embeddings/fake.py` is a hashed bag of words: it
> matches a literal shared WORD and knows nothing of meaning,
> morphology or language. This report exists to show the pipeline
> and to pin its mechanics in CI. The real numbers are in the
> `--embedder onnx` report beside this one.

- run at: 2026-10-19T09:11:44+00:00
- corpus: 42 documents through `services/tx_text.py` (`tx-text-v1`)
- queries: 27 in three languages, 216 gold pairs
- embedding: 0 ms for the corpus, 0 ms for the queries

## Recall and MRR

Capped recall: `|gold ∩ top-k| / min(|gold|, k)`, macro over queries. MRR is over the first gold hit.

| metric | value |
| --- | --- |
| recall@5 | 36.3% |
| recall@10 | 47.4% |
| recall@20 | 62.5% |
| MRR | 0.6797 |

## Per language (recall@10)

| language | queries | recall@10 |
| --- | --- | --- |
| en | 9 | 51.9% |
| pl | 9 | 26.3% |
| ru | 9 | 64.1% |

## Per theme (recall@10)

| theme | queries | recall@10 |
| --- | --- | --- |
| car | 3 | 22.2% |
| coffee | 3 | 46.7% |
| country:BY | 3 | 60.0% |
| country:DE | 3 | 53.3% |
| country:PL | 3 | 60.0% |
| gifts | 3 | 46.7% |
| groceries | 3 | 44.4% |
| pharmacy | 3 | 46.7% |
| transport | 3 | 46.7% |

## Score distribution (cosine, gold vs non-gold pairs)

Every `(query, document)` pair, split by gold. Overlapping bands are why there is no default `min_score` (D-R3).

| pairs | p05 | p25 | p50 | p75 | p95 |
| --- | --- | --- | --- | --- | --- |
| gold | 0.0000 | 0.0000 | 0.0000 | 0.1581 | 0.3086 |
| non-gold | 0.0000 | 0.0000 | 0.0000 | 0.0000 | 0.1667 |
