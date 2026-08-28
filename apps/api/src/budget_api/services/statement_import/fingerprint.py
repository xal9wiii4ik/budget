"""Deterministic row fingerprints — the idempotency of the whole scope (§3).

Every parsed row gets a ``client_id`` derived from what the row SAYS, so
re-uploading an overlapping period produces the same ids, and the transactions
router's existing B-1 replay mechanics (select-first + the partial unique index on
``(user_id, client_id)``) make a second import of the same operation impossible by
CONSTRUCTION rather than by the matcher getting lucky.

Two decisions carry the whole design:

* ``occ_index`` counts identical rows WITHIN THE FILE, not their line numbers. A
  global line number would change when the periods overlap differently, breaking
  idempotency exactly when it is needed; no index at all would collapse two
  genuinely identical payments (four ``PAYBYCARD.BY -1,15`` lines in the real
  file) into one.
* The version tag is a VERSION of the canonical string, and it is a property of
  the FORMAT, not of this module: ``prior:v1`` describes what a Priorbank row's
  canonical looks like and nothing else. Any parser fix that changes its own
  canonical must bump its own tag deliberately — a silent change would re-import
  that user's whole history as "new" — and a second bank must never be able to
  move the first one's ids by being added.
"""

import uuid
from collections import defaultdict
from collections.abc import Mapping, Sequence

from budget_api.services.statement_import import credo, priorbank
from budget_api.services.statement_import.types import ParsedRow

#: Frozen namespace for uuid5. A literal, exactly like the seed categories' ids:
#: it is part of the contract of every id already stored on a transaction.
NS_STATEMENT_IMPORT = uuid.UUID("7f3d1f0e-5a52-4c9e-9a2f-6b1c0d4e8a37")

#: Version tag of the canonical string below, PER FORMAT (architecture §3).
#:
#: Every value here is FROZEN: it is baked into the ``client_id`` of every
#: transaction that format has already created, so changing one re-imports that
#: user's whole history as new. A new bank gets a new tag; it never joins an
#: existing one, even when its canonical happens to look the same.
#:
#: Every key of ``PARSERS`` must appear here — a parser without a tag would fail
#: an upload with a KeyError instead of a refusal (pinned by the test suite).
FINGERPRINT_VERSIONS: Mapping[str, str] = {
    priorbank.FORMAT_ID: "prior:v1",
    credo.FORMAT_ID: "credo:v1",
}

_SEP = "|"


def _canonical(
    user_id: uuid.UUID,
    account_id: uuid.UUID,
    row: ParsedRow,
    occ_index: int,
    version: str,
) -> str:
    """The exact string §3 specifies, with ``occ_index`` appended last.

    ONE canonical for every format — the fields are the same facts about a row
    whatever file it came from, and only the version tag says which format's
    spelling of them this is.
    """
    return _SEP.join(
        (
            str(user_id),
            str(account_id),
            version,
            row.section,
            row.txn_date.isoformat(),
            row.txn_time.isoformat() if row.txn_time is not None else "",
            row.booked_date.isoformat(),
            str(row.signed_amount_minor),
            (
                f"{row.original_amount_minor}{_SEP}{row.original_currency}"
                if row.original_amount_minor is not None
                else ""
            ),
            row.description.strip(),
            row.bank_category or "",
            str(occ_index),
        )
    )


def client_ids(
    user_id: uuid.UUID,
    account_id: uuid.UUID,
    rows: Sequence[ParsedRow],
    source_format: str,
) -> list[uuid.UUID]:
    """One deterministic uuid per row, positionally aligned with ``rows``.

    Rows are counted in FILE order, so the first of two byte-identical payments
    always gets ``occ_index`` 0 and the second always 1 — which is what makes the
    two ids stable across uploads instead of depending on which one came back
    first from anywhere.

    ``source_format`` selects the canonical's version tag, so two banks that print
    the same line on the same day still produce two ids — and so a change to one
    format's canonical can never move the other's.
    """
    version = FINGERPRINT_VERSIONS.get(source_format)
    if version is None:
        raise ValueError(f"no fingerprint version for format {source_format!r}")
    seen: defaultdict[str, int] = defaultdict(int)
    ids: list[uuid.UUID] = []
    for row in rows:
        # The key is the canonical WITHOUT the index (spelled as index 0), so the
        # counter answers "how many identical rows came before this one".
        key = _canonical(user_id, account_id, row, 0, version)
        occ_index = seen[key]
        seen[key] += 1
        canonical = _canonical(user_id, account_id, row, occ_index, version)
        ids.append(uuid.uuid5(NS_STATEMENT_IMPORT, canonical))
    return ids
