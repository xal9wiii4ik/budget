# Evidence for the rag scope (measured by senior-lead, 2026-10-19, dev Mac arm64)

All numbers below are REAL measurements from a throwaway venv in the scratchpad;
nothing was added to the repo. Production is x86_64 (2 vCPU, 3.8 GB RAM shared
with Postgres/MinIO/nginx/Caddy, ~53 GB disk free); latency on x86 will differ,
RSS and sizes will not. Re-measure RSS inside the amd64 image at implementation.

## Candidate models (Hugging Face, pinned revisions, files + sha256)

| repo @ revision | licence | artifact | size |
|---|---|---|---|
| `intfloat/multilingual-e5-small` @ `614241f622f53c4eeff9890bdc4f31cfecc418b3` | MIT (model card) | `onnx/model.onnx` (fp32) sha256 `ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665` | 470.3 MB |
| same | | `onnx/model_qint8_avx512_vnni.onnx` (dynamic int8, MatMulInteger u8s8 — runs on any CPU, name is the quantizer's tuning hint) sha256 `dd476dd0c2514e9b9be83aeb3853fac0763e0bdf4a71645407587d77c48a2d88` | 118.3 MB |
| same | | `onnx/tokenizer.json` sha256 `0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39` | 17.1 MB |
| same | | `onnx/tokenizer_config.json` sha256 `a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b`, `onnx/config.json` sha256 `bbb7c1333fc4b3e27fbc9cd5d2070aabcc1d4dfb99917c3633e772f97545a6b6` | tiny |
| `Xenova/multilingual-e5-small` @ `761b726dd34fb83930e26aab4e9ac3899aa1fa78` | no licence field on the card (a re-export of the MIT model) | `onnx/model_quantized.onnx` sha256 `f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193` | 118.3 MB |
| `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` @ `e8f8c211226b894fcb81acc59f3b34ba3efd5f42` | Apache-2.0 | `onnx/model_quint8_avx2.onnx` sha256 `98a01d88b7de996cdea58c32ca71208c09968d143798814b2ea09d3439dc334f` | 118.5 MB |

Model inputs: `input_ids`, `attention_mask`, `token_type_ids` (zeros) for e5; mean
pooling over the mask + L2 normalisation; e5 expects the `query: ` / `passage: `
prefixes. Dim 384. The XLM-R vocabulary is 250 037 tokens: the embedding table
(250037×384) is 96 M of the 118 M parameters — that table, not the transformer,
is what sets the RAM floor of EVERY XLM-R-based small model (MiniLM-L12 too).

## Runtime footprint

| install (site-packages) | size | packages |
|---|---|---|
| `onnxruntime` 1.31 + `tokenizers` 0.23 + `numpy` 2.5 (+ huggingface_hub only for the probe) | 126 MB (onnxruntime 75, numpy 22, tokenizers 9.5) | 4 |
| `fastembed` 0.9 (pulls onnxruntime, tokenizers, numpy, pillow, loguru, requests, tqdm, py-rust-stemmers, mmh3, …) | 142 MB | 30 |

No torch anywhere. Current API image `budget-api:latest` = 311 MB; the int8 model
adds ~118 MB + 17 MB tokenizer + ~105 MB wheels ≈ +240 MB; fp32 would be +590 MB.

## Load / RSS / latency (arm64 Mac, `intra_op_num_threads=2`)

| model | load | RSS after load | RSS after a 128-batch | 1 item | batch-32 per item | batch-128 per item |
|---|---|---|---|---|---|---|
| e5-small fp32 | 0.66–0.94 s | 725 MB | 781 MB | 7.1 ms | 5.8 ms | 6.6 ms |
| e5-small int8 (intfloat) | 0.09–0.34 s | 559 MB | 632 MB | 3.7 ms | 2.45 ms | 2.7 ms |
| e5-small int8 (Xenova) | 0.10–0.32 s | 561 MB | 599–648 MB | 3.4 ms | 2.4–2.5 ms | 2.7 ms |
| MiniLM-L12 int8 | 0.37 s | ~same as e5 int8 | — | 3.5 ms | — | 2.7 ms |

Baseline process (numpy + onnxruntime imported, no session) = 47 MB. Graph
optimisation level (all/basic/none) and `session.disable_prepacking` change RSS by
< 20 MB: the ~510 MB over baseline is the 250k-row embedding table materialised
as fp32 at load (constant-folded DequantizeLinear) plus ORT's arena. Vocabulary
pruning would cut ~350 MB but needs a self-made artifact — NOT for v1 (record as
a follow-up trigger if prod RAM gets tight).

Quantisation fidelity: cosine(fp32, int8) per document min 0.9951, mean 0.9965 on
16 mixed RU/PL/EN merchant strings; top-3 rankings identical in 5/5 probe queries.

## Multilingual quality sanity (16 docs, 5 queries, e5 int8)

`всё про машину` → Автосервис замена масла, Shell Mińsk, Uber; `подарки` → Allegro
prezent, Подарок маме; `кофе и рестораны` → Starbucks, Bazyliszek restauracja;
`car fuel` → Shell/Автосервис; `apteka` → Apteka Gemini, Аптека 36.6. MiniLM-L12
int8 got `apteka` wrong (Starbucks second) and `подарки` weaker; e5 wins on this
probe at identical cost. Note the e5 score range: everything sits in 0.78–0.87, so
any cut-off must be RELATIVE (to the top score / to a per-query distribution),
never an absolute "0.5".

## Country in the embedded text (same model; 4 docs: Biedronka PL, Евроопт BY, Lidl Berlin DE, Kaufland PL)

| text variant | `сколько ушло на Польшу` | `траты в Польше` | `spending in Poland` | `zakupy w Polsce` | `покупки в Германии` |
|---|---|---|---|---|---|
| no country | Евроопт first (wrong) | Евроопт first (wrong) | Евроопт first (wrong) | Евроопт first (wrong) | Kaufland first (wrong) |
| ISO code only (`PL`) | PL,PL,BY,DE ✓ | PL,BY,PL,DE ✗ | PL,PL,DE,BY ✓ | PL,PL,BY,DE ✓ | DE first ✓ (margin 0.006) |
| `Poland (PL)` | PL,PL,BY,DE ✓ (margin +0.02) | PL,PL,BY,DE ✓ | PL,PL,BY,DE ✓ (+0.03) | PL,PL,BY,DE ✓ | DE first ✓ (margin 0.016) |

Conclusion: the English country NAME next to the code is worth having in the
passage text; the code alone is borderline. The backend has no country-name table
today (only `COUNTRY_PATTERN`); the web renders names via `Intl.DisplayNames`.

## In-process similarity (numpy, float32, 384-d, 20 runs)

| rows | cosine + top-20 | bytes |
|---|---|---|
| 1 000 | 0.08 ms | 1.5 MB |
| 5 000 | 0.09 ms | 7.7 MB |
| 20 000 | 0.56 ms | 30.7 MB |

Local dev DB today: 357 transactions / 60 users (QA users mostly); the owner's prod
ledger is low thousands. The anonymised owner export has 215 operations.

## pgvector cost if chosen

Image swap `postgres:17-alpine` → `pgvector/pgvector:pg17` (Debian-based, ~430 MB vs
291 MB) in THREE places: dev `docker-compose.yml` (owner applies), `docker-compose.prod.yml`
(a container recreate with the same `pg_data` volume — same major 17, no dump/restore;
backup first), `.github/workflows/ci-api.yml` service image; plus `CREATE EXTENSION
vector` in the migration (needs superuser = the `budget` role in compose, fine).
Benefit at ≤ 20 000 rows per user: none measurable (0.6 ms in-process).
