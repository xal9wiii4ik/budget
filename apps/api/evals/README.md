# evals — measuring the app's LLM passes

Offline evaluation of the three passes that call a model, each with its own
runner, its own dataset and its own report — **accuracy, cost, latency** per
provider × model × prompt version, plus a CI regression that costs nothing:

| runner | measures | dataset |
| --- | --- | --- |
| `run.py` | `services/categorize.py` | `dataset/owner-categorize-v1.jsonl` (anonymized real export) |
| `extract.py` | `services/statement_import/alfa_pdf.py` | `dataset/synthetic-alfa-v1/statements.jsonl` (generated) |
| `reconcile.py` | `services/reconcile.py` | `dataset/synthetic-reconcile-v1.jsonl` (generated) |

Nothing in here is imported by the app. Each runner imports the app's `llm/`
package and calls the same function the router calls, with the production config
read from `Settings`' FIELD DEFAULTS — a number in `reports/` is a number about
the shipped code, not about a copy of it. The shared machinery (provider
building, the replay store, percentiles, the report writer) is `common.py`.

## There are no real-model numbers yet

All three committed reports come from `llm/fake.py` — a **substring matcher**
(categorize), **one regex over the known line layout** (extraction) and a **fixed
three-step script** (reconcile), none of them a model. They exist to demonstrate
the pipelines and to pin their mechanics in CI, and each says so in its own
first lines. No accuracy, recall or cost figure may be quoted anywhere (CV,
portfolio, docs) until someone runs `--mode live` or `--mode record` against a
real provider and the report for that provider/model lands here. The floors in
`tests/test_evals_regression.py` are **fake-calibrated**: they sit a hair below
what the fake scores and must be re-set after the first live run (each one says
so in its docstring).

## Synthetic datasets carry no real numbers at all

`dataset/synthetic-alfa-v1/` and `dataset/synthetic-reconcile-v1.jsonl` are
**generated** and committed. Only the LABELS, the column order, the number
spelling and the description shapes are the real Alfa format's
(`.tasks/pdf-reconcile/sample-structure.md`); every merchant, person, amount,
date and id is invented. The generators never open the owner's own statement
(`.tasks/pdf-reconcile/real-alfa-local.pdf`, gitignored) — committing the
datasets is what makes a report reproducible by someone who does not have that
file.

```bash
# re-cut both datasets (seeds are the defaults; changing one invalidates its
# replay fixture, so re-record that fixture in the same pass)
uv run python evals/gen_alfa.py --seed 20261014 --statements 12 --mismatch-share 0.25
uv run python evals/gen_reconcile.py --seed 20261014 --cases 6
```

## Run it

All commands from `apps/api`. Every runner takes the same `--provider`,
`--model`, `--mode`, `--limit`, `--dataset`, `--replay-dir`, `--reports-dir` and
`--prompt-version` (which must equal the build's `PROMPT_VERSION` — a mismatch
refuses the run rather than mislabelling a report); `run.py` adds `--threshold`.

```bash
# the committed fixtures, no key, no network — this is what CI runs
uv run python evals/run.py       --provider fake --mode replay
uv run python evals/extract.py   --provider fake --mode replay
uv run python evals/reconcile.py --provider fake --mode replay

# the fake for real (in-process), e.g. after changing a pass
uv run python evals/run.py --provider fake --mode live

# a real run that also records every answer for later replay
ANTHROPIC_API_KEY=… uv run python evals/run.py --provider anthropic --mode record
ANTHROPIC_API_KEY=… uv run python evals/run.py --provider anthropic --mode live

# a local Ollama (model from the app's OLLAMA_MODEL default)
uv run python evals/run.py --provider ollama --mode live
```

Outputs: `reports/<provider>-<model>-<prompt-version>.{md,json}` for categorize,
`reports/extract-…` and `reports/reconcile-…` for the other two, and the markdown
on stdout.

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

A `record` run truncates its fixture and writes a provenance header line first
(the store skips a line with no `"key"`, so it is free). The committed one says
`"synthetic": true`.

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
**ambiguity ceiling** next to accuracy: 86.9% on this dataset. Read accuracy
against the ceiling, not against 100%. A v2 dataset that appends the note's first
clause to the merchant is the owner's call, and the review table shows the groups
to decide it from.

## CI

`tests/test_evals_regression.py` runs the three replays above in-process (no
subprocess, no network, no database) and asserts:

1. replay accuracy equals an in-process fake run exactly, and clears
   `EVALS_MIN_ACCURACY` (a placeholder calibrated on this synthetic fixture —
   see its docstring);
2. a replay store that cannot answer raises instead of scoring 0%;
3. `categories.json` and the dataset agree on every label and kind;
4. the extraction replay reproduces an in-process fake run field for field and
   clears `EXTRACT_MIN_ACCURACY` / `EXTRACT_MIN_MERCHANT_ACCURACY` /
   `EXTRACT_MIN_SELF_CHECK`;
5. the reconcile replay reproduces an in-process fake run kind for kind and
   clears `RECONCILE_MIN_SETTLED` / `RECONCILE_MIN_RECALL`;
6. every committed synthetic statement's anchors are the sums of its own gold
   rows — and the three defective ones really do NOT close (a defect that
   stopped being seeded would turn measurement 4's self-check number into a
   constant 100%).

`tests/test_evals_anonymize.py` pins the anonymizer's rules on synthetic inputs.
