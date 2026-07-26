"""Merchant-name normalization (architecture D4).

Pure, stdlib-only. Single call site for both the S4 learning write and the S3
suggestion read, so the exact same normalized key is stored and looked up.
"""

import unicodedata


def normalize_merchant(raw: str) -> str:
    """Normalize a raw merchant string to its lookup/storage key.

    NFC-normalize, casefold, strip, and collapse internal whitespace. An empty
    result (``""``) means "no merchant" — callers treat it as no map key.
    """
    s = unicodedata.normalize("NFC", raw).casefold().strip()
    return " ".join(s.split())
