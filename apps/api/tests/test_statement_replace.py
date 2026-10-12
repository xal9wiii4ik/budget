"""The replace path — the one place this scope DELETES the user's transactions.

Two routes, one destructive: ``GET /{id}/replace-preview`` promises what will die,
``POST /{id}/replace`` kills it and re-files the statement over the emptied range.
Everything here is about the cost of getting the SELECTION wrong — a filter that
reaches one day too far, one account too wide or across a transfer costs data no
user can reconstruct — and about the confirmation that stands between the preview
and the deletion.

The insertion core is S2's and is covered in ``test_statement_apply.py``; only what
replace does differently (which rows, and what is destroyed first) is asserted.
"""

import uuid
from datetime import date
from typing import Any

import pytest
from helpers import create_account
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from budget_api.models import Receipt, Transaction
from budget_api.services.statement_import.apply import (
    StatementApplyError,
    replace_import,
)

PASSWORD = "password123"
FORMAT = "priorbank_csv_v1"
#: The synthetic fixture's own header period. The replaced range is a slice of it.
PERIOD_TO = "2026-06-30"
#: The date every test replaces from: inside the period, with rows and seeded
#: transactions on BOTH sides of it.
FROM = "2026-06-10"
#: The fixture's 13.06 refund, 2000.00 BYN — the one row a test moves out of the
#: period, addressed by its amount so the file's Cyrillic wording stays in the file.
_REFUND_MINOR = 200_000


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


async def _byn_account(
    client: AsyncClient, headers: dict[str, str], name: str = "Card BYN"
) -> str:
    account = await create_account(client, headers, currency="BYN", name=name)
    return str(account["id"])


async def _upload(
    client: AsyncClient, headers: dict[str, str], account_id: str, data: bytes
) -> str:
    resp = await client.post(
        "/statement-imports",
        files={"file": ("Vpsk.csv", data, "text/csv")},
        data={"account_id": account_id, "format": FORMAT},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["period_to"] == PERIOD_TO
    return str(resp.json()["id"])


async def _create_tx(
    client: AsyncClient,
    headers: dict[str, str],
    account_id: str,
    occurred_at: str,
    amount_minor: int,
    **body: Any,
) -> str:
    resp = await client.post(
        "/transactions",
        json={
            "account_id": account_id,
            "amount_minor": amount_minor,
            "kind": "expense",
            "occurred_at": occurred_at,
            **body,
        },
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


async def _transactions(
    client: AsyncClient, headers: dict[str, str], account_id: str
) -> list[dict[str, Any]]:
    listed = await client.get(
        "/transactions", params={"account_id": account_id}, headers=headers
    )
    assert listed.status_code == 200, listed.text
    items: list[dict[str, Any]] = listed.json()["items"]
    return items


async def _preview(
    client: AsyncClient, headers: dict[str, str], import_id: str, from_date: str = FROM
) -> Any:
    return await client.get(
        f"/statement-imports/{import_id}/replace-preview",
        params={"from": from_date},
        headers=headers,
    )


async def _replace(
    client: AsyncClient,
    headers: dict[str, str],
    import_id: str,
    confirm_deleted_total: int,
    from_date: str = FROM,
) -> Any:
    return await client.post(
        f"/statement-imports/{import_id}/replace",
        json={
            "from_date": from_date,
            "confirm_deleted_total": confirm_deleted_total,
        },
        headers=headers,
    )


async def _seed_range(
    client: AsyncClient,
    db_session: AsyncSession,
    headers: dict[str, str],
    account_id: str,
    other_account_id: str,
) -> dict[str, str]:
    """A June the replace has to cut EXACTLY: five doomed rows and five survivors.

    Every seeded amount is unlike every amount in the fixture, so nothing here can
    become a match candidate — this is about the date/account/kind selection and
    nothing else.

    The three link counters are seeded with DIFFERENT totals (two receipts, one
    plan payment, one recurring attribution) so that a preview which counted the
    same column twice could not pass.
    """
    receipt = Receipt(
        user_id=uuid.UUID(
            (await client.get("/users/me", headers=headers)).json()["id"]
        ),
        storage_path="receipts/seed.jpg",
        status="parsed",
    )
    db_session.add(receipt)
    await db_session.commit()

    goal = await client.post(
        "/goals",
        json={"name": "trip", "target_minor": 1_000_000, "currency": "BYN"},
        headers=headers,
    )
    assert goal.status_code == 201, goal.text
    item = await client.post(
        f"/goals/{goal.json()['id']}/items", json={"name": "tickets"}, headers=headers
    )
    assert item.status_code == 201, item.text
    template = await client.post(
        "/recurring",
        json={
            "name": "Netflix",
            "amount_minor": 10_000,
            "kind": "expense",
            "interval_unit": "month",
            "day_of_month": 15,
            "account_id": account_id,
        },
        headers=headers,
    )
    assert template.status_code == 201, template.text

    seeded = {
        # One day BEFORE the replaced range starts — the boundary that must live.
        "before": await _create_tx(client, headers, account_id, "2026-06-09", 1000),
        "on_from": await _create_tx(
            client, headers, account_id, FROM, 1100, receipt_id=str(receipt.id)
        ),
        "with_receipt": await _create_tx(
            client, headers, account_id, "2026-06-12", 1200, receipt_id=str(receipt.id)
        ),
        "with_goal_item": await _create_tx(
            client,
            headers,
            account_id,
            "2026-06-15",
            1300,
            goal_item_id=item.json()["id"],
        ),
        "with_recurring": await _create_tx(
            client, headers, account_id, "2026-06-20", 1400
        ),
        # The last day of the statement's period — inclusive, so it dies too.
        "on_period_to": await _create_tx(client, headers, account_id, PERIOD_TO, 1500),
        # One day PAST the period: outside the range, so it lives.
        "after": await _create_tx(client, headers, account_id, "2026-07-01", 1600),
        "other_account": await _create_tx(
            client, headers, other_account_id, "2026-06-15", 4000
        ),
    }
    # ``recurring_template_id`` is written by the materializer alone (attribution is
    # not a client field), so the link is made where the materializer would make it.
    await db_session.execute(
        update(Transaction)
        .where(Transaction.id == uuid.UUID(seeded["with_recurring"]))
        .values(recurring_template_id=uuid.UUID(template.json()["id"]))
    )
    await db_session.commit()

    out = await client.post(
        "/transactions",
        json={
            "account_id": account_id,
            "counter_account_id": other_account_id,
            "amount_minor": 2000,
            "counter_amount_minor": 2000,
            "kind": "transfer",
            "occurred_at": "2026-06-25",
        },
        headers=headers,
    )
    assert out.status_code == 201, out.text
    seeded["transfer_out"] = str(out.json()["id"])
    incoming = await client.post(
        "/transactions",
        json={
            "account_id": other_account_id,
            "counter_account_id": account_id,
            "amount_minor": 3000,
            "counter_amount_minor": 3000,
            "kind": "transfer",
            "occurred_at": "2026-06-26",
        },
        headers=headers,
    )
    assert incoming.status_code == 201, incoming.text
    seeded["transfer_in"] = str(incoming.json()["id"])
    return seeded


class TestReplacePreview:
    async def test_preview_counts_the_doomed_their_links_and_the_survivors(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        statement_csv_bytes: bytes,
    ) -> None:
        """The warning is the server's own selection, and it is complete.

        ``deleted_total`` is what the DELETE will take (this account's non-transfer
        rows in ``[from; period_to]``) and ``transfers_kept`` is everything else the
        account shows in that range — both legs, because an incoming transfer
        survives just as much as an outgoing one and a user who is not told about it
        will read the leftovers as a bug.

        The three link counters are what makes the warning worth reading: those rows
        do not come back as they were, and the file cannot restore a receipt link, a
        plan payment or an attribution to a template.

        Reading it twice changes nothing — the preview is a read, and the user is
        expected to move the date around before committing to anything.
        """
        headers = await _register_and_login(client, "replace-preview@example.com")
        account_id = await _byn_account(client, headers)
        other_id = await _byn_account(client, headers, name="Cash BYN")
        await _seed_range(client, db_session, headers, account_id, other_id)
        import_id = await _upload(client, headers, account_id, statement_csv_bytes)

        resp = await _preview(client, headers, import_id)

        assert resp.status_code == 200, resp.text
        assert resp.json() == {
            "deleted_total": 5,
            "deleted_with_receipt": 2,
            "deleted_with_goal_item": 1,
            "deleted_with_recurring_template": 1,
            "transfers_kept": 2,
            "debt_movements_kept": 0,
            # The fixture's three rows dated on or after the replaced date
            # (10.06, 11.06, 13.06).
            "will_create": 3,
        }
        again = await _preview(client, headers, import_id)
        assert again.json() == resp.json()
        assert len(await _transactions(client, headers, account_id)) == 9

    async def test_a_date_outside_the_period_is_refused_by_both_routes(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """Both bounds, and on the WRITE too — before it deletes anything.

        Below ``period_from`` the replace would empty days the file has nothing to
        put back; above ``period_to`` the range is empty, which is a mistyped date
        and not a no-op worth executing. The preview's refusal is advisory; the
        POST's is the one that stands between a typo and a deletion, so it is
        asserted to leave the session alive and untouched.
        """
        headers = await _register_and_login(client, "replace-range@example.com")
        account_id = await _byn_account(client, headers)
        kept = await _create_tx(client, headers, account_id, "2026-06-15", 7700)
        import_id = await _upload(client, headers, account_id, statement_csv_bytes)

        for outside in ("2026-05-31", "2026-07-01"):
            preview = await _preview(client, headers, import_id, from_date=outside)
            assert preview.status_code == 422, preview.text
            assert preview.json() == {"detail": "REPLACE_FROM_OUT_OF_RANGE"}
            written = await _replace(client, headers, import_id, 1, from_date=outside)
            assert written.status_code == 422, written.text
            assert written.json() == {"detail": "REPLACE_FROM_OUT_OF_RANGE"}

        survivors = await _transactions(client, headers, account_id)
        assert [tx["id"] for tx in survivors] == [kept]
        session = await client.get(f"/statement-imports/{import_id}", headers=headers)
        assert session.json()["status"] == "parsed"


class TestReplace:
    async def test_replace_cuts_exactly_this_account_s_own_range(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        statement_csv_bytes: bytes,
    ) -> None:
        """The whole selection, proved in the one call that cannot be undone.

        Four independent ways this could destroy data it must not touch, all of them
        in one June because they only mean anything TOGETHER: the day before the
        range, the day after the period, another account of the same user, and a
        transfer — which is one row seen from two accounts, so deleting it would
        erase the second account's history for money this file cannot see. Its
        counter leg is checked from the other account, which is where the damage
        would show.

        What must go, goes: the boundaries themselves (``from`` and ``period_to``
        are both inclusive) and everything between them, replaced by the statement's
        own rows for those days.
        """
        headers = await _register_and_login(client, "replace-cut@example.com")
        stranger = await _register_and_login(client, "replace-cut-other@example.com")
        account_id = await _byn_account(client, headers)
        other_id = await _byn_account(client, headers, name="Cash BYN")
        seeded = await _seed_range(client, db_session, headers, account_id, other_id)
        foreign_account = await _byn_account(client, stranger)
        foreign_tx = await _create_tx(
            client, stranger, foreign_account, "2026-06-15", 1300
        )
        import_id = await _upload(client, headers, account_id, statement_csv_bytes)

        resp = await _replace(client, headers, import_id, 5)

        assert resp.status_code == 200, resp.text
        assert resp.json() == {"deleted": 5, "created": 3, "already_existed": 0}
        survivors = await _transactions(client, headers, account_id)
        ids = {tx["id"] for tx in survivors}
        assert ids.isdisjoint(
            {
                seeded["on_from"],
                seeded["with_receipt"],
                seeded["with_goal_item"],
                seeded["with_recurring"],
                seeded["on_period_to"],
            }
        )
        assert {
            seeded["before"],
            seeded["after"],
            seeded["transfer_out"],
            seeded["transfer_in"],
        } <= ids
        assert len(survivors) == 4 + 3
        # …and the statement's own rows for those days are in their place, by the
        # money rather than by the bank's wording: 1439.63 (the PLN purchase as
        # settled), 300.00 and the 2000.00 refund.
        assert {tx["amount_minor"] for tx in survivors} >= {143_963, 30_000, 200_000}
        # The other account of the SAME user: its own row and both transfer legs.
        assert {tx["id"] for tx in await _transactions(client, headers, other_id)} == {
            seeded["other_account"],
            seeded["transfer_out"],
            seeded["transfer_in"],
        }
        assert [
            tx["id"] for tx in await _transactions(client, stranger, foreign_account)
        ] == [foreign_tx]
        session = await client.get(f"/statement-imports/{import_id}", headers=headers)
        assert session.json()["status"] == "replaced"
        assert session.json()["applied_at"] is not None

    async def test_a_debt_movement_inside_the_range_is_announced_and_spared(
        self,
        client: AsyncClient,
        statement_csv_bytes: bytes,
    ) -> None:
        """The debts scope's twin of ``transfers_kept``, through both routes.

        A debt movement in the replaced range is another entity's history: the
        preview announces it in its own counter (so the user is told what survives
        rather than discovering leftovers), and the DELETE leaves it — with the
        debt's remaining balance untouched, which is the thing that would have
        broken silently had the predicate stayed "not a transfer".
        """
        headers = await _register_and_login(client, "replace-debt@example.com")
        account_id = await _byn_account(client, headers)
        ordinary = await _create_tx(client, headers, account_id, "2026-06-15", 1_200)
        debt = await client.post(
            "/debts",
            json={
                "direction": "lent",
                "counterparty": "Петя",
                "currency": "BYN",
                "amount_minor": 5_000,
                "account_id": account_id,
                "opened_on": "2026-06-12",
            },
            headers=headers,
        )
        assert debt.status_code == 201, debt.text
        repaid = await client.post(
            f"/debts/{debt.json()['id']}/repayments",
            json={
                "amount_minor": 2_000,
                "account_id": account_id,
                "occurred_at": "2026-06-20",
            },
            headers=headers,
        )
        assert repaid.status_code == 201, repaid.text
        import_id = await _upload(client, headers, account_id, statement_csv_bytes)

        preview = await _preview(client, headers, import_id)
        written = await _replace(client, headers, import_id, 1)

        assert preview.status_code == 200, preview.text
        # One deletable row, and the two debt movements counted where they belong.
        assert preview.json()["deleted_total"] == 1
        assert preview.json()["debt_movements_kept"] == 2
        assert written.status_code == 200, written.text
        assert written.json()["deleted"] == 1
        survivors = {
            tx["id"] for tx in await _transactions(client, headers, account_id)
        }
        assert ordinary not in survivors
        assert {row["id"] for row in repaid.json()["repayments"]} <= survivors
        detail = await client.get(f"/debts/{debt.json()['id']}", headers=headers)
        assert detail.json()["remaining_minor"] == 3_000
        assert detail.json()["repayments_count"] == 1

    async def test_a_stale_confirmation_number_deletes_nothing(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        statement_csv_bytes: bytes,
    ) -> None:
        """The number is checked against the deletion itself, and the refusal is free.

        A row booked between the preview and the confirmation is precisely the case
        the typed number exists for: the user confirmed five deletions and six would
        happen. The whole transaction rolls back — nothing deleted, nothing created,
        the session still a proposal — and the answer carries both numbers so the
        client can redraw the warning rather than make the user guess.

        The second half is what makes the refusal harmless: the corrected number
        goes through on the very next call.
        """
        headers = await _register_and_login(client, "replace-confirm@example.com")
        account_id = await _byn_account(client, headers)
        other_id = await _byn_account(client, headers, name="Cash BYN")
        await _seed_range(client, db_session, headers, account_id, other_id)
        import_id = await _upload(client, headers, account_id, statement_csv_bytes)
        assert (await _preview(client, headers, import_id)).json()["deleted_total"] == 5
        late = await _create_tx(client, headers, account_id, "2026-06-18", 1700)

        stale = await _replace(client, headers, import_id, 5)

        assert stale.status_code == 422, stale.text
        assert stale.json() == {
            "detail": "REPLACE_CONFIRMATION_MISMATCH",
            "confirm_deleted_total": 5,
            "deleted_total": 6,
        }
        before = await _transactions(client, headers, account_id)
        assert len(before) == 10
        assert late in {tx["id"] for tx in before}
        session = await client.get(f"/statement-imports/{import_id}", headers=headers)
        assert session.json()["status"] == "parsed"

        corrected = await _replace(client, headers, import_id, 6)

        assert corrected.status_code == 200, corrected.text
        assert corrected.json() == {"deleted": 6, "created": 3, "already_existed": 0}

    async def test_a_finished_session_neither_previews_nor_replaces_again(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """Once is once — and the second call must not delete what the first created.

        A replaced session is a journal of what was done to the user's money. Running
        it again would delete exactly the rows it had just written (they sit in the
        replaced range now), and previewing it would count them as doomed — a
        frightening number printed over an operation nobody can undo.
        """
        headers = await _register_and_login(client, "replace-once@example.com")
        account_id = await _byn_account(client, headers)
        await _create_tx(client, headers, account_id, "2026-06-15", 8800)
        import_id = await _upload(client, headers, account_id, statement_csv_bytes)
        first = await _replace(client, headers, import_id, 1)
        assert first.status_code == 200, first.text
        after_first = {
            tx["id"] for tx in await _transactions(client, headers, account_id)
        }

        again = await _replace(client, headers, import_id, 3)
        preview = await _preview(client, headers, import_id)

        assert again.status_code == 422, again.text
        assert again.json() == {"detail": "IMPORT_FINISHED"}
        assert preview.status_code == 422, preview.text
        assert preview.json() == {"detail": "IMPORT_FINISHED"}
        assert {
            tx["id"] for tx in await _transactions(client, headers, account_id)
        } == after_first

    async def test_a_replace_onto_an_archived_account_is_refused(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """The closed door, on the one path that would DELETE through it.

        An account archived after the upload is the reachable shape: the session was
        a legitimate proposal when it was made, and by the time it is executed the
        user has closed the account. Every other write to an archived account is
        refused, and this one would first destroy a range of its history and then
        re-file a statement over it.

        The same call, byte for byte, goes through once the account is re-opened —
        so what refused it was the door and not the date, the number or the session.
        """
        headers = await _register_and_login(client, "replace-archived@example.com")
        account_id = await _byn_account(client, headers)
        doomed = await _create_tx(client, headers, account_id, "2026-06-15", 8800)
        import_id = await _upload(client, headers, account_id, statement_csv_bytes)
        archived = await client.patch(
            f"/accounts/{account_id}", json={"archived": True}, headers=headers
        )
        assert archived.status_code == 200, archived.text

        refused = await _replace(client, headers, import_id, 1)

        assert refused.status_code == 422, refused.text
        assert refused.json() == {"detail": "ACCOUNT_ARCHIVED"}
        alive = await _transactions(client, headers, account_id)
        assert [tx["id"] for tx in alive] == [doomed]
        session = await client.get(f"/statement-imports/{import_id}", headers=headers)
        assert session.json()["status"] == "parsed"

        reopened = await client.patch(
            f"/accounts/{account_id}", json={"archived": False}, headers=headers
        )
        assert reopened.status_code == 200, reopened.text
        allowed = await _replace(client, headers, import_id, 1)

        assert allowed.status_code == 200, allowed.text
        assert allowed.json() == {"deleted": 1, "created": 3, "already_existed": 0}

    async def test_the_retry_arm_refuses_a_session_a_parallel_write_finished(
        self,
        client: AsyncClient,
        db_session: AsyncSession,
        statement_csv_bytes: bytes,
    ) -> None:
        """What the route's ``except IntegrityError`` arm does on a finished session.

        The only race that reaches an INSERT — and therefore a duplicate key — is a
        confirmed total of ZERO on both sides: an empty range, nothing to delete,
        the same fingerprints written twice. The winner here is the route; the
        second call is ``replace_import`` invoked directly, which is exactly what
        the retry arm runs after its rollback.

        It must refuse on the lifecycle instead of re-running the DELETE over the
        range the winner has just refilled (review-s3 MINOR-1): the rows it would
        find there are the winner's own, and the safety of that path would rest on
        ``deleted != confirm`` arithmetic rather than on the session being finished.
        """
        headers = await _register_and_login(client, "replace-retry@example.com")
        me = await client.get("/users/me", headers=headers)
        user_id = uuid.UUID(me.json()["id"])
        account_id = await _byn_account(client, headers)
        import_id = await _upload(client, headers, account_id, statement_csv_bytes)

        winner = await _replace(client, headers, import_id, 0)
        assert winner.status_code == 200, winner.text
        # The legal confirm=0 path: the range held none of the user's own records,
        # so nothing dies and the statement's three rows are simply filed.
        assert winner.json() == {"deleted": 0, "created": 3, "already_existed": 0}
        booked = {tx["id"] for tx in await _transactions(client, headers, account_id)}

        with pytest.raises(StatementApplyError) as refused:
            await replace_import(
                db_session,
                uuid.UUID(import_id),
                user_id,
                date.fromisoformat(FROM),
                0,
            )

        assert refused.value.code == "IMPORT_FINISHED"
        assert {
            tx["id"] for tx in await _transactions(client, headers, account_id)
        } == booked

    async def test_a_fingerprint_that_survived_outside_the_range_is_not_duplicated(
        self, client: AsyncClient, statement_csv_bytes: bytes
    ) -> None:
        """The B-1 pass runs AFTER the deletion, so it sees what really survived.

        The real shape of this: import the file, move one imported row out of the
        statement's period (the user dates it differently), then replace the tail of
        that period from a second upload. The rows whose transactions the deletion
        just freed are written again; the one that escaped the range keeps its
        fingerprint, so it is reported as already there instead of arriving a second
        time under a different date.
        """
        headers = await _register_and_login(client, "replace-b1@example.com")
        account_id = await _byn_account(client, headers)
        first_import = await _upload(client, headers, account_id, statement_csv_bytes)
        applied = await client.post(
            f"/statement-imports/{first_import}/apply", headers=headers
        )
        assert applied.json()["created"] == 7, applied.text
        booked = await _transactions(client, headers, account_id)
        # The 13.06 refund — the last row of the statement, and the only one worth
        # 2000.00, so it is identified by its money and not by the bank's wording.
        refund = next(tx for tx in booked if tx["amount_minor"] == _REFUND_MINOR)
        moved = await client.patch(
            f"/transactions/{refund['id']}",
            json={"occurred_at": "2026-05-20"},
            headers=headers,
        )
        assert moved.status_code == 200, moved.text
        second_import = await _upload(client, headers, account_id, statement_csv_bytes)

        resp = await _replace(client, headers, second_import, 2)

        assert resp.status_code == 200, resp.text
        # The 10.06 and 11.06 rows were deleted and rewritten; the refund was
        # neither, because its transaction is alive in May and still carries that
        # row's fingerprint.
        assert resp.json() == {"deleted": 2, "created": 2, "already_existed": 1}
        survivors = await _transactions(client, headers, account_id)
        assert len(survivors) == 7
        refunds = [tx for tx in survivors if tx["amount_minor"] == _REFUND_MINOR]
        assert [tx["occurred_at"] for tx in refunds] == ["2026-05-20"]
