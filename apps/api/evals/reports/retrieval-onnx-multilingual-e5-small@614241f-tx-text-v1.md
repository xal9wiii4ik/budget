# Retrieval evals — onnx/intfloat/multilingual-e5-small@614241f/model.onnx (tx-text-v1)

> **real: true** — produced by the pinned artifact `intfloat/multilingual-e5-small`
> at revision `614241f622f53c4eeff9890bdc4f31cfecc418b3`,
> `model.onnx` sha256 `dd476dd0c2514e9b9be83aeb3853fac0763e0bdf4a71645407587d77c48a2d88`,
> verified by `embeddings/manifest.py` before the session was built.
> The dataset is synthetic (`evals/gen_retrieval.py`); the MODEL and
> the numbers below are not.

- run at: 2026-10-19T08:54:04+00:00
- corpus: 42 documents through `services/tx_text.py` (`tx-text-v1`)
- queries: 27 in three languages, 216 gold pairs
- embedding: 326 ms for the corpus, 83 ms for the queries

## Recall and MRR

Capped recall: `|gold ∩ top-k| / min(|gold|, k)`, macro over queries. MRR is over the first gold hit.

| metric | value |
| --- | --- |
| recall@5 | 77.0% |
| recall@10 | 85.4% |
| recall@20 | 92.9% |
| MRR | 0.9300 |

## Per language (recall@10)

| language | queries | recall@10 |
| --- | --- | --- |
| en | 9 | 96.3% |
| pl | 9 | 65.6% |
| ru | 9 | 94.4% |

## Per theme (recall@10)

| theme | queries | recall@10 |
| --- | --- | --- |
| car | 3 | 50.0% |
| coffee | 3 | 100.0% |
| country:BY | 3 | 70.0% |
| country:DE | 3 | 80.0% |
| country:PL | 3 | 100.0% |
| gifts | 3 | 86.7% |
| groceries | 3 | 88.9% |
| pharmacy | 3 | 100.0% |
| transport | 3 | 93.3% |

## Score distribution (cosine, gold vs non-gold pairs)

Every `(query, document)` pair, split by gold. Overlapping bands are why there is no default `min_score` (D-R3).

| pairs | p05 | p25 | p50 | p75 | p95 |
| --- | --- | --- | --- | --- | --- |
| gold | 0.8039 | 0.8253 | 0.8401 | 0.8517 | 0.8678 |
| non-gold | 0.7761 | 0.7941 | 0.8057 | 0.8191 | 0.8387 |
