# Implementation Plan (web): Credo (Georgia) — Excel statement support

## Approach
The contract does not move: the bank picker already renders whatever
`GET /statement-imports/formats` reports, so the whole web side is copy plus one
new pure module. Three pieces: (1) a name for the registry key `credo_xlsx_v1`
in `statementFormatLabel.ts` + both dictionaries — without it the picker offers a
bare identifier (the documented fallback, honest but ugly); (2) `.xlsx` added to
the file input's `accept` beside `.csv`; (3) `bankPhrases.ts` — the client-side
Georgian dictionary the grooming decided against putting in the DB.

`translateBankText(text, t)` follows the `periodicityLabel(template, t, locale)`
precedent: the module owns the MATCHING (exact phrase vs prefix vs nothing) and
returns dictionary keys resolved through the caller's bound `t`, so switching the
UI language re-renders the phrases with no cache or state involved. Two tables,
because the two positions behave differently: `EXACT` for the four Operation
values (a closed column — a partial match there would be a bug), `PREFIXES` for
description openings (`გადახდა`, `განაღდება`, `Currency Exchange`), where the
remainder is the merchant and the "spent" pair and must be copied through
BYTE-FOR-BYTE — we translate what the bank writes in Georgian, never the data.

The "untranslated" flag is derived in the same pass: whatever is left unresolved
still containing U+10A0–U+10FF means the dictionary is incomplete. Per task.md
("цена решения") that is a SIGNAL for the DB-table decision, so it renders as a
badge in the row's badge strip, not a tooltip.

## Screens / components affected
- `apps/web/src/features/imports/statementFormatLabel.ts` — one registry entry.
- `apps/web/src/features/imports/ImportUploadModal.tsx` — `accept` + `.xlsx`.
- `apps/web/src/features/imports/ImportRow.tsx` — Operation (`bank_category`) and
  Description through the helper; untranslated badge; aria-labels use the
  translated description.
- `apps/web/src/features/imports/ImportRowList.module.css` — badge style.
- `apps/web/src/i18n/dict.en.ts` / `dict.ru.ts` — format name, badge, seven bank
  phrases; CSV-only file copy widened to "CSV or Excel" (it would otherwise lie).

## New components / hooks
- `apps/web/src/features/imports/bankPhrases.ts` — `translateBankText`,
  `hasGeorgianScript`, the two phrase tables.
- `apps/web/src/features/imports/bankPhrases.test.ts` — four cases (exact,
  prefix + latin tail, unknown Georgian, no Georgian at all).

## Data layer
Untouched. No new endpoint, no new query key, no new invalidation: the format
list is already `['imports','formats']` with a 1h staleTime, and the rows family
is unchanged. `bank_category` and `description` are read from the RowRead that
already exists.

## UI states
- Bank picker: loading / error / empty-registry arms already exist; `credo_xlsx_v1`
  simply becomes a NAMED option instead of an id. A future unknown key still
  falls back to itself.
- Import row: unchanged loading/empty/error arms. New per-row state is
  `untranslated` — the original Georgian stays visible (never blanked) and gets a
  badge. Rows with no Georgian at all are untouched, so the Priorbank preview
  renders byte-identically.
- Language switch re-renders phrases immediately (no memo on language — `t` comes
  from context and the row memo compares props, not the dictionary).

## Open questions
- Merchant on `/transactions`: NOT routed through the helper. The i18n house rule
  (`docs/web.md`) lists merchants as never-translated user data, `rowTitle` is a
  language-free pure module whose signature would have to change, and the parser
  gives card rows a LATIN merchant anyway. Reported as a follow-up rather than
  done silently.

## Risks
- Prefix matching must not chop a longer Georgian word that merely starts with a
  known prefix → the match requires a non-Georgian boundary after the prefix.
- Over-eager translation of the tail would corrupt merchant names and amounts →
  the tail is concatenated verbatim, pinned by the prefix test.
- The badge is only as good as the dictionary; the real-file metric (how many of
  73 rows stay untranslated) is QA's, not this module's.

## Addendum (2026-08-28): `merchant` in the preview row

The backend added `StatementRowRead.merchant` (the shop name the parser isolated
from the description; `null` on every Priorbank row), and apply writes exactly
that name onto the transaction, falling back to the description. The preview
therefore shows it as the row's HEADLINE (`styles.merchant`, one new class plus a
`demoted` modifier in `ImportRowList.module.css`) with the bank's description kept
underneath, one step quieter — the description still carries the "spent" pair and
the bank's date, which are data, not a name. The same value becomes the first
candidate for `rowLabel`, so the decision group's and the category button's
aria-labels name the operation the way it will be saved instead of quoting a long
sentence. `merchant` is deliberately NOT passed through `translateBankText`: a
shop name is user data by the i18n house rule, and running it through the phrase
tables could only ever mark it as an untranslated gap the dictionary can never
close — the badge keeps meaning "the Operation/Description tables have a hole".
An empty-or-whitespace merchant is treated as absent, and with no merchant the row
renders byte-identically to before (Priorbank unaffected). No new dict keys, no
new query/data work, no test: the branch is a null check inside JSX, `apps/web`
has no DOM-test setup, and extracting it into a module just to assert it would be
a test for the sake of a test.
