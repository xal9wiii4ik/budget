# Grooming review — rag (senior-lead, 2026-10-19)

Team: architect (new table, new `embeddings/` seam, new dependency + build artifact, contract, MCP) → backend-engineer (plan.md)
∥ frontend-engineer (plan-web.md) ∥ qa-engineer (qa-checklist.md) ∥ web-qa (qa-web-checklist.md). Mobile frozen — no mobile agents.
Artifacts: `evidence.md` (my measurements), `architecture.md` (+ amendments A1–A7), the four plans/checklists.

## Rulings on the backend plan's flags (all binding)
- FLAG-1 ACCEPTED: `Embedder.model` stamp = `intfloat/multilingual-e5-small@614241f/model.onnx` (local name, 49 chars). qa-checklist SP-1 is corrected to this stamp.
- FLAG-2 ACCEPTED: discovery = (priority, rest); the time budget bounds the scan, the row cap bounds embedding. `last_swept_at` recorded, not built.
- FLAG-3 ACCEPTED: `tx_totals.NOT_TRANSFER_OR_DEBT` public; one definition of the money population.
- FLAG-4 ACCEPTED: manifest copied into the runtime image; `embeddings_manifest_path` setting.
- FLAG-5 ACCEPTED: conftest `setdefault`s, no fourth factory.
- Open Q1 (`min_score` 0..1): keep the honest range; the tool description names the band.
- Open Q2 (blank question): keep as planned — `SEARCH_QUERY_BLANK` on the GET (a query param cannot carry a pydantic strip rule), pydantic 422 on the POST body (the `AdvisorAsk` precedent).
- S2 test 13 / architecture Test seams 4: `POST /advisor/qa` is JWT-only through the shared `stash_rl_user` exactly like `/advisor/ask` (an AI-spend route): a PAT bearer answers **401** (the JWT dependency rejects it). `NEVER_PAT` +1 pins only "in the contract, never in the allowlist". (My earlier 403 ruling cited `/transactions/export`, which is a PAT-AWARE unmarked route — wrong precedent; the S2 engineer's PAT-aware local stash is REVERTED to the shared JWT-only one.)

## Rulings on the web plan's asks (→ backend, binding)
- ASK-1 `limit` on both routes, 1..50, default 20: CONFIRMED (A6).
- ASK-2 one hit schema `TransactionSearchHit` in both responses: CONFIRMED.
- ASK-3 Q&A `total` = over the RETRIEVED set, `currency` = profile base: CONFIRMED. The web labels it "по найденным операциям" in both places; the Q&A renders it even when the answer quotes a figure — the server's number is the only sum the user may trust.
- ASK-4 RULE: `answer: null` ⇔ `retrieved_count == 0` (no LLM call). A NON-null answer with ZERO citations IS reachable (the model answered without relying on any row, e.g. "these operations say nothing about that") and is NOT an error: render the answer, the citations heading reads "0 из N найденных" and the total still shows. The web must not treat it as the nothing-found arm.
- ASK-5 all three 503 codes on `/advisor/qa`'s responses: CONFIRMED (`AI_NOT_CONFIGURED`, `AI_UNAVAILABLE`, `EMBEDDINGS_NOT_AVAILABLE`), plus 422 `QA_FAILED`, 429.
- ASK-6 `pending_count` = the CALLER's user-wide stale count, computed AFTER the search-time refresh, independent of filters (same answer to qa ASK-2). Web sentence: "N недавних операций ещё индексируются и могли не попасть в результаты".
- ASK-7 (a capability boolean on an existing read): DECLINED for v1 — the 503 is authoritative, the toggle is never pre-disabled.
- ASK-8 sequencing: CONFIRMED — A1 now, A2 after the S2 regen; shim deletion is a gate.
- Placement: Q&A section BELOW the streaming chat on /advisor — ACCEPTED. Citation → `txWindowHref` one-day account window — ACCEPTED (A5 allows the deep link; the row is visible and editable there). No component tests (node-only vitest) — ACCEPTED, pure modules carry the logic.

## Rulings on the QA asks
- qa ASK-1: 401 (above). ASK-2: yes, user-wide, post-refresh, filter-independent. ASK-3: RSS of the uvicorn worker after warm-up + one 32-batch: ⚠ above 900 MB, ❌ above 1.2 GB — ACCEPTED as the SP-1 failing numbers. The `country=AQ` isolation trick for the money buckets: ACCEPTED. Markers ride with a theme word: ACCEPTED.
- web-qa Q-1: mode + q live in the URL (`?mode=meaning`), F5 repeats the search. Q-2: toggle stays, 503 is caught with text copy, never pre-disabled. Q-3: 2-dp number "близость 0,83" per row + ONE relative-score note per list; no percent, no bar; a single result shows the same badge. Q-4: the server total REPLACES the month summary; meaning mode counts as narrowed (widgets hidden); Q&A shows the total too. Q-5: skeleton + `role="status"` while pending; leaving /advisor loses the Q&A answer (v1, no history — D-Q2). Q-6: the pending line shows whenever > 0 (honest; the prod sweep clears it within 5 min). Q-7: deep link (above). Q-8: `limit` 20, one "показать больше" → 50, the header says it is the top N.

## Tiers
| Subtask | Tier | Why |
|---|---|---|
| S1 embeddings seam + artifact + migration 0020 + index | FULL | new dependency + build artifact, migration, scheduler |
| S2 search + total + MCP + Q&A + contract | FULL | money math, contract change, MCP exposure, LLM integration |
| S3 evals + docs | STANDARD | self-review via /review-pr |
| Web A (A1 + A2) | STANDARD | self-review via /review-pr |

## Schedule (wall-clock policy)
Wave 1: S1 ∥ Web A1. Wave 2: S2 (after S1) — then `pnpm openapi`. Wave 3: S3 ∥ Web A2 ∥ code-reviewer over S1+S2. Then ONE live QA run (qa-engineer + web-qa) at scope end on the A3 stand; S1 gets the three STOP-probes (SP-1..3) at its diff gate since the real ONNX artifact is the scope's first integration boundary. Only the backend line runs pytest; the web line never touches the test DB.

## Estimates (agent-minutes: write / gates / verification)
S1 110/30/25 · S2 120/30/25 · S3 70/20/25 · Web A 135/15/20 · QA run ~45 + one fix circle if a functional defect lands.

## Post-wave-1 rulings
- Web deviation 4 (TC-12): a 429 on the Q&A REPLACES the previous answer with the error arm — query-core clears `mutation.data` on `pending`, and a local copy would be a second source of truth. TC-12's expectation is amended: the previous answer is gone, the 429 copy is shown, the field keeps the question.
- S1 review (`review-s1.md`): MAJOR-1 ACCEPTED (log `type(exc.orig).__name__`, count the rolled-back batch into `pending`); MINOR-2/3/4/6 ACCEPTED; MINOR-5 docs → S3 in-pass; NITs: fix the false `types.py` claim, keep the stamp pin.
- S2 deviation (PAT-aware stash on `/advisor/qa`): REVERTED to JWT-only `stash_rl_user` + 401 (above).
- SP-1 on the amd64 image (`budget-api:rag-amd64`, 595 MB vs 311 MB): boot → `/health` 200 in ~24 s under emulation, model stamp logged, zero WARNINGs; RSS numbers in `docs/deploy.md` (S3).
