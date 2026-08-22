"""Profile request/response schemas (S1) — the settings the app reads about a user.

The ``profiles`` row predates this scope by five roadmap stages and has never had
an HTTP surface: ``base_currency`` was written once by the register hook and read
by half the API. ``GET``/``PATCH /profile`` finally expose it, and deliberately
expose it READ-mostly — ``base_currency`` is absent from :class:`ProfileUpdate`
because changing it retroactively redefines every stored base-currency snapshot,
which is its own scope.

``country`` is FORMAT-validated and never normalized (``COUNTRY_PATTERN``, shared
with the transaction schemas). ``language`` is an ENUMERATION rather than a
format: the app ships exactly two UI languages, and a well-formed-but-unsupported
code would render as untranslated keys instead of falling back gracefully. Both
are nullable with no default — NULL means "not confirmed yet", which is what the
first-run locale prompt keys off, and a default would erase the difference
between a choice and an absence.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from budget_api.schemas.transaction import COUNTRY_PATTERN

#: The two UI languages the app ships. Twin of the ``ck_profiles_language_valid``
#: CHECK — edited together, exactly like the currency-exponent tables.
Language = Literal["ru", "en"]


class ProfileRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    #: Never null on the wire: a user without a ``profiles`` row reads as the
    #: server default rather than as a null the client would have to interpret.
    base_currency: str
    monthly_income_minor: int | None
    country: str | None
    language: Language | None


class ProfileUpdate(BaseModel):
    # All optional; omitted vs explicit-null is distinguished by the router via
    # model_fields_set, and both fields are nullable columns, so an explicit null
    # CLEARS (the note/category_id house rule) — "I no longer want a pinned
    # language" is a real edit, not an error.
    country: str | None = Field(default=None, pattern=COUNTRY_PATTERN)
    language: Language | None = None
