"""The search index: one row per indexed transaction, written by nobody's write path.

Indexing is PULL (rag architecture D-I1). No writer — not the transactions
router, not ``apply.py``, not the materializer, not psql — ever touches this
table: a row here is CURRENT if and only if it exists with the live embedder's
``model`` stamp and the current ``text_hash`` of the row it mirrors, and
``services/tx_index.py`` repairs whatever is not. That is what makes a category
rename, an edited merchant and a ``TEXT_VERSION`` bump all one mechanism, and
what guarantees a write can never be slowed or failed by the model.

A DELETE needs no mechanism at all: ``transaction_id`` is the PK AND an
``ON DELETE CASCADE`` FK, so a deleted transaction takes its vector with it.

``user_id`` is denormalised on purpose: the per-user staleness scan and the
search candidate query both filter by it, and joining ``transactions`` just to
learn whose row this is would be a join per scan.

``vector`` is 384 float32 LITTLE-ENDIAN bytes — 1536 of them, guarded by a
CHECK. Plain BYTEA, not pgvector (D-S1): a full cosine scan over 20 000 rows is
0.56 ms of numpy, and pgvector would cost an image swap in dev, CI and prod for
no measurable gain at this size.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    LargeBinary,
    String,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from budget_api.models.base import Base


class TransactionEmbedding(Base):
    __tablename__ = "transaction_embeddings"
    __table_args__ = (
        # 384 float32 = 1536 bytes. The ONE guard against a dim or dtype change
        # reaching the table: a float64 array is 3072 bytes and would be refused
        # loudly here instead of scoring nonsense against float32 neighbours.
        CheckConstraint("octet_length(vector) = 1536", name="vector_dim"),
        # Lowercase hex, exactly 64 — what ``hashlib.sha256().hexdigest()``
        # produces. Anything else means something other than ``tx_text.text_hash``
        # wrote this row.
        CheckConstraint("text_hash ~ '^[0-9a-f]{64}$'", name="text_hash_format"),
        # An empty stamp would make every row look current to an embedder whose
        # ``model`` is empty — which is exactly the state of an OnnxEmbedder that
        # failed to load.
        CheckConstraint("model <> ''", name="model_present"),
    )

    #: PK *and* FK: one vector per transaction, gone when the transaction is.
    transaction_id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        ForeignKey("transactions.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    #: The artifact that produced ``vector`` (``Embedder.model``). A mismatch with
    #: the live embedder's stamp makes the row stale — which is how swapping the
    #: model invalidates the index without a migration or a flag day.
    model: Mapped[str] = mapped_column(String(64))
    #: ``tx_text.text_hash`` of the document this vector was made from.
    text_hash: Mapped[str] = mapped_column(String(64))
    vector: Mapped[bytes] = mapped_column(LargeBinary)
    embedded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
