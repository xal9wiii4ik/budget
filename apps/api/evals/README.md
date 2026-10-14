# evals — measuring the LLM categorize pass

Offline evaluation of `services/categorize.py` on a labelled set of the owner's
own operations: **accuracy, cost, latency** per provider × model × prompt
version, plus a CI regression that costs nothing.

Nothing in here is imported by the app. It imports the app's `llm/` package and
calls the same `categorize()` the statement import calls, with the production
`CategorizeConfig` defaults — a number in `reports/` is a number about the
shipped code, not about a copy of it.

## There are no real-model numbers yet

The only committed report, `reports/fake-fake-categorize-v1.md`, comes from
`llm/fake.py` — a **substring matcher**, not a model. It exists to demonstrate
the pipeline and to pin its mechanics in CI. Its ~11% accuracy says nothing
about Claude, Ollama or anything else, and the report says so in its own first
lines. No accuracy figure may be quoted anywhere (CV, portfolio, docs) until
someone runs `--mode live` or `--mode record` against a real provider and the
report for that provider/model lands here.

## Run it

All commands from `apps/api`.

```bash
# the committed fixture, no key, no network — this is what CI runs
uv run python evals/run.py --provider fake --mode replay

# the fake for real (in-process), e.g. after changing the pass
uv run python evals/run.py --provider fake --mode live

# a real run that also records every answer for later replay
ANTHROPIC_API_KEY=… uv run python evals/run.py --provider anthropic --mode record
ANTHROPIC_API_KEY=… uv run python evals/run.py --provider anthropic --mode live

# a local Ollama (model from the app's OLLAMA_MODEL default)
uv run python evals/run.py --provider ollama --mode live
```

Flags: `--model` (default: the app's model for that provider), `--threshold`
(default: the app's), `--limit N`, `--dataset`, `--replay-dir`, `--reports-dir`,
`--prompt-version` (must equal the build's `PROMPT_VERSION` — a mismatch refuses
the run rather than mislabelling a report).

Outputs: `reports/<provider>-<model>-<prompt-version>.{md,json}`, and the
markdown on stdout.

### The three modes

| mode | provider calls | money | used for |
| --- | --- | --- | --- |
| `live` | yes | yes, for a hosted model | the real measurement |
| `record` | yes | yes, once | cutting a replay fixture |
| `replay` | no | no | CI, and reproducing a past run |

`replay/<provider>-<model>-<prompt-version>.jsonl` is keyed by a hash of the
whole request: system prompt, data document, output schema, `max_tokens`. So
editing the prompt, the schema or the batching invalidates the fixture, and a
replay run then **raises** (`EvalError`, naming how many rows went unanswered)
instead of reporting a silent 0%. That is the intended loud failure: bump
`PROMPT_VERSION` and re-record.

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

`tests/test_evals_regression.py` runs the replay above in-process (no
subprocess, no network, no database) and asserts:

1. replay accuracy equals an in-process fake run exactly, and clears
   `EVALS_MIN_ACCURACY` (a placeholder calibrated on this synthetic fixture —
   see its docstring);
2. a replay store that cannot answer raises instead of scoring 0%;
3. `categories.json` and the dataset agree on every label and kind.

`tests/test_evals_anonymize.py` pins the anonymizer's rules on synthetic inputs.
