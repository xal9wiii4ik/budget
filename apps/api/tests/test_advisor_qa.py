"""``POST /advisor/qa``: citations that resolve, and the four refusal arms.

The product claim this file guards is narrow and concrete: *every citation on
screen is a real operation of this user that this request actually retrieved*.
Everything else here is about not spending a model call — on a question with
nothing to answer from, on an unconfigured server, or on a token that must never
reach this route at all.

The fake provider cites by word overlap and is deliberately NOT an oracle: what
is asserted is where its keys END UP, never which ones it chose.
"""

from collections.abc import Awaitable, Callable
from typing import Any

from helpers import create_account
from httpx import AsyncClient

from budget_api.llm import (
    FAIL_MARKER,
    QA_CITE_FOREIGN,
    FakeProvider,
    LLMRequest,
    LLMResponse,
    TextBlock,
    Usage,
)
from budget_api.services.advisor_qa import PROMPT_FINGERPRINTS, prompt_fingerprint

PASSWORD = "password123"

MakeLlmClient = Callable[..., Awaitable[AsyncClient]]


class CountingProvider:
    """``FakeProvider("fake")`` plus how many calls it was asked to make.

    The only way to prove a refusal happened BEFORE the model: a null answer
    with zero citations looks identical on the wire whether or not a question
    was paid for, and "nothing retrieved means nothing is spent" is the claim.
    """

    def __init__(self) -> None:
        self._inner = FakeProvider("fake")
        self.name = self._inner.name
        self.model = self._inner.model
        self.calls = 0

    async def complete(self, request: LLMRequest) -> LLMResponse:
        self.calls += 1
        return await self._inner.complete(request)


class BlankAnswerProvider:
    """A provider whose answer carries no prose — the one cause of 422 QA_FAILED.

    A real provider that returns ``{"answer": ""}`` (or any shape the verifier
    refuses) is the only way into that arm, and the fake cannot produce it: it
    always has words to echo. Six lines of stub are cheaper than a reachable
    production arm nobody has ever executed.
    """

    name = "stub"
    model = "stub"

    async def complete(self, request: LLMRequest) -> LLMResponse:
        return LLMResponse(
            blocks=(TextBlock('{"answer":"  ","citations":[]}'),),
            stop_reason="end_turn",
            usage=Usage(
                provider=self.name,
                model=self.model,
                input_tokens=0,
                output_tokens=0,
                cache_read_tokens=0,
                latency_ms=0,
                estimated_cost_usd=None,
            ),
        )


async def _register_and_login(client: AsyncClient, email: str) -> dict[str, str]:
    reg = await client.post(
        "/auth/register", json={"email": email, "password": PASSWORD}
    )
    assert reg.status_code == 201, reg.text
    login = await client.post(
        "/auth/login", data={"username": email, "password": PASSWORD}
    )
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


async def _create_tx(
    client: AsyncClient, headers: dict[str, str], **body: Any
) -> dict[str, Any]:
    body.setdefault("amount_minor", 1000)
    body.setdefault("kind", "expense")
    body.setdefault("occurred_at", "2026-03-15")
    resp = await client.post("/transactions", json=body, headers=headers)
    assert resp.status_code == 201, resp.text
    created: dict[str, Any] = resp.json()
    return created


async def _seed(client: AsyncClient, headers: dict[str, str]) -> list[str]:
    """Two pharmacy rows and one unrelated one — ids in creation order."""
    account = (await create_account(client, headers))["id"]
    rows = [
        await _create_tx(client, headers, merchant="Apteka Gemini", account_id=account),
        await _create_tx(client, headers, merchant="Apteka Dbam", account_id=account),
        await _create_tx(client, headers, merchant="Uber", account_id=account),
    ]
    return [row["id"] for row in rows]


class TestCitations:
    async def test_every_citation_is_an_operation_this_request_retrieved(
        self, make_llm_client: MakeLlmClient
    ) -> None:
        """The product claim: an answer's links point at real, own operations.

        The verifier maps the model's short keys back to the hits the SERVER
        retrieved, so the assertion is on membership and on ownership — every
        cited transaction id is one of the ids this user created, and the
        citation count never exceeds what was retrieved.
        """
        client = await make_llm_client(FakeProvider("fake"))
        headers = await _register_and_login(client, "qa-cite@x.com")
        own = set(await _seed(client, headers))

        resp = await client.post(
            "/advisor/qa",
            json={"question": "сколько я потратил в apteka?"},
            headers=headers,
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        cited = [item["transaction"]["id"] for item in body["citations"]]
        assert cited, "the fake cites by word overlap; 'apteka' must match"
        assert set(cited) <= own
        assert len(cited) <= body["retrieved_count"] == 3
        assert body["dropped_citations"] == 0
        assert body["answer"] is not None
        assert body["prompt_version"] == "qa-v1"
        # ASK-3: the total is over everything RETRIEVED, not over what was cited.
        assert body["total"]["expense_minor"] == 3_000

    async def test_a_citation_the_server_never_retrieved_is_dropped_and_counted(
        self, make_llm_client: MakeLlmClient
    ) -> None:
        """``QA_CITE_FOREIGN`` → one dropped reference, nothing extra on screen.

        The verifier is the only thing between an invented operation id and a
        clickable link in the user's answer. The real schema's enum makes that
        arm unreachable from a well-behaved provider, which is exactly why the
        fake has a marker for it.
        """
        client = await make_llm_client(FakeProvider("fake"))
        headers = await _register_and_login(client, "qa-foreign@x.com")
        own = set(await _seed(client, headers))

        resp = await client.post(
            "/advisor/qa",
            json={"question": f"apteka {QA_CITE_FOREIGN}"},
            headers=headers,
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["dropped_citations"] == 1
        assert {item["transaction"]["id"] for item in body["citations"]} <= own

    async def test_nothing_retrieved_costs_no_model_call(
        self, make_llm_client: MakeLlmClient
    ) -> None:
        """Zero hits → ``answer: null``, no citations, provider never called.

        ``answer: null`` ⇔ ``retrieved_count == 0`` is a BINDING rule (ruling
        ASK-4): it is the one arm the web renders as "nothing found", and a
        server that answered prose here would make a non-null answer with zero
        citations — a legal outcome — indistinguishable from it.
        """
        provider = CountingProvider()
        client = await make_llm_client(provider)
        headers = await _register_and_login(client, "qa-empty@x.com")

        resp = await client.post(
            "/advisor/qa", json={"question": "на что я трачу?"}, headers=headers
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["answer"] is None
        assert body["citations"] == []
        assert body["retrieved_count"] == 0
        assert body["total"]["net_minor"] == 0
        assert provider.calls == 0


class TestRefusals:
    async def test_a_broken_provider_is_503_and_a_token_never_gets_in(
        self,
        make_llm_client: MakeLlmClient,
        pat_factory: Callable[..., Awaitable[dict[str, Any]]],
    ) -> None:
        """Three refusals, three different answers, in their declared order.

        A provider outage is 503 AI_UNAVAILABLE (the question is fine, the
        service is not — a 422 would send the user rewriting a good question).
        A PAT is 401, not the allowlist's 403: this is an AI-spend route and it
        resolves its user through the same JWT-only dependency ``/advisor/ask``
        does, so a ``bgt_pat_`` bearer dies at the decode and never reaches the
        allowlist (the ``POST /receipts/{id}/parse`` precedent). That is the
        stronger refusal of the two, and it holds even if a future edit marked
        the route PAT-reachable; ``NEVER_PAT`` pins only "in the contract, never
        in the allowlist".
        """
        client = await make_llm_client(FakeProvider("fake"))
        headers = await _register_and_login(client, "qa-fail@x.com")
        await _seed(client, headers)
        token = (await pat_factory(client, headers, "read"))["token"]

        broken = await client.post(
            "/advisor/qa",
            json={"question": f"apteka {FAIL_MARKER}"},
            headers=headers,
        )
        with_token = await client.post(
            "/advisor/qa",
            json={"question": "apteka"},
            headers={"Authorization": f"Bearer {token}"},
        )

        assert broken.status_code == 503, broken.text
        assert broken.json() == {"detail": "AI_UNAVAILABLE"}
        assert with_token.status_code == 401, with_token.text

    async def test_an_unusable_answer_is_422_and_not_a_503(
        self, make_llm_client: MakeLlmClient
    ) -> None:
        """A blank answer → 422 ``QA_FAILED``, the retryable half of the split.

        The provider worked; what came back is unusable, so the user is told to
        try again rather than being told the AI is down (the 503 arm above). The
        split is the whole reason ``_UNAVAILABLE_CODES`` exists, and this is its
        other side.
        """
        client = await make_llm_client(BlankAnswerProvider())
        headers = await _register_and_login(client, "qa-blank@x.com")
        await _seed(client, headers)

        resp = await client.post(
            "/advisor/qa", json={"question": "apteka"}, headers=headers
        )

        assert resp.status_code == 422, resp.text
        assert resp.json() == {"detail": "QA_FAILED"}

    async def test_the_ai_gate_answers_before_the_embedder_gate(
        self, make_llm_client: MakeLlmClient
    ) -> None:
        """No provider AND no model → ``AI_NOT_CONFIGURED``, never the other one.

        Both gates are 503 and both are true here, so the ORDER in the handler
        signature is the whole behaviour: the web already has copy for "the AI
        is not configured", and that is the actionable one — an operator who
        sets a key still has to deal with the model, but in the other order they
        would never be told about the key at all.
        """
        client = await make_llm_client(None, embeddings_provider="off")
        headers = await _register_and_login(client, "qa-nogates@x.com")

        resp = await client.post(
            "/advisor/qa", json={"question": "apteka"}, headers=headers
        )

        assert resp.status_code == 503, resp.text
        assert resp.json() == {"detail": "AI_NOT_CONFIGURED"}


class TestPrompt:
    def test_the_qa_v1_fingerprint_is_pinned(self) -> None:
        """Editing the prompt or the schema without bumping the version fails here.

        The fingerprint covers the system text AND the response schema, which
        between them define every recorded replay fixture and every eval number
        produced under ``qa-v1``.
        """
        assert PROMPT_FINGERPRINTS["qa-v1"] == prompt_fingerprint()
