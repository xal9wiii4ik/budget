"""The one error every provider raises, carrying one of six codes.

ONE exception class with a string code rather than a class per failure: every
caller branches on "may I retry / must I stop / did I lose only this batch", and
that is a property of the code, not of a type hierarchy (the ``ReceiptParseError``
precedent in ``services/receipt_parser.py``).

The six codes:

* ``unavailable`` — connect error, timeout, 429, 5xx, 529. The only RETRYABLE one;
  it also aborts a categorize pass (a dead provider must not be hammered).
* ``request_rejected`` — any other 4xx: a bad key, a schema the API refuses. Not
  retryable, logged WARNING, aborts the pass.
* ``invalid_output`` — the answer was not the JSON document it had to be. Costs
  the caller that batch and nothing else.
* ``truncated`` — the model hit ``max_tokens``. Same blast radius as above.
* ``unsupported`` — the request uses a shape this provider does not implement: a
  ``tool_choice`` spelling outside the grammar, or a data document the fake has no
  arm for. A programming error, surfaced rather than ignored.
* ``replay_miss`` — replay mode only: the store has no answer for this request.
  Loud on purpose (evals), see ``fake.FakeProvider``.

"Not configured" is deliberately NOT here: ``registry.build_provider`` returns
``None`` and the caller reads that as "no AI on this server".
"""

#: Codes a caller may retry as-is. Everything else is a fact about the request.
RETRYABLE_CODES = frozenset({"unavailable"})

#: Every code this layer can raise — the module docstring is the explanation.
ERROR_CODES = frozenset(
    {
        "unavailable",
        "request_rejected",
        "invalid_output",
        "truncated",
        "unsupported",
        "replay_miss",
    }
)


class LLMError(Exception):
    """Carries one of :data:`ERROR_CODES`; ``retryable`` is derived, never passed."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)

    @property
    def retryable(self) -> bool:
        return self.code in RETRYABLE_CODES
