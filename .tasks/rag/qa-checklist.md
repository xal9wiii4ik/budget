# QA Checklist: rag — semantic search, cited Q&A, local embeddings (API level, FULL tier)

## Scope
What only a live HTTP run can prove: a 118 MB int8 ONNX model actually loads INSIDE the API process on this box and ranks RU/PL/EN merchants sensibly; the pull index catches up through the search-time refresh (the one path a unit test mocks away); the `total` under the result list is the server's and adds up across three money buckets; the two 503 arms are distinguishable on the wire; `search_transactions` reaches a real MCP client. Everything pytest proves cheaper — field validation, bucket algebra, CHECK byte-identity, prompt pins, eval floors — is Section A and is NOT re-run live (each omission is named at the bottom with the test that closes it).

Live ceiling: **15 scenarios** (PM policy 2026-08-19), **3 of them STOP-probes** at the S1 boundary. No Anthropic key and no Ollama here: every case runs `LLM_PROVIDER=fake` (D-Q6) or `off`. Mobile frozen; web rendering → web-qa after the frontend plan. Owner data untouched — users are `qa-rag-*@budgetqa.dev` only.

---

## Stand
**Docker-disk guard first:** `docker system df` + `df -h /`. Above **85 %** → STOP, report, prune nothing (memory: docker-disk quirks).

**Model artifact, once** (D-A3/A3; `apps/api/models/` is gitignored). Re-run must print skips and exit 0 (idempotent):
```bash
cd apps/api && uv run python -I scripts/fetch_model.py --manifest model_manifest.json --dest models/multilingual-e5-small
```
**Own DB** (PM policy 2026-08-27 — `budget` on 5443 is the user's live app; a revision landing there wedges his container, 2026-08-27 incident):
```bash
docker exec budget-postgres-1 psql -U budget -d postgres -c "CREATE DATABASE budget_qa_rag"
export QA_DB=postgresql+asyncpg://budget:budget@localhost:5443/budget_qa_rag
cd apps/api && DATABASE_URL=$QA_DB uv run alembic upgrade head
```
**Two API processes** (A3), stdout → `$SCRATCH/rag/api-80NN.log`, ports **8021 / 8022** only — never 8010, 5173, 8000, 8081, 5433:
```bash
export OFF="FX_SCHEDULER_ENABLED=false RECURRING_SCHEDULER_ENABLED=false PUSH_SCHEDULER_ENABLED=false EMBEDDINGS_SCHEDULER_ENABLED=false"
DATABASE_URL=$QA_DB EMBEDDINGS_PROVIDER=onnx LLM_PROVIDER=fake $OFF uv run uvicorn budget_api.app:create_app --factory --port 8021
DATABASE_URL=$QA_DB EMBEDDINGS_PROVIDER=off  LLM_PROVIDER=off  $OFF uv run uvicorn budget_api.app:create_app --factory --port 8022
```
With all four gates false the boot backfill does NOT run (A2 schedules it on the scheduler): the ONLY index path on this stand is the search-time refresh, ≤ 64 rows per search — exactly what RG-8 measures. The limiter is namespaced per app, so 8022's counters are independent.

**LOGIN ONCE** (PM policy 2026-08-18) — reuse `$JWT_A` / `$JWT_B` everywhere. `qa-rag-a@budgetqa.dev` = owner, `qa-rag-b@budgetqa.dev` = stranger, `Qa!Test1234`. Base currency is the register default **RUB** (`DEFAULT_BASE_CURRENCY`), left unchanged.
```bash
curl -s -X POST :8021/auth/register -H 'Content-Type: application/json' -d '{"email":"qa-rag-a@budgetqa.dev","password":"Qa!Test1234"}'
JWT_A=$(curl -s -X POST :8021/auth/login -d 'username=qa-rag-a@budgetqa.dev&password=Qa!Test1234' | jq -r .access_token)
```

### Seed (`$SCRATCH/rag/seed.sh`, HTTP only — no SQL INSERT anywhere)
Accounts (A): `ACC_RUB` RUB · `ACC_PLN` PLN · `ACC_BYN` BYN · `ACC_SAV` RUB (transfer leg). Categories (A): `CAT_PHARM` «Аптека» expense · `CAT_CAR` «Машина» expense · `CAT_GIFT` «Подарки» expense · `CAT_SALARY` «Зарплата» income · `CAT_REN` «Ремонт» expense (renamed in SP-3). JWT writes to `/transactions` carry no rate limit, so the 80-row burst is safe.

**Theme rows** (2026-09-05…09-16, `amount_minor=10000`) — merchant / account / country / category: `Apteka Słoneczna`/PLN/PL/PHARM · `Аптека Заречная`/RUB/RU/PHARM · `Pharmacy Green Cross`/BYN/BY/PHARM · `Автосервис на Мира`/RUB/RU/CAR · `Serwis samochodowy Kowalski`/PLN/PL/CAR · `Car Wash Express`/BYN/BY/CAR · `Подарки и цветы`/RUB/RU/GIFT · `Prezenty dla dzieci`/PLN/PL/GIFT · `Gift Shop Noel`/RUB/DE/GIFT · `Biedronka`/PLN/PL/— (note `zakupy spożywcze`) · `Ремонт квартиры`/RUB/RU/REN · income `Зарплата сентябрь`/RUB/—/SALARY.

**Total-probe rows** — the only rows with `country=AQ` (a code no other seed uses, so `?country=AQ` isolates exactly these four whatever the ranking), `occurred_at=2026-10-02`:

| merchant | account | kind | body extras | bucket (D-R4) | contributes |
|---|---|---|---|---|---|
| `QA Total Base` | ACC_RUB | expense | `amount_minor=150000` | 1 `currency==base` | expense 150000 |
| `QA Total Snapshot` | ACC_PLN | expense | `amount_minor=10000, base_amount_minor=250000` | 2 snapshot | expense 250000 |
| `QA Total Rateless` | ACC_BYN | expense | `amount_minor=5000` | 3 miss (rates table empty, FX gate off) | `unconverted_count` +1 |
| `QA Total Income` | ACC_RUB | income | `amount_minor=300000` | 1 | income 300000 |

Hand-computed expectation for `?q=QA Total&country=AQ&limit=50` → `currency="RUB"`, `income_minor=300000`, `expense_minor=400000`, `net_minor=-100000`, `unconverted_count=1`, 4 items.

**Transfer**: ACC_RUB → ACC_SAV, 50000 minor, 2026-10-03 (makes RG-5's `kind=transfer` empty meaningful). **User B**: own RUB account + `Apteka Bobrujskaja`, `Подарки от Бориса`, country BY — `Bobrujskaja` is the word that must never surface for A.

---

## Section A — pytest (owner: backend-engineer)
Themes, not assertions; architecture «Test seams» 1–5 is the base list and the engineer's `plan*.md` is authoritative. QA asks that these be among them, since the live run deliberately does NOT re-check them:
- **S1 embeddings / text / index** — `FakeEmbedder` determinism + L2 norm; `OnnxEmbedder.load` with a wrong sha → `None` + ONE warning, never a boot failure; `tx_text` template pin (full row + merchant-only) and `TEXT_VERSION` inside the hash; `country_names` count + `PL`/`BY`/`DE` + unknown → `(XX)`; `_NOT_TRANSFER_OR_DEBT` population (transfer and debt movement never indexed); staleness from PATCH'd merchant / renamed category / renamed account / `TEXT_VERSION` bump; DELETE → cascade; sweep row cap + time budget; FK race rolls back ONE batch; `0020` CHECK byte-identity ×3.
- **S2 search / Q&A** — every field-level 422 of `q`/`limit`/`min_score`; `read_filters` reuse (filter semantics cannot drift); `min_score` applied after top-k; tie order `occurred_at desc, id`; `search_max_candidates` cut and `candidates`; all three `converted_total_for_rows` buckets incl. a stale snapshot bypassed by arm 1; `require_embedder` 503 when `app.state.embedder is None`; `SEARCH_QUERY_BLANK`; the Q&A verifier matrix (unknown key, duplicate, first-appearance order, answer stripped/cut, empty → 422 `QA_FAILED`); gate order llm-before-embedder; PAT on `/advisor/qa` in the derived never-set; `qa-v1` fingerprint pin; `READ_TOOLS` +1, snapshot 41, `test_pat_auth` allowlist +1.
- **S3 evals** — `gen_retrieval --seed` determinism; recall/MRR arithmetic over a hand-made gold set; groundedness = `dropped / citations_before_drop`; replay in CI with no network and no DB; fake reports `synthetic: true`, the local onnx report `real: true`.

**Gates I verify at /test** (not re-run from Section A): `uv run pytest` on `budget_test` (NOT the QA DB), `alembic upgrade head && alembic check`, `pnpm --filter @budget/api-client test`, `pnpm turbo lint typecheck test`.

---

## Section B — live run (owner: QA). 15 cases, 3 STOP-probes.
STOP-probes (`[stop]`) run at **S1's own /test** — where the real model first lives inside the API — and are not re-run at scope end unless the code under them moved. S1 has no HTTP search yet, so SP-2/SP-3 drive `tx_index`/the embedder directly against the QA DB via `uv run python -I` one-offs. The rest runs once, end of scope, in order. Each case records **Actual** and flips **Status** (⏸ → ✅/❌/⚠/🚫).

### SP-1 [stop] The real artifact loads inside the API process
Fetch (sha-verified, idempotent) → boot 8021 with `EMBEDDINGS_PROVIDER=onnx`. Expect `GET :8021/health` **200**; the log carries the load line with the model stamp `intfloat/multilingual-e5-small@614241f/model.onnx` and **zero** WARNING lines mentioning embeddings; readiness is not delayed beyond the ~0.3 s load (A2 — it must not wait for a backfill); `ps -o rss=` of the uvicorn worker after warm-up and again after one 32-batch, both recorded for `docs/deploy.md` (D-A4 expects ≈ 560–700 MB; **ASK-3** for the failing number). Then flip the same process to `EMBEDDINGS_PROVIDER=off` once → exactly one WARNING, `/health` still 200 (a missing model is never a boot failure). — **Status**: ✅ pass (2026-10-19, with two amendments)

**Actual**: `GET :8021/health` **200** in 8 ms, body `{"status":"ok","database":"ok"}`; readiness was not delayed (the load line sits between "Waiting for application startup" and "Application startup complete"). Log line verbatim:
`INFO: budget_api.embeddings.onnx: embeddings loaded model=intfloat/multilingual-e5-small@614241f/model.onnx dim=384 threads=1` — the stamp of FLAG-1 byte for byte. **Zero** WARNING lines mentioning embeddings (the only warnings in the log are pyjwt `InsecureKeyLengthWarning` ×2, about the stand's short `JWT_SECRET`, unrelated).
RSS of the uvicorn worker (`ps -o rss=`, PID 43503, KB): **48 512 → 108 896** idle after boot (macOS compresses an idle worker; the two reads are minutes apart), **222 128** right after the first search, **179 504** steady after 95 rows embedded (two 32-batches + a 16-batch) and ~30 searches; peak observed **222 MB**. The embedder-less twin on 8022 (same image, same code, PID 43504) sits at **38 080 KB**, so the loaded artifact costs ≈ **140 MB resident** on this host, not the ≈ 560–700 MB D-A4 predicted — onnxruntime mmaps the 118 MB int8 file, so most of it is file-backed, not anonymous. Well under ASK-3's ⚠ 900 MB / ❌ 1.2 GB. Warm search latency 17–21 ms. **→ `docs/deploy.md` should carry the host figure (≈ 180 MB steady / 222 MB peak) beside the container one.**
Amendment 1: the "flip this process to `off`" step was replaced by the **separate 8022 process** (orchestrator's instruction — 8021 must not be restarted); it proves the same thing: `/health` 200 and every non-search route alive with no embedder (RG-9).
Amendment 2 (checklist was wrong, code is right): `EMBEDDINGS_PROVIDER=off` logs **no** warning at all, by design — `embeddings/registry.py` warns only for an UNKNOWN provider, and the "exactly one WARNING" path is a MISSING/corrupt ARTIFACT (`app.py` lifespan: `logger.warning("embeddings disabled: %s", exc)` → `app.state.embedder = None`, never a boot failure). An explicit `off` is an operator decision and is silent. The artifact-missing arm is S1 pytest's (`OnnxEmbedder.load` with a wrong sha → `None` + one warning); not re-run live, since doing so would have meant restarting 8021.

### SP-2 [stop] The index fills, and real vectors rank
`tx_index.refresh(..., max_rows=1000)` for user A over the seed → `embedded` = the non-transfer/non-debt row count, `pending=0`. One SQL over `transaction_embeddings`: row count = that population (transfer absent), every `octet_length(vector)=1536`, one distinct `model`, every `text_hash` 64 hex. Then in-process cosine over the STORED vectors (no HTTP): `q="аптека"` → `Apteka Słoneczna` and `Pharmacy Green Cross` in the **top 3**; `q="prezenty"` → `Подарки и цветы` in the top 3. Expectation is **rank, not score** — scores recorded only. A second `refresh` right after → `embedded=0`. — **Status**: ✅ pass (2026-10-19)

**Actual** (`uv run python -I $SCRATCH/rag/sp2.py <user A>` with `EMBEDDINGS_PROVIDER=onnx`, `DATABASE_URL=…/budget_qa_rag`): stamp and dim read back from the constructed embedder — `intfloat/multilingual-e5-small@614241f/model.onnx`, `dim=384`, batch 32.
`refresh#1 = RefreshStats(embedded=16, pending=0)`; `refresh#2 = RefreshStats(embedded=0, pending=0)`.
SQL over `transaction_embeddings` for A: `n=16`, `count(distinct model)=1`, `min(octet_length(vector))=max(…)=1536`, `text_hash ~ '^[0-9a-f]{64}$'` for **16/16**. Population check: 17 transactions total, **16 non-transfer** → the index holds exactly the money population; `transfer rows indexed = 0`.
Cosine over the STORED vectors (no HTTP), top 5:
`q="аптека"` → 1. **0.8687 Apteka Słoneczna** · 2. 0.8666 Аптека Заречная · 3. **0.8578 Pharmacy Green Cross** · 4. 0.8363 Gift Shop Noel · 5. 0.8217 Подарки и цветы → both PL and EN pharmacies in the top 3 ✅
`q="prezenty"` → 1. 0.8448 Prezenty dla dzieci · 2. 0.8247 Gift Shop Noel · 3. **0.8148 Подарки и цветы** · 4. 0.8062 Biedronka · 5. 0.8054 Pharmacy Green Cross → the RU gift row in the top 3 ✅

### SP-3 [stop] Staleness repairs; deletion cascades
Over HTTP: `PATCH /transactions/{id}` merchant `Biedronka` → `Żabka`; `PATCH /categories/$CAT_REN` name «Ремонт» → «Стоматология». Then `refresh` → `embedded` = exactly 2 (the PATCH'd row + the renamed category's row), `pending=0`, both `text_hash` changed, `model` unchanged. `DELETE /transactions/{id}` of one theme row → its embedding row gone by cascade (SQL count −1) with no refresh run. — **Status**: ✅ pass (2026-10-19)

**Actual**: `PATCH /transactions/$TX_BIEDRONKA {"merchant":"Żabka"}` → **200**; `PATCH /categories/$CAT_REN {"name":"Стоматология"}` → **200**. `refresh` → `RefreshStats(embedded=2, pending=0)` — exactly the two rows, nothing else re-embedded.
`text_hash` before → after: Żabka row `a60b9022…` → `89a609d9…`; «Ремонт квартиры» (the renamed category's row) `6ff7d488…` → `f0a45062…`. `model` unchanged on both (`…@614241f/model.onnx`), i.e. the staleness is the HASH and only the hash.
`DELETE /transactions/$TX_BIEDRONKA` → **204**, no refresh run afterwards: `select count(*) … where user_id=A` **16 → 15** and `… where transaction_id = $TX_BIEDRONKA` → **0**. The category rename also showed up end-to-end later: in RG-7 «Ремонт квартиры» ranks #2 for `q=стоматолог` purely through its renamed category.

### RG-1 First semantic search over real HTTP
`GET :8021/transactions/search?q=аптека&limit=20` with `$JWT_A` → **200**: `items` non-empty, `score` non-increasing and 4 dp; each `items[].transaction` is a full `TransactionRead` (id, amount_minor, currency, occurred_at, merchant, category_id — the shape the web renderer and MCP already consume, unextended); `model` = the SP-1 stamp; `candidates` = the indexed population; `pending_count=0`; `total.currency="RUB"`. Same frame: the log shows a refresh line only if it embedded > 0 rows (A7). — **Status**: ✅ pass (2026-10-19)

**Actual**: **200** in **45.7 ms**, 15 items (the whole indexed population after SP-3's delete). Scores strictly non-increasing, 4 dp: 0.8687 Apteka Słoneczna · 0.8666 Аптека Заречная · 0.8578 Pharmacy Green Cross · 0.8363 Gift Shop Noel · 0.8251 Ремонт квартиры · 0.8217 Подарки и цветы · 0.8202 Prezenty dla dzieci · 0.8194 Car Wash Express · 0.8189 Зарплата сентябрь · 0.8137 Автосервис на Мира · 0.8097 QA Total Income · 0.8093 QA Total Base · 0.8079 QA Total Rateless · 0.8029 QA Total Snapshot · 0.7922 Serwis samochodowy Kowalski.
`items[0].transaction` is the full `TransactionRead` — 24 keys incl. `id, account_id, amount_minor, kind, currency, base_amount_minor, base_currency, category_id, occurred_at, note, merchant, country, counter_*, original_*, transfer_rate, original_rate, goal_item_id, debt_id, receipt_id, recurring_template_id, created_at` — nothing added, nothing removed.
`model="intfloat/multilingual-e5-small@614241f/model.onnx"`, `candidates=15` (= the indexed population), `pending_count=0`, `total.currency="RUB"`.
Log: only the access line, **no** `embeddings search refresh` line — nothing was stale, exactly the A7 rule (the line does appear in RG-7/RG-8, where work was done).

### RG-2 Multilingual sanity — the point of the scope
Three queries, `limit=10`: `q=аптека` → `Apteka Słoneczna` **and** `Pharmacy Green Cross` in the top 3; `q=prezenty dla bliskich` → `Подарки и цветы` and `Gift Shop Noel` in the top 3; `q=car repair` → `Автосервис на Мира` and `Serwis samochodowy Kowalski` in the top 3. Expectation is **rank**; the score spread is recorded as evidence for D-R3 (no default `min_score` in v1), never asserted. A miss is a finding about the model, not automatically a defect — report with the ranked list. — **Status**: ⚠ 5 of 6 expectations met; one rank miss by a 0.007 margin (model behaviour, not a defect)

**Actual** (`limit=10`, top 6 of each):
`q=аптека` → 1. **0.8687 Apteka Słoneczna** · 2. 0.8666 Аптека Заречная · 3. **0.8578 Pharmacy Green Cross** · 4. 0.8363 Gift Shop Noel · 5. 0.8251 Ремонт квартиры · 6. 0.8217 Подарки и цветы — **✅ both in the top 3**: a Russian word found a Polish and an English merchant that share none of its letters.
`q=prezenty dla bliskich` → 1. 0.8512 Prezenty dla dzieci · 2. **0.8142 Gift Shop Noel** · 3. 0.8072 Apteka Słoneczna · 4. **0.8002 Подарки и цветы** · 5. 0.7964 Serwis samochodowy Kowalski · 6. 0.7876 Pharmacy Green Cross — **⚠ Gift Shop Noel ✅ #2, Подарки и цветы #4, not top 3**: an unrelated pharmacy row sits between them at 0.8072 vs 0.8002, a **0.007** gap. (The plain `q=prezenty` of SP-2 puts «Подарки и цветы» at #3 — the extra words "dla bliskich" are what blur it.)
`q=car repair` → 1. **0.848 Serwis samochodowy Kowalski** · 2. **0.8392 Автосервис на Мира** · 3. 0.8371 Car Wash Express · 4. 0.8313 Ремонт квартиры · 5. 0.8055 Gift Shop Noel · 6. 0.799 Prezenty dla dzieci — **✅ both in the top 3**.
Score spread as evidence for D-R3: the whole ranked list of 15 spans **0.8687 … 0.7922**, i.e. right and wrong rows live inside **0.08**, and neighbours differ by 0.002–0.007. That is the measured reason there is no default `min_score` and why the MCP description forbids filtering on the score — confirmed on real data, not assumed.

### RG-3 The number the user reads: `total` across three buckets
`GET …/search?q=QA%20Total&country=AQ&limit=50` → **200**, 4 items, exactly the seed table's hand-computed figures (`RUB`, income `300000`, expense `400000`, net `-100000`, `unconverted_count=1`). Cross-check: the rate-less BYN row IS among the items — searchable but unconvertible, the honest arm — and no client-side sum is needed to reproduce the header. — **Status**: ✅ pass (2026-10-19) — the hand-computed figures, exactly

**Actual**: **200**, 4 items, `candidates=4`, `pending_count=0`.
`total = {"currency":"RUB","income_minor":300000,"expense_minor":400000,"net_minor":-100000,"unconverted_count":1}` — identical to the seed table's hand-computation, bucket by bucket: 150000 (RUB, `currency==base`) + 250000 (`base_amount_minor` snapshot on the PLN row, NOT its 10000 PLN face) = 400000 expense; 300000 income; net −100000.
The three buckets are visible in the items themselves: `QA Total Base` RUB 150000 `base=null` · `QA Total Income` RUB 300000 · `QA Total Snapshot` **PLN 10000 with `base_amount_minor=250000`** · `QA Total Rateless` **BYN 5000 `base=null`** — the rate-less row IS listed (ranked 4th, 0.8729) and is counted in `unconverted_count=1` instead of being summed as zero. A client adding the four face amounts would print a different, wrong number; the server's total is the only one that holds.

### RG-4 No-oracle: B's money never appears for A
With `$JWT_A`: `q=Bobrujskaja` → **200** `items: []`. `q=подарки&account_id=<B's account>` → **200** with a body **byte-identical** to the same request carrying a random UUID `account_id` (empty items, zero total, `unconverted_count=0`, same `model`, `candidates=0`) — a foreign id is indistinguishable from a non-existent one. Same with B's `category_id`. Mirror once: `$JWT_B` searching `Заречная` → `items: []`. — **Status**: ✅ pass (2026-10-19); the `items: []` half of the expectation was MIS-WRITTEN at grooming — see below

**Actual**: foreign vs random `account_id` → both bodies **203 bytes, `cmp` byte-identical**; same for `category_id`. The shared body:
`{"items":[],"total":{"currency":"RUB","income_minor":0,"expense_minor":0,"net_minor":0,"unconverted_count":0},"pending_count":0,"candidates":0,"model":"intfloat/…@614241f/model.onnx"}` — a foreign id and an id that never existed are indistinguishable on the wire, down to the byte.
**Checklist correction**: `q=Bobrujskaja` with `$JWT_A` does NOT answer `items: []`, and must not — v1 has **no default `min_score`** (D-R3), so a semantic search always ranks the caller's own rows, however far they are. What the no-oracle rule actually requires is that B's rows never appear, and that holds: A's 15 hits for `q=Bobrujskaja` are A's own 15 merchants (`Prezenty dla dzieci … QA Total Rateless`), with **no `Apteka Bobrujskaja` and no `Подарки от Бориса`**. Mirror: `$JWT_B` `q=Заречная` → exactly B's two rows (`Apteka Bobrujskaja`, `Подарки от Бориса`) and **no `Аптека Заречная`**, the row whose name he spelled. Scoping is per-user in the candidate query, so the word "Bobrujskaja" buys A nothing — the right proof, written down wrong at grooming.

### RG-5 Filters compose; `kind=transfer` is an honest empty
`q=аптека` unless stated: `from=2026-09-01&to=2026-09-30` → September rows only; `+account_id=$ACC_PLN` → `Apteka Słoneczna` only; `+country=PL` → PL rows only; `category_id=$CAT_PHARM` → the three pharmacy rows and nothing else; `q=зарплата&kind=income` → the income row only; `from=2026-01-01&to=2026-01-31` → empty. Then `q=перевод&kind=transfer` → **200**, `items: []`, zero total — the transfer exists in the ledger and is deliberately unindexed (D-T4). — **Status**: ✅ pass (2026-10-19); two expectations re-read against "no default `min_score`" (same correction as RG-4)

**Actual** (all `limit=50`, so `candidates` = the filtered population and nothing is cut by the limit):
- `from=2026-09-01&to=2026-09-30` → 11 items / `candidates=11`: every September theme row and **no October row** (no `QA Total *`, no transfer). 11 not 12 because SP-3 deleted the Żabka row.
- `+account_id=$ACC_PLN` → 3 items: `Apteka Słoneczna`, `Prezenty dla dzieci`, `Serwis samochodowy Kowalski` — exactly the PLN account's September rows. (Checklist said "Apteka Słoneczna only"; with no threshold the other two PLN rows are ranked below it rather than dropped. The filter is what is under test and it is exact.)
- `+country=PL` → the same 3 rows — the country filter and the account filter agree on this seed.
- `category_id=$CAT_PHARM` → **exactly the 3 pharmacy rows** and nothing else, `candidates=3`.
- `q=зарплата&kind=income` → 2 items, `Зарплата сентябрь` 500000 + `QA Total Income` 300000, `total.income_minor=800000`, `expense_minor=0`. (Checklist said "the income row only" — the seed has two income rows, its own table included.)
- `from=2026-01-01&to=2026-01-31` → `items: []`, `candidates=0`, zero total.
- `q=перевод&kind=transfer` → **200**, `items: []`, `candidates=0`, zero total — while the transfer itself is alive in the ledger (`GET /transactions` lists it). Honest empty, not an error.

### RG-6 Wire refusals and bounds in one pass
`q=%20%20` → **422** `SEARCH_QUERY_BLANK` (string code, not a Pydantic array); `q` of 501 chars → 422; `limit=0` → 422; `limit=51` → 422; `limit=1` → 200 with exactly 1 item; `limit=50` → 200; `min_score=1.5` → 422; `min_score=0.99` → 200 `items: []` with the same envelope; `min_score` set just below RG-2's third score → exactly the hits above it, same order. — **Status**: ✅ pass (2026-10-19), all nine

**Actual** (status :: body):
- `q=%20%20` → **422** `{"detail":"SEARCH_QUERY_BLANK"}` — a plain string code, not a Pydantic array ✅
- `q` of 501 chars → **422** Pydantic array `string_too_long … max_length 500`; the 500-char boundary → **200**, 15 items (the inclusive edge is open) ✅
- `limit=0` → **422** `greater_than_equal ge=1`; `limit=51` → **422** `less_than_equal le=50`; `limit=1` → **200** with exactly 1 item (`Apteka Słoneczna`); `limit=50` → **200**, 15 items (the whole population, not 50 empty slots) ✅
- `min_score=1.5` → **422** `less_than_equal le=1.0` ✅
- `min_score=0.99` → **200** `items: []` with the SAME envelope as a hit page: `total` zeroed in RUB, `pending_count=0`, `candidates=15` (the scan happened, the cut removed everything), same `model` ✅ — note `candidates` stays 15 here and is 0 in RG-4, which is the honest difference between "nothing passed the threshold" and "nothing was in scope".
- `min_score=0.857` (just under RG-2's third score 0.8578) → **200** with exactly the three rows above it, in the same order: 0.8687 Apteka Słoneczna · 0.8666 Аптека Заречная · 0.8578 Pharmacy Green Cross ✅

### RG-7 "I just added it, now search" — the refresh / edit / delete loop over HTTP
`POST /transactions` merchant `Стоматология Улыбка`, then immediately `GET …/search?q=стоматолог` → the new row present, `pending_count=0` (search-time refresh). `PATCH` its merchant → `Апельсиновая лавка`: `q=стоматолог` no longer returns it, `q=апельсины` does. Rename `CAT_GIFT` «Подарки» → «Сувениры»: `q=сувениры` finds the three gift rows by the NEW name. `DELETE` the new row → gone from `q=апельсины`, `candidates` down by one. — **Status**: ✅ pass (2026-10-19) — the loop the user actually performs

**Actual**:
1. `POST /transactions` «Стоматология Улыбка» (2026-10-05, RUB 20000) → immediately `q=стоматолог`: the new row is **rank 1 at 0.8591**, `pending_count=0`, `candidates` 15→**16**, and the log carries exactly one line `embeddings search refresh embedded=1 pending=0` — the search-time refresh did the work inline, within the same request. Rank 2 is «Ремонт квартиры» 0.8527, which has nothing to do with teeth except the category SP-3 renamed to «Стоматология»: the rename reached the wire.
2. `PATCH merchant → «Апельсиновая лавка»` → `q=стоматолог` now puts it at **rank 7 of 16**, below `Ремонт квартиры`/`Аптека Заречная`/`Apteka Słoneczna`, i.e. out of the answer; `q=апельсины` puts it at **rank 1, 0.8543**. (Literal "no longer returns it" is again the no-threshold correction of RG-4: it leaves the top, it is not removed from a 16-row ranking.)
3. `PATCH /categories/$CAT_GIFT «Подарки» → «Сувениры»` → `q=сувениры` returns the three gift rows at **ranks 1-3 by the NEW name**: 0.867 Prezenty dla dzieci · 0.8645 Подарки и цветы · 0.8581 Gift Shop Noel. No writer was touched; one category row changed and three documents re-embedded themselves on the next search.
4. `DELETE` the new row → **204**; `q=апельсины` no longer contains its id at all, `candidates` **16 → 15**.

### RG-8 An 80-row burst: `pending_count` is honest, the refresh is bounded at 64
Create 80 rows in one loop with NO search in between. First `GET …/search?q=burst&limit=5` → **200** with `pending_count > 0`, expected ≈ 80 − 64 = **16** (`search_max_refresh`, D-I3c); the second identical search → `pending_count=0` and the late rows now appear. The sweep gate is false on this stand, so the only mover is the search-time refresh — which is what makes the bound visible. — **Status**: ✅ pass (2026-10-19) — 16 on the nose

**Actual**: 80 rows (`QA burst row 1..80`, 2026-10-10, RUB 1000) created in **1 s** with no search in between, all 201.
First `GET …/search?q=burst&limit=5` → **200**: `pending_count=16` (= 80 − `search_max_refresh` 64, D-I3c), `candidates=79` (15 old + the 64 just embedded), 5 burst rows on top. Log: `embeddings search refresh embedded=64 pending=16`.
Second identical search → **200** in 93 ms: `pending_count=0`, `candidates=95`, and the late rows are now in the ranking (`QA burst row 52` and `row 4` appear where they had not been). Log: `embeddings search refresh embedded=16 pending=0`.
Third, with nothing left to do → **14.8 ms** and no refresh line. So the bound is real, the remainder is reported rather than silently missing, and one more search is all it takes to clear it — on a stand where the 5-minute sweep is OFF, which is what makes the attribution unambiguous.
RSS of the worker across this (SP-1's "after a 32-batch" reading): 143 952 KB before → 179 504 KB after two 32-batches and a 16-batch, flat afterwards.

### RG-9 Both 503 arms are distinguishable on 8022
`GET :8022/transactions/search?q=аптека` → **503** `{"detail":"EMBEDDINGS_NOT_AVAILABLE"}`. `POST :8022/advisor/qa {"question":"подарки"}` → **503** `{"detail":"AI_NOT_CONFIGURED"}` — the LLM gate fires FIRST (D-Q1 order), so the two causes never blur. Same process: `GET :8022/transactions?limit=5` → **200** (nothing else moved); the boot log carries exactly one embeddings WARNING. — **Status**: ✅ pass (2026-10-19) on all three wire assertions; the "one WARNING" sub-expectation was wrong — see SP-1 amendment 2

**Actual** (8022 = `EMBEDDINGS_PROVIDER=off` + `LLM_PROVIDER=off`, same DB, same `$JWT_A`):
- `GET :8022/transactions/search?q=аптека` → **503** `{"detail":"EMBEDDINGS_NOT_AVAILABLE"}`
- `POST :8022/advisor/qa {"question":"подарки"}` → **503** `{"detail":"AI_NOT_CONFIGURED"}` — the LLM gate fires FIRST even though BOTH are missing, so the two causes never blur (D-Q1 order, confirmed on the wire)
- `GET :8022/transactions?limit=5` → **200**, 5 rows — the ledger is untouched by the missing model
- Boot log: **zero** embeddings warnings, and that is correct. `off` is an explicit operator choice and `embeddings/registry.py` says nothing about it; the single-warning path is a MISSING artifact (`app.py`: `embeddings disabled: …`). RSS of this twin — 38 080 KB vs 8021's 179 504 KB — is itself the proof that no model is resident, and is the "RAM retreat" number for `docs/deploy.md`.

### RG-10 PAT and MCP reach search; Q&A stays human-only
`POST /tokens` scope `read` → `$PAT_R`. `GET /tokens/self` with `$PAT_R` → **200** `scope="read"`. `GET /transactions/search?q=аптека` with `$PAT_R` → **200**, same hits as RG-1. `POST /advisor/qa` with `$PAT_R` → **401** (ruled: JWT-only like `/advisor/ask`). Then stdio MCP (driver recipe in `.tasks/mcp-decorators/qa-checklist.md`: `Popen`, stdin held open, `initialize` → `notifications/initialized` → frames), env `BUDGET_API_URL=http://localhost:8021 BUDGET_PAT=$PAT_R`: `tools/list` → exactly **23** read tools with `search_transactions` among them and no Q&A tool; its `inputSchema` is flat and carries `q, limit, min_score, from, to, account_id, category_id, kind, country`. `tools/call search_transactions {"q":"подарки","limit":5}` → ranked hits plus the server `total`. — **Status**: ✅ pass (2026-10-19)

**Actual**: `POST /tokens {"name":"qa-rag read","scope":"read"}` → `bgt_pat_mmQg…`. `GET /tokens/self` with it → **200** `{"id":"851f26f3-…","scope":"read"}`.
`GET /transactions/search?q=аптека&limit=20` with `$PAT_R` → **200**, the SAME top 3 as RG-1 (0.8687 / 0.8666 / 0.8578), same `model`, `candidates=95` — a PAT reads the semantic surface exactly as the browser does.
`POST /advisor/qa` with `$PAT_R` → **401** `{"detail":"Unauthorized"}` — the grooming ruling (JWT-only `stash_rl_user`, like `/advisor/ask`), not 403. S2's `NEVER_PAT` test must assert 401 too.
stdio MCP (`Popen`, stdin held open, `initialize` → `notifications/initialized` → frames; driver `$SCRATCH/rag/mcpprobe.py`, env `BUDGET_API_URL=http://localhost:8021 BUDGET_PAT=$PAT_R`): stderr `budget-mcp: ready — 23 tools, token scope "read", API http://localhost:8021, uploads off`.
`tools/list` → **exactly 23** tools, all read (`convert_currency, get_debt, get_deposit, get_goal, get_goal_plan, get_goal_progress, get_profile, get_stats_monthly, get_stats_summary, get_top_merchants, get_transactions_summary, list_accounts, list_categories, list_debts, list_deposits, list_goal_contributions, list_goals, list_limits, list_recurring, list_transactions, list_upcoming_goal_deadlines, list_upcoming_recurring, **search_transactions**`) — 22 before + 1, no `create_/update_/delete_/upload_` name, and **no Q&A tool** (`qa`/`advisor`/`ask` match nothing).
`search_transactions.inputSchema` is **flat** (no nested object property) and carries exactly `account_id, category_id, country, from, kind, limit, min_score, q, to`, `required: ["q"]`.
`tools/call search_transactions {"q":"подарки","limit":5}` → `isError:false`, 5 ranked hits — 0.8643 Подарки и цветы · 0.8546 Prezenty dla dzieci · 0.8493 Gift Shop Noel · 0.8298 Pharmacy Green Cross · 0.8242 Аптека Заречная — plus the server block `total {RUB, income 0, expense 30000, net −30000, unconverted_count 2}`, `pending_count=0`, `candidates=95`, `model=…@614241f/model.onnx`. A client model gets the ranking AND the sum it is told not to compute itself.

### RG-11 Q&A cites only what the server retrieved
On 8021 with `$JWT_A`. (a) `{"question":"подарки","limit":10}` → **200**: `answer` non-null, `retrieved_count>0`, every `citations[].transaction.id` ∈ the ids of `GET …/search?q=подарки&limit=10`, `dropped_citations=0`, `total` equal to that search's total, `provider="fake"`, `model="fake"`, `prompt_version="qa-v1"`; the log gains exactly ONE `llm call … prompt=qa-v1` line with the full key=value set. (b) `{"question":"QA_CITE_FOREIGN подарки"}` → **200**, `dropped_citations=1`, surviving citations still ⊆ retrieved (the marker rides with a theme word on purpose — a question that retrieves nothing never reaches the model). (c) `{"question":"подарки","from":"2020-01-01","to":"2020-01-31"}` → **200**, `retrieved_count=0`, `answer: null`, `citations: []`, **no new** `llm call` line (D-Q3 — zero hits spend no tokens). (d) `{"question":"LLMFAIL подарки"}` → **503** `{"detail":"AI_UNAVAILABLE"}`, same marker-plus-theme reason as (b). — **Status**: ✅ pass (2026-10-19), all four arms

**Actual**:
(a) **200**: `answer="scripted fake answer: o1"`, `retrieved_count=10`, `dropped_citations=0`, the one citation id `11aee8a6-…` is in the id set of `GET …/search?q=подарки&limit=10` (`citations ⊆ retrieved` → true), and `total` is **equal field-for-field** to that search's total (`RUB, income 500000, expense 41000, net 459000, unconverted_count 4`). `provider="fake"`, `model="fake"`, `prompt_version="qa-v1"`. Log gains **exactly one** line with the full set: `llm call provider=fake model=fake prompt=qa-v1 outcome=ok batch=10 latency_ms=0 in=0 out=0 cache_read=0 cost_usd=0 user=6932664a-…`.
(b) `QA_CITE_FOREIGN подарки` → **200**, `dropped_citations=1`, 6 surviving citations. First comparison was mine, not the server's: I checked them against (a)'s retrieval, and the marker word changes the embedding, so the retrieval differs. Against **this question's own** `GET …/search?q=QA_CITE_FOREIGN подарки&limit=10` the surviving citations are a subset — positions **1, 6, 7, 8, 9, 10** — and the fabricated `o999` is the one that was dropped. `total` equals that search's total too.
(c) `подарки` with `from=2020-01-01&to=2020-01-31` → **200**, `retrieved_count=0`, `answer: null`, `citations: []`, zeroed total, and **no new `llm call` line** (grep count 0 across the request): zero hits spend no tokens (D-Q3), and the ASK-4 rule `answer: null ⇔ retrieved_count == 0` holds on the wire.
(d) `LLMFAIL подарки` → **503** `{"detail":"AI_UNAVAILABLE"}`; the log line is `outcome=error:unavailable batch=20 … cost_usd=-`, so a broken provider is attributable and still costed-out, not a silent 500.

### RG-12 Limiters (runs LAST — it burns both budgets)
31 searches inside a minute → the 31st **429** `RATE_LIMITED` (`search_rate_limit 30/minute`, per user); a `$PAT_R` search in the same window additionally obeys the PAT read limit (defence in depth, D-R1 — record which fires). 6 `POST /advisor/qa` inside a minute → the 6th **429** (`5/minute;30/day`). Wait the window out before cleanup. — **Status**: ✅ pass (2026-10-19) — both budgets cut exactly where configured

**Actual** (run last, from a clean window — the script waits 75 s before each burst):
- 31 searches with `$JWT_A` in one minute: **#1–#30 → 200, #31 → 429 `{"detail":"RATE_LIMITED"}`** (`search_rate_limit 30/minute`), the string code, not slowapi's default HTML/JSON.
- A `$PAT_R` search in the SAME window → **429 `RATE_LIMITED`** as well, and the one that fired is the **search limiter**, not the PAT read limit: `search_rl_key` is `user_rl_key("search")`, keyed on `request.state.rl_user_id`, so a PAT and a browser session of the same account share ONE 30/minute search budget. The PAT's own `pat_read_rate_limit 60/minute` is the outer bound and can only fire on a user who has not already spent the inner one — defence in depth in the right order (D-R1).
- 6 `POST /advisor/qa` in one minute: **#1–#5 → 200, #6 → 429 `RATE_LIMITED`** (`advisor_qa_rate_limit 5/minute;30/day`). Day budget used by the whole run: 10 of 30.
- Both windows were waited out before cleanup, so nothing downstream inherited a spent budget.

---

## Not run live (and what closes each)
- Field-level 422 shapes, `read_filters` semantics, tie order, `search_max_candidates` → S2 pytest; RG-6 only proves the codes reach the wire.
- Each total bucket in isolation, stale-snapshot bypass, `net_minor` algebra → S2 pytest (`converted_total_for_rows`); RG-3 proves one assembled number.
- Sweep cap / time budget / FK-race rollback / boot backfill → S1 pytest; the stand runs with the sweep gate false by design.
- `TEXT_VERSION` bump re-embedding the world, `tx_text` template, country-name table → S1 pytest (pure functions, no HTTP).
- Q&A verifier matrix beyond the foreign key (duplicates, order, truncation, `QA_FAILED`) → S2 pytest; the scripted fake never produces them.
- Anthropic/Ollama wire shapes, real-model answer quality, eval numbers → S3 + the local onnx report; no key and no Ollama on this machine.
- `0020` CHECKs, downgrade, `alembic check` → S1 pytest + the gate I run at /test.
- The amd64 image build + container RSS → A4 at the S1 diff gate (engineer), recorded in `docs/deploy.md`; SP-1 measures the host process only.
- PAT scope matrix on other routes, 404 no-oracle on `/transactions/{id}` → existing `tokens`/`mcp-decorators` checklists; unchanged here.
- Web "by meaning" toggle, Q&A section, citation click-through, `pending_count` copy → web-qa after Web A. Mobile frozen.

## Cleanup (end of run) — done 2026-10-19
- Delete every row I created through the API (transactions → accounts → categories → tokens) for both users; no SQL DELETE anywhere.
  **Done**: 96 transactions (user A) + 2 (user B) deleted, all **204**, `GET /transactions` → `total: 0` for both; `transaction_embeddings` for both users **0** (FK cascade, no sweep involved); the read PAT revoked (204).
  **Correction to this line**: accounts and categories have **no DELETE** in the contract (`/accounts/{id}` and `/categories/{id}` expose `patch` only — a DELETE answers **405**). They were **archived** instead (`PATCH {"archived":true}` → 200 ×5). The next checklist that copies this cleanup recipe should say "archive", not "delete".
  Verification that nothing foreign was touched (read-only SQL): `qa-rag-a` 0 tx / 0 embeddings, `qa-rag-b` 0 / 0, **`qa-rag-web` 134 tx / 134 embeddings untouched**, `qa-rag-web2` 0 — the concurrent web-qa run kept every row it had.
  **Process note**: the stand's JWTs live **one hour**. A first cleanup pass ran past that boundary and spent ~6 600 DELETEs answering 401 before its list call returned `{"detail":"Unauthorized"}`; nothing was deleted and nothing foreign was reachable (a JWT only ever addresses its own rows), but a long live run must re-login before the teardown, not reuse the login from LOGIN ONCE. LOGIN ONCE still holds for the run itself — this is one extra login at the end, not per TC.
- Stop the uvicorns I started (8021/8022), confirm the ports are dead; 8010/5173 and the user's containers are never touched. `apps/api/models/` stays (gitignored, reusable).
- `budget_qa_rag` is LEFT in place and **reported** to the orchestrator — `DROP DATABASE budget_qa_rag` is his call, not mine. `budget` on 5443 untouched, its revision unmoved.
- `docker system df` once more in the final report.

## Questions to the architecture
- **ASK-1** `POST /advisor/qa` with a read PAT: **401** («Test seams» 4) or **403 `TOKEN_ENDPOINT_FORBIDDEN`** (the unmarked-route arm `docs/mcp.md` describes)? RG-10 accepts either and records which; the never-set test in S2 must assert the same one.
- **ASK-2** Is `pending_count` the caller's user-wide stale count computed AFTER the search-time refresh, and independent of the request's filters? RG-8's "16 → 0" reading depends on both; if it is filter-scoped the case needs a different query.
- **ASK-3** Which RSS figure FAILS SP-1 rather than merely being recorded? Evidence: ≈ 559 MB for the model, D-A4 expects ≈ 700 MB for the container. Proposal unless told otherwise: ⚠ above **900 MB**, ❌ above **1.2 GB** for the uvicorn worker after warm-up.

## Summary (run 2026-10-19, scope end, all 15 cases in one pass)

**Overall: ✅ READY FOR REVIEW.** Total 15 · **passed 14** · **⚠ 1** (RG-2, model ranking, not a code defect) · failed 0 · blocked 0. No server defect found; nothing was escalated mid-run.

| Case | Status | The number that proves it |
|---|---|---|
| SP-1 artifact loads in-process | ✅ (2 amendments) | `/health` 200 in 8 ms; stamp `…@614241f/model.onnx`; RSS 179 MB steady / 222 MB peak vs 38 MB for the embedder-less twin |
| SP-2 index fills, real vectors rank | ✅ | `embedded=16, pending=0` → `embedded=0`; 16 rows × 1536 B, 1 model, 16 hex-64 hashes, 0 transfers |
| SP-3 staleness repairs, delete cascades | ✅ | `embedded=2`; both hashes changed, model unchanged; embeddings 16 → 15 on DELETE with no refresh |
| RG-1 first HTTP search | ✅ | 200 in 45.7 ms, 15 hits 0.8687→0.7922, `candidates=15`, `pending_count=0` |
| RG-2 multilingual | ⚠ 5/6 | `аптека` and `car repair` hit both targets in the top 3; `prezenty dla bliskich` puts «Подарки и цветы» #4 by 0.007 |
| RG-3 server total | ✅ | RUB, income 300000, expense 400000, net −100000, `unconverted_count=1` — the hand-computation, exactly |
| RG-4 no-oracle | ✅ | foreign vs random id: **203 bytes, byte-identical**; neither user ever sees the other's row |
| RG-5 filters + honest empty | ✅ | category → exactly 3 pharmacies; `kind=transfer` → `items: []`, zero total, `candidates=0` |
| RG-6 refusals and bounds | ✅ | `SEARCH_QUERY_BLANK` string code; 422 on 501 chars / limit 0 / 51 / min_score 1.5; cut at 0.857 → the 3 rows above it |
| RG-7 add-edit-rename-delete loop | ✅ | new row rank 1 immediately, `embedded=1`; category rename → 3 gift rows at ranks 1-3 by the new name |
| RG-8 burst, bounded refresh | ✅ | `pending_count=16` then 0; `embedded=64 pending=16` then `embedded=16 pending=0`; candidates 79 → 95 |
| RG-9 both 503 arms | ✅ | `EMBEDDINGS_NOT_AVAILABLE` vs `AI_NOT_CONFIGURED` (LLM gate first); `GET /transactions` still 200 |
| RG-10 PAT + MCP | ✅ | 23 read tools, flat schema of 9 params; `/advisor/qa` with a PAT → **401** (the binding ruling) |
| RG-11 cited Q&A | ✅ | citations ⊆ retrieved, `dropped_citations=1` on the fabricated key, `retrieved_count=0` → null answer and **no** `llm call` line |
| RG-12 limiters | ✅ | 31st search → 429; 6th Q&A → 429; the PAT shares the user's 30/min search budget |

### Findings for senior-lead (none blocking)
1. **RG-2 ⚠ — one rank miss, 0.007.** `prezenty dla bliskich` ranks «Подарки и цветы» #4 behind an unrelated `Apteka Słoneczna` (0.8072 vs 0.8002). The bare `prezenty` of SP-2 ranks it #3, so the extra words dilute the query vector. This is multilingual-e5-small on a 15-row ledger, not a bug in our code — and it is the live confirmation of D-R3: the whole ranking spans 0.8687…0.7922, so a default `min_score` would have cut correct rows. No action proposed beyond keeping the no-threshold decision and the MCP wording that forbids filtering on the score.
2. **Three grooming expectations were wrong, the code is right** (corrected in place, each with evidence): (a) `items: []` for a hopeless query in RG-4/RG-5/RG-7 — semantic search has no default threshold and always ranks the caller's OWN rows; the no-oracle property proved instead is cross-user invisibility plus the byte-identical empty body. (b) "exactly one WARNING" for `EMBEDDINGS_PROVIDER=off` in SP-1/RG-9 — `off` is silent by design; the one-warning path is a MISSING artifact. (c) `q=зарплата&kind=income` → "the income row only" — the seed has two income rows.
3. **`docs/deploy.md` RAM figures.** The host process costs ≈ **140 MB** for the loaded artifact (179 MB with model vs 38 MB without), far from the ≈ 560–700 MB D-A4 assumed, because onnxruntime mmaps the int8 file. The amd64 container figure (S3) should be recorded beside this host one rather than replaced by it.
4. **`TRANSFER_FIELDS_REQUIRED` is also `counter_amount_minor`** — the seed recipe above omitted it and the first transfer POST answered 422. Corrected in `$SCRATCH/rag/seed.sh`; noted only so the next scope's seed does not repeat it.

### Gates (not re-run; read from the orchestrator's `scratchpad/api-gates.log`, 2026-10-19)
ruff ✅ · pyright ✅ · `alembic upgrade head` 0019 → 0020 then `alembic check` → "No new upgrade operations detected" ✅ · **pytest 862 passed** ✅ · evals replay ✅.

### Stand, data and cleanup
Both APIs were **already up** and were neither started nor stopped by me (orchestrator's instruction): 8021 `onnx`+`fake` PID 43503, 8022 `off`+`off` PID 43504, all four scheduler gates false, DB `budget_qa_rag` on 5443. Users `qa-rag-a@budgetqa.dev` / `qa-rag-b@budgetqa.dev` only — the concurrent web-qa users `qa-rag-web*` and every other row were untouched; no SQL INSERT/DELETE anywhere, reads only (`psql -tAc select …`). Owner DB `budget` untouched, its revision unmoved; ports 8010/5173/5433/8000/8081 untouched.
Cleanup (details and two corrections in «Cleanup» above): 96 + 2 transactions deleted through the API (204 each), embeddings cascaded to 0, PAT revoked, accounts archived — accounts/categories have no DELETE in the contract. `qa-rag-web`'s 134 rows verifiably untouched. **`budget_qa_rag` is LEFT in place — dropping it is the orchestrator's call**, as is dropping the two uvicorns (still up, 8021 PID 43503 / 8022 PID 43504).
`docker system df` at the end of the run: Images 24.52 GB (13.09 GB reclaimable), Containers 658.5 MB, Volumes 8.399 GB, Build cache 4.29 GB; `/` at **30 %** — well under the 85 % guard, nothing pruned.
