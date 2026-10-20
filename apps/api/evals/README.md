# evals — measuring the app's model passes

Offline evaluation of the five passes a model touches, each with its own
runner, its own dataset and its own report — **accuracy, cost, latency** per
provider × model × prompt version, plus a CI regression that costs nothing:

| runner | measures | dataset |
| --- | --- | --- |
| `run.py` | `services/categorize.py` | `dataset/owner-categorize-v1.jsonl` (anonymized real export) |
| `extract.py` | `services/statement_import/alfa_pdf.py` | `dataset/synthetic-alfa-v1/statements.jsonl` (generated) |
| `reconcile.py` | `services/reconcile.py` | `dataset/synthetic-reconcile-v1.jsonl` (generated) |
| `retrieval.py` | `services/tx_text.py` + `embeddings/` (recall@k, MRR) | `dataset/retrieval-v1/{corpus,queries}.jsonl` (generated) |
| `qa.py` | `services/advisor_qa.py` (groundedness, citations) | the same corpus + queries |

Nothing in here is imported by the app. Each runner imports the app's `llm/` or
`embeddings/` package and calls the same function the router calls, with the
production config read from `Settings`' FIELD DEFAULTS — a number in `reports/`
is a number about the shipped code, not about a copy of it. The shared machinery
(provider building, the replay store, percentiles, the report writer) is
`common.py`; `retrieval.py` owns the corpus loader and the embedding step that
`qa.py` reuses, so "the document that got embedded" has one definition.

## Real vs fake: the labelling rule

Every report says in its own first lines which it is, and the rule is the same
for both seams (`docs/conventions.md`):

* a report produced by `llm/fake.py` or by `embeddings/fake.py` opens with a
  **SYNTHETIC RUN** banner and carries `"synthetic": true` in its JSON. Nothing
  in it may be quoted anywhere (CV, portfolio, docs) as a quality number;
* a report produced by a real provider or the real embedding artifact carries
  `"real": true` and, for the embedder, the manifest **revision** and the
  artifact's **sha256** — the pin that says which weights produced it.

Since 2026-10-20 every LLM pass has **real-model numbers** from local models
through Ollama (`reports/ollama-*`), and the retrieval pass has its real artifact
report (`reports/retrieval-onnx-multilingual-e5-small@614241f-tx-text-v1.md`).
The `fake` reports beside them are kept as the pipeline's fixtures and nothing
else: `llm/fake.py` is a **substring matcher** (categorize), **one regex over the
known line layout** (extraction), a **fixed three-step script** (reconcile) and a
**word-overlap citer** (Q&A), none of them a model, and CI runs the fake embedder
only — a 118 MB Hugging Face download is not worth an outage mode on every API
push.

Most floors in `tests/test_evals_regression.py` are still **fake-calibrated**:
they sit a hair below what the fake scores and each one says so in its docstring.
The categorize floor is the exception since `categorize-v2` — it is
`EVALS_MIN_ACCURACY_V2`, calibrated on the **recorded qwen2.5:7b v2 run** and
asserted by replaying that real fixture; the fake replay test keeps only its
equality assertion (replay reproduces an in-process run exactly), which is the
part that pins the pipeline's mechanics.

## Synthetic datasets carry no real numbers at all

`dataset/synthetic-alfa-v1/` and `dataset/synthetic-reconcile-v1.jsonl` are
**generated** and committed. Only the LABELS, the column order, the number
spelling and the description shapes are the real Alfa format's
(`.tasks/pdf-reconcile/sample-structure.md`); every merchant, person, amount,
date and id is invented. The generators never open the owner's own statement
(`.tasks/pdf-reconcile/real-alfa-local.pdf`, gitignored) — committing the
datasets is what makes a report reproducible by someone who does not have that
file.

`dataset/retrieval-v1/` is the same deal: themed RU/PL/EN merchants with notes,
categories, countries and accounts, asked about by tri-lingual queries that carry
the gold key sets (`gen_retrieval.py`'s docstring has the design, including why
`--derive-owner` is a local experiment and not how the committed files were cut).

```bash
# re-cut a dataset (seeds are the defaults; changing one invalidates its
# replay fixture, so re-record that fixture in the same pass)
uv run python evals/gen_alfa.py --seed 20261014 --statements 12 --mismatch-share 0.25
uv run python evals/gen_reconcile.py --seed 20261014 --cases 6
uv run python evals/gen_retrieval.py --seed 20261019        # then re-record qa + re-run retrieval
```

## Run it

All commands from `apps/api`. Every LLM runner takes the same `--provider`,
`--model`, `--mode`, `--limit`, `--dataset`, `--replay-dir`, `--reports-dir` and
`--prompt-version` (which must equal the build's `PROMPT_VERSION` — a mismatch
refuses the run rather than mislabelling a report); `run.py` adds `--threshold`.
`retrieval.py` calls no provider at all, so its knobs are `--embedder fake|onnx`,
`--model-dir`, `--manifest`, `--corpus`, `--queries` and `--reports-dir`.

`run.py` additionally takes `--split none|test` (the leakage-free split, below),
and its `--prompt-version` is a MEMBERSHIP check against `PROMPT_VERSIONS`
(`categorize-v1` | `categorize-v2`) rather than an equality one, because
measuring the two prompts against each other on one slice is the point.

```bash
# the committed fixtures, no key, no network — this is what CI runs
uv run python evals/run.py       --provider fake --mode replay --prompt-version categorize-v1
uv run python evals/extract.py   --provider fake --mode replay
uv run python evals/reconcile.py --provider fake --mode replay
uv run python evals/qa.py        --provider fake --mode replay
uv run python evals/retrieval.py --embedder fake

# the REAL embedding artifact, locally (fetch it once: docs/infra.md)
uv run python evals/retrieval.py --embedder onnx
uv run python evals/retrieval.py --embedder onnx \
  --model-dir models/multilingual-e5-small --manifest model_manifest.json

# the fake for real (in-process), e.g. after changing a pass
uv run python evals/run.py --provider fake --mode live

# a real run that also records every answer for later replay
ANTHROPIC_API_KEY=… uv run python evals/run.py --provider anthropic --mode record
ANTHROPIC_API_KEY=… uv run python evals/run.py --provider anthropic --mode live

# a local Ollama (model from the app's OLLAMA_MODEL default)
uv run python evals/run.py --provider ollama --mode live

# the four committed v1-vs-v2 runs (one call at a time: LOCAL_PROVIDERS)
uv run python evals/run.py --provider ollama --model qwen2.5:7b \
  --prompt-version categorize-v1 --split test --mode record
uv run python evals/run.py --provider ollama --model qwen2.5:7b \
  --prompt-version categorize-v2 --split test --mode record    # needs the onnx artifact
```

Outputs: `reports/<provider>-<model>-<prompt-version>[-test].{md,json}` for
categorize,
`reports/extract-…`, `reports/reconcile-…` and `reports/qa-…` for the other LLM
runners, `reports/retrieval-<embedder>-<model-slug>-<text-version>.{md,json}` for
retrieval, and the markdown on stdout.

### What `run.py` measures, and the leakage-free split (`categorize-v2`)

`categorize-v2` puts the user's OWN past decisions in the prompt, so measuring it
needs a history the test rows are not part of. `--split test` cuts the dataset
once, deterministically, with no seed and no shuffle:

- **stratified per label, positional**: within each label, in dataset order,
  every 3rd row (`index % 3 == 2`) goes to the **test slice** (63 rows) and the
  rest to the **history pool** (152 rows). Every label with ≥3 rows is on both
  sides, and the split is a pure function of the committed file — pinned by
  `tests/test_evals_regression.py::TestDatasetSplit`;
- **a test row is never its own example**, by construction rather than by a
  filter: the pool holds history rows only;
- the history is embedded with the **real onnx artifact** — the production pool
  IS the stored RAG index, so the eval builds `tx_text` passages from
  (merchant = the row's text, category = its label, kind) and embeds them
  exactly as `services/tx_index.py` does. A missing artifact **refuses** a
  `live`/`record` run; it never falls back to the fake embedder, which would make
  the report a number about a hash;
- the report splits the test slice into **seen** (its `(text.casefold(), kind)`
  also occurs in the history) and **unseen**. They are never averaged: in
  production most seen rows never reach the model at all (the merchant map
  answers them first),
  so `unseen` is the generalisation number and `seen` is "does it copy the user's
  own past decision".

The selected examples are part of the request, and therefore part of the replay
key. A `record` run writes them beside its fixture as
`replay/<stem>.examples.json`, and `replay` loads that file into a static
selector — which is how CI reproduces a real few-shot run with **no embedding
artifact at all**. The sidecar's header is checked on load and a mismatch is
refused by name instead of silently reporting a number about a selection nobody
made: `SELECTION_VERSION` plus the three limits pin the CODE that cut it, and
`prompt_version`/`split`/`history_rows` pin the RUN — its batches are keyed by
dataset row ids, so one recorded over another slice would answer every batch and
replay stale examples under a mislabelled seen/unseen.

#### v1 vs v2, same slice, same models (recorded 2026-10-20)

63 test rows, 152 history rows, 22 labels, ambiguity ceiling **87.3%** on this
slice. Local Ollama on an M2 Pro (16 GB), one call at a time, 2 calls per run
(the 63 rows dedupe to 36 unique operations). Real numbers, `--mode record`:

| model | prompt | overall | unseen (14) | seen (49) | unsure | flagged | latency p50 / p95 | tokens in/out | examples/call |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwen2.5:7b | `categorize-v1` | 49.2% | 57.1% | 46.9% | 3 | 5 | 14.8 s / 26.2 s | 2987 / 883 | 0 |
| qwen2.5:7b | `categorize-v2` | **63.5%** | **64.3%** | **63.3%** | 0 | 0 | 17.2 s / 24.1 s | 4308 / 902 | 39.0 |
| llama3.1:8b | `categorize-v1` | 41.3% | 35.7% | 42.9% | 4 | 29 | 20.0 s / 33.4 s | 2870 / 1187 | 0 |
| llama3.1:8b | `categorize-v2` | **77.8%** | **64.3%** | **81.6%** | 0 | 9 | 23.3 s / 31.3 s | 4118 / 1222 | 39.0 |

v2 wins on the unseen subset on BOTH models (+7.2 pp qwen, +28.6 pp llama) and
on every other number, at ~1.3k extra input tokens and ~2.5 s per call — hence
`CATEGORIZE_PROMPT_VERSION=categorize-v2` as the shipped default (grooming D9).
Two secondary readings worth keeping: the unsure rate drops to **zero** on both
models (the examples give the model something to be sure about, which is also
why its flagged count collapses), and llama's much larger gain comes from where
it was losing — it answered "unsure" and low-confidence far more often than qwen
under v1. The unseen subset is only 14 rows, so read it as a direction, not as a
decimal; the full-dataset v1 numbers (215 rows, no split) are in
`reports/ollama-*-categorize-v1.{md,json}`.

### What `extract.py` measures

Text → `alfa_pdf.extract_from_text` (the evals never open a PDF — exactly one
pytest does), scored against the generator's gold rows:

- **per-field accuracy** over the gold rows — date, the signed amount, currency,
  the FX original pair, and **merchant separately**, because it is the one field
  with no second source (the amounts are checked against the header anchors);
- **exact row count** per statement, and rows right in EVERY field;
- **self-check agreement**: three of the twelve statements hide one operation
  line while keeping it in the printed totals, so the extractor must come out
  `failed` on `balance` for those and `passed` for the rest;
- calls, tokens, cost, latency.

The fake scores 100% on the four structural fields (its regex reads the layout
this generator prints), **83.3% on merchant** (it only knows the card-purchase
phrase, so it misses the ERIP line and the two transfer lines of every
statement) and 100% self-check agreement. Those are facts about a regex.

### What `reconcile.py` measures

`prematch` + `reconcile` over the generated cases:

- **settled**: the pairs the server proves identical with no model at all. The
  generator says how many there must be, and the number involves no provider —
  a shortfall is a matcher regression, not a model problem;
- **precision and recall per kind** over `(kind, row_id, transaction_id)`
  triples, never averaged: the two one-sided kinds are cheap and the three
  difference kinds are the whole reason a model is here;
- **silence**: the open items the model said nothing about (an allowed answer —
  the app shows the count);
- steps, calls, tokens, cost, latency.

The fake reports every open row as `missing_in_app` and every open transaction as
`extra_in_app`, so recall on those two is **100%** with **25% precision**, and
the three difference kinds score **0** — by construction, not by accident. It
settles 48/48.

### What `retrieval.py` measures

The corpus through `services/tx_text.py` → an `Embedder` → one matrix product
(the vectors are L2-normalised, so a dot product IS the cosine, exactly as in
`services/tx_search.py`). No database, no app, no SQL filter:

- **capped recall@5/10/20** — `|gold ∩ top-k| / min(|gold|, k)`, macro over
  queries. Capped because the country queries have more gold rows than `k`, and
  an uncapped denominator would print a built-in ceiling as a model failure;
- **MRR** over the first gold hit, **recall@10 per language** (the cross-lingual
  claim: one document, three languages of question) and per theme;
- **the cosine percentiles of gold vs non-gold pairs** — the evidence behind
  "no default `min_score`" (architecture D-R3).

The real artifact scores **recall@10 85.4%, MRR 0.930** on this dataset (ru
94.4% / en 96.3% / pl 65.6%), with the two score bands overlapping (gold p05
0.804 vs non-gold p95 0.839) — which is why an absolute cut-off would drop true
hits. The fake embedder scores 47.4% there, and that number is about a hash.

### What `qa.py` measures

In-memory retrieval with the fake embedder → `advisor_qa.answer_question`
through the replay store, so the measured half is the MODEL and the server's
citation verifier:

- **groundedness** = `1 − dropped / citations_before_drop`: the share of the
  model's own references that survived. The kept list is a subset of what was
  retrieved by construction, so what is worth counting is how often that
  construction had to intervene;
- **citation recall** against `gold ∩ retrieved` — gold the retrieval never
  found cannot be cited and is not held against the model;
- answers citing nothing (an allowed answer), calls, cost, latency.

The fake's groundedness is **100% by construction** (it only cites keys it was
handed) and its citation recall is **22.6%** — a word-overlap matcher's score
over a hashed-bag-of-words retrieval.

### The three modes

| mode | provider calls | money | used for |
| --- | --- | --- | --- |
| `live` | yes | yes, for a hosted model | the real measurement |
| `record` | yes | yes, once | cutting a replay fixture |
| `replay` | no | no | CI, and reproducing a past run |

`replay/<provider>-<model>-<prompt-version>.jsonl` is keyed by a hash of the
whole request: system prompt, data document, output schema, `max_tokens`, plus
`tools`/`tool_choice` when the call carries tools (the reconcile loop). So
editing the prompt, the schema, the batching, a tool spec or a dataset
invalidates the fixture, and a replay run then **raises** (`EvalError`, naming
how many rows / statements / cases went unanswered) instead of reporting a silent
0%. That is the intended loud failure: bump `PROMPT_VERSION` and re-record.

The loop fixture holds three entries per case, because the tool RESULTS are part
of each step's key — a change to the payloads the two list tools hand over, or to
the opaque `r1`/`t1` keys, invalidates it too.

A `record` run truncates its fixture and writes a provenance header line (the
store skips a line with no `"key"`, so it is free) — but only once every refusal
has passed: the arguments, the provider, the embedding artifact and a non-empty
history pool are all checked first, so a refused run leaves a committed fixture
untouched. The committed `fake` one says `"synthetic": true`.

## The dataset (owner-reviewed 2026-10-14)

`dataset/owner-categorize-v1.jsonl` (215 rows, 22 labels) is generated from the
owner's real export, which is **gitignored and never committed**:

```bash
uv run python evals/anonymize.py ../../.tasks/ai-layer/real-eval-local.csv
```

That writes the dataset, `dataset/categories.json` (the label set with stable
`uuid5` ids), `dataset/_meta.json` (counts + the `owner_reviewed` date) and
a **review table** at `.tasks/ai-layer/real-anonymize-review-local.md` — a
gitignored path, because the table shows the raw merchant and note beside the
anonymized result.

**The review step is the owner's.** It happened on 2026-10-14 and added two
rulings now encoded in `anonymize.py`: rows carrying pay or income tax are
dropped (`private_income`), and a label naming the owner's own paperwork is
generalised (`LABEL_RENAMES`). Re-run the review whenever the export changes:
the table shows whether the `→ text` column carries a person name, a number or a
private detail. The
rules (`anonymize.py`'s docstring has them all) are biased towards dropping:

- `text` = the merchant, else the note's FIRST clause;
- runs of 4+ digits (cards, accounts, phones, terminal ids) cut out;
- the owner's bookkeeping phrases removed ("Дата — допущение", "платёж 1 из 3",
  "РАЗОВАЯ", "Чек NN.NN", …) — a row that was only bookkeeping drops as empty;
- a relation word, a transfer, or a person-name shape in the field the text came
  from drops the whole row (never a word-strip: a half-scrubbed row is what
  leaks);
- an empty label drops the row.

Company and merchant names stay verbatim, city suffix included: they are the
production signal, and they are not person data. Every drop is counted by reason
in `_meta.json` and in the review table's summary.

### Why accuracy cannot reach 100%

`text` is merchant-only, which is the production shape — but the owner's
distinguishing detail lived in the note the anonymizer drops. Rows sharing a
`(text, kind)` under different labels (one grocery chain appears under six) are
the same question with different right answers, so the report prints an
**ambiguity ceiling** next to accuracy: 86.5% on the full dataset, 87.3% on the
`--split test` slice. Read accuracy against the ceiling, not against 100%. A v2 dataset that appends the note's first
clause to the merchant is the owner's call, and the review table shows the groups
to decide it from.

## CI

`tests/test_evals_regression.py` runs the replays above in-process (no
subprocess, no network, no database) and asserts:

1. the fake v1 replay accuracy equals an in-process fake run exactly (no floor —
   what a substring matcher scores is not a bar), and the recorded **qwen2.5:7b
   `categorize-v2` test-split** fixture replays above `EVALS_MIN_ACCURACY_V2`
   (~1 pp below its recorded 63.5%) with its examples sidecar — the one real
   quality floor, and it needs no artifact;
2. a replay store that cannot answer raises instead of scoring 0%;
3. `categories.json` and the dataset agree on every label and kind, and the
   `--split test` cut is disjoint, deterministic and stratified;
4. the extraction replay reproduces an in-process fake run field for field and
   clears `EXTRACT_MIN_ACCURACY` / `EXTRACT_MIN_MERCHANT_ACCURACY` /
   `EXTRACT_MIN_SELF_CHECK`;
5. the reconcile replay reproduces an in-process fake run kind for kind and
   clears `RECONCILE_MIN_SETTLED` / `RECONCILE_MIN_RECALL`;
6. every committed synthetic statement's anchors are the sums of its own gold
   rows — and the three defective ones really do NOT close (a defect that
   stopped being seeded would turn measurement 4's self-check number into a
   constant 100%);
7. the committed FAKE retrieval report reproduces an in-process run field for
   field and clears `RETRIEVAL_MIN_RECALL_AT_10` — there is no provider and so
   no replay store here, so that report IS the fixture (and a re-cut dataset
   whose report was not re-run fails this);
8. the QA replay reproduces an in-process fake run and clears
   `QA_MIN_GROUNDEDNESS` / `QA_MIN_CITATION_RECALL`.

`tests/test_evals_anonymize.py` pins the anonymizer's rules on synthetic inputs.
