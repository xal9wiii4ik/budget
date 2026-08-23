"""Profile request/response schemas (S1) — the settings the app reads about a user.

The ``profiles`` row predates this scope by five roadmap stages and has never had
an HTTP surface: ``base_currency`` was written once by the register hook and read
by half the API. ``GET``/``PATCH /profile`` expose it, and since the
base-currency scope BOTH money-shaped fields are writable here (D1/D2):

- ``base_currency`` is a DISPLAY switch and nothing more. Stored base snapshots
  on transactions are NEVER recomputed: ``services/tx_totals`` already reads a
  post-switch row through its bucket order (a row whose ``currency`` equals the
  new base bypasses its stale snapshot), so aggregates stay honest and rows with
  no rate to the new base are counted as unconverted rather than silently
  mis-summed. Membership is checked against ``domain.money.SUPPORTED_CURRENCIES``
  in the router — an out-of-set base would be a screen the server has no rates
  for — and a wrong value answers the fixed ``CURRENCY_NOT_SUPPORTED`` code.
- ``monthly_income_minor`` is the user's DECLARED monthly income, the
  free-balance basis while there is no transaction history (D2). It carries no
  currency of its own: it is read in whatever base is stored, which is why a
  base SWITCH clears it server-side (plan Amendment A1) instead of
  re-denominating a number the user typed.

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

from budget_api.schemas.transaction import COUNTRY_PATTERN, MAX_MINOR_AMOUNT

#: Format only — the SET is enforced in the router (see the module docstring), so
#: an unsupported-but-well-formed code answers one string code instead of the
#: Pydantic array. Same literal as the ``base_currency_format`` DB CHECK.
_CURRENCY_PATTERN = r"^[A-Z]{3}$"

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
    #: NOT NULL in the DB: nullable HERE only so ``model_fields_set`` keeps its
    #: omit-vs-null meaning; the router refuses the explicit null with
    #: ``BASE_CURRENCY_REQUIRED`` (the GoalUpdate precedent). Deliberately not a
    #: ``Literal`` of the supported set: that would answer an HTTPValidationError
    #: array where the web expects the fixed ``CURRENCY_NOT_SUPPORTED`` code.
    base_currency: str | None = Field(default=None, pattern=_CURRENCY_PATTERN)
    #: Nullable for real — an explicit null CLEARS the declared income (the
    #: country/language house rule). ``ge=0`` mirrors the
    #: ``monthly_income_minor_non_negative`` CHECK so a negative is a 422 and not
    #: an IntegrityError 500; ``le`` is the app-wide D14 magnitude bound.
    monthly_income_minor: int | None = Field(default=None, ge=0, le=MAX_MINOR_AMOUNT)


class ProfileError(BaseModel):
    """422 error envelope — mirrors ``GoalError``/``TransactionError``."""

    detail: str
