"""The embedding seam: the fake's ranking contract, the country table, the load gate.

Three things that can genuinely break and that nothing else would catch:

* the FAKE embedder's determinism and normalisation — every ranking assertion in
  this suite and every CI eval number is vacuous if it drifts;
* the committed ``country_names`` table — a truncated or re-generated table
  re-spells every passage that carries a country;
* ``OnnxEmbedder.load()`` refusing a corrupt artifact, and an app booted onto a
  missing one still answering ``/health`` — a missing model must never be a boot
  failure.

The load tests need NO 135 MB artifact: a three-byte ``model.onnx`` is already a
sha256 mismatch, which is the arm that matters.
"""

from pathlib import Path

import numpy as np
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient

from budget_api.app import create_app
from budget_api.config import Settings
from budget_api.domain.country_names import COUNTRY_NAMES, country_label
from budget_api.embeddings import (
    EmbedderLoadError,
    FakeEmbedder,
    OnnxEmbedder,
    model_stamp,
)
from budget_api.embeddings.manifest import load_manifest

_API_DIR = Path(__file__).parent.parent


class TestFakeEmbedder:
    def test_deterministic_unit_vectors_that_rank_by_shared_words(self) -> None:
        """Same text → same vector in any process, rows unit-norm, overlap ranks.

        ``sha1`` of each token, never ``hash()``: ``PYTHONHASHSEED`` is randomised
        per process, so a ``hash()``-bucketed fake would pass here and fail in the
        next process — taking every recorded eval fixture with it. Two SEPARATE
        instances stand in for that: nothing may be carried in instance state.
        """
        passages = [
            "Apteka Słoneczna | leki | expense | Poland (PL)",
            "Автосервис на Мира | expense | Russia (RU)",
        ]
        first = FakeEmbedder().embed(passages, kind="passage")
        second = FakeEmbedder().embed(passages, kind="query")

        # Determinism across instances AND across `kind` (the fake ignores it on
        # purpose: the query/passage asymmetry is a property of e5, not of us).
        assert np.array_equal(first, second)
        assert first.shape == (2, 384)
        assert first.dtype == np.float32
        assert np.allclose(np.linalg.norm(first, axis=1), 1.0)

        scores = first @ FakeEmbedder().embed(["apteka leki"], kind="query")[0]
        assert scores[0] > scores[1]
        # Not merely "higher": the unrelated row must share NOTHING, or a test
        # that asserts a ranking would be comparing two kinds of noise.
        assert scores[1] == 0.0


class TestCountryNames:
    def test_the_committed_table_is_whole_and_unknown_codes_stay_honest(self) -> None:
        """249 codes, three spot checks, and an unknown code → ``"(XX)"``.

        The table is GENERATED and committed (``scripts/gen_country_names.py``):
        this is the only thing standing between a truncated regeneration and a
        silent re-spelling of every passage that carries a country. The three
        codes are the ones the owner's ledger actually uses.
        """
        assert len(COUNTRY_NAMES) == 249
        assert country_label("PL") == "Poland (PL)"
        assert country_label("BY") == "Belarus (BY)"
        assert country_label("DE") == "Germany (DE)"
        # A free two-letter column may legally hold a code this table never heard
        # of; the passage still says which one it was.
        assert country_label("XX") == "(XX)"
        assert country_label(None) is None


class TestOnnxLoadGate:
    def test_a_corrupt_artifact_is_refused_by_name_and_builds_no_session(
        self, tmp_path: Path
    ) -> None:
        """A three-byte ``model.onnx`` → ``EmbedderLoadError`` naming that file.

        The whole point of shipping a manifest into the runtime image: the bytes
        are verified at boot, not assumed. A tampered tokenizer would otherwise
        produce plausible vectors from the wrong token ids — the failure nobody
        would notice.
        """
        manifest_path = _API_DIR / "model_manifest.json"
        manifest = load_manifest(manifest_path)
        for entry in manifest.files:
            (tmp_path / entry.local_name).write_bytes(b"not")

        embedder = OnnxEmbedder(tmp_path, manifest_path, threads=1)
        try:
            embedder.load()
        except EmbedderLoadError as exc:
            assert "model.onnx" in str(exc)
            assert "sha256 mismatch" in str(exc)
        else:  # pragma: no cover - the assertion below reports it
            raise AssertionError("a corrupt artifact must not load")

        # Nothing half-built: no stamp means no row can be written claiming this
        # model produced it (the DB CHECK ``model <> ''`` is the second net).
        assert embedder.model == ""

    def test_the_stamp_fits_the_model_column(self) -> None:
        """``…@614241f/model.onnx`` — 49 chars, inside ``String(64)`` (FLAG-1).

        The architecture's original spelling used the HF path (67 chars) and every
        insert would have failed the column. Pinned here because the manifest is
        editable and the column is not.
        """
        manifest = load_manifest(_API_DIR / "model_manifest.json")
        stamp = model_stamp(manifest, "model.onnx")

        assert stamp == "intfloat/multilingual-e5-small@614241f/model.onnx"
        assert len(stamp) <= 64

    async def test_a_missing_artifact_disables_search_but_never_boot(
        self, test_database_url: str, test_jwt_secret: str, tmp_path: Path
    ) -> None:
        """``EMBEDDINGS_PROVIDER=onnx`` with no model dir: 200 /health, embedder None.

        The ``provider_from_settings`` rule, one seam over: a box that has no
        artifact (or whose operator reclaimed the RAM) must serve every other
        route. If this ever regresses, a bad deploy takes the whole API down
        instead of one feature.
        """
        app = create_app(
            Settings(
                database_url=test_database_url,
                jwt_secret=test_jwt_secret,
                fx_scheduler_enabled=False,
                recurring_scheduler_enabled=False,
                push_scheduler_enabled=False,
                embeddings_scheduler_enabled=False,
                embeddings_provider="onnx",
                embeddings_model_dir=str(tmp_path / "absent"),
                embeddings_manifest_path=str(_API_DIR / "model_manifest.json"),
            )
        )

        async with LifespanManager(app):
            transport = ASGITransport(app=app)
            async with AsyncClient(
                transport=transport, base_url="http://test"
            ) as client:
                health = await client.get("/health")

            assert health.status_code == 200
            assert app.state.embedder is None
