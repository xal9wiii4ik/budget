"""The canonical text and its hash — the two things the whole index rests on.

The template IS the embedded document: editing it without bumping
``TEXT_VERSION`` would silently redefine every stored vector while leaving every
stored hash matching, so the sweep would never notice and search would rank
against text that no longer exists. These two tests are what make that a red
suite instead of a silent drift.
"""

import pytest

from budget_api.services import tx_text as tx_text_module
from budget_api.services.tx_text import MAX_NOTE_CHARS, TextFacts, text_hash, tx_text


def _facts(**overrides: object) -> TextFacts:
    base: dict[str, object] = {
        "merchant": "Biedronka",
        "note": "kawa i bułki",
        "category_name": "Продукты",
        "kind": "expense",
        "country": "PL",
        "account_name": "Карта BYN",
    }
    base.update(overrides)
    return TextFacts(**base)  # type: ignore[arg-type]


class TestTemplate:
    def test_the_three_pinned_shapes(self) -> None:
        """Full row, merchant-only row, unknown country — the document, verbatim.

        Field ORDER and the ``" | "`` joiner are both part of what gets embedded;
        empty parts are DROPPED rather than left as blanks, so a merchant-only row
        is one word and not five separators.
        """
        assert (
            tx_text(_facts())
            == "Biedronka | kawa i bułki | Продукты | expense | Poland (PL) | Карта BYN"
        )
        assert (
            tx_text(
                _facts(
                    merchant="Uber",
                    note=None,
                    category_name=None,
                    kind="",
                    country=None,
                    account_name=None,
                )
            )
            == "Uber"
        )
        # An unknown code is data, not an error: the passage says which code it
        # was and nothing more.
        assert "| (ZZ) |" in tx_text(_facts(country="ZZ"))

    def test_a_note_is_collapsed_and_cut(self) -> None:
        """Newlines/tabs become single spaces; the note stops at 300 characters.

        A pasted receipt in a note would otherwise dominate the document (and
        blow past the model's 128-token window) with whitespace the embedding
        cannot use anyway.
        """
        text = tx_text(
            _facts(merchant=None, note="  kawa\n\tz mlekiem   i cukrem  ", country=None)
        )
        assert text.startswith("kawa z mlekiem i cukrem | ")

        long_note = tx_text(_facts(merchant="M", note="x" * 400))
        assert "x" * MAX_NOTE_CHARS + " | " in long_note
        assert "x" * (MAX_NOTE_CHARS + 1) not in long_note


class TestHash:
    def test_the_version_is_inside_the_hash(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Bumping ``TEXT_VERSION`` re-hashes identical text — the reindex path.

        There is no reindex CLI and no second column: a version bump is the ONLY
        mechanism that re-embeds the world, and it works precisely because the
        version is hashed together with the text.
        """
        text = tx_text(_facts())
        before = text_hash(text)

        monkeypatch.setattr(tx_text_module, "TEXT_VERSION", "tx-text-v2")
        after = text_hash(text)

        assert before != after
        assert len(before) == 64 and before == before.lower()
