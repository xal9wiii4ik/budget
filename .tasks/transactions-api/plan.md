# Implementation Plan: transactions-api (roadmap 1.4)

## Approach

CRUD + monthly summary over the existing `transactions` table (created live at
1.2: magnitude `amount_minor >= 0`, NOT NULL `kind` sign authority, `currency`
`char(3)` `~ '^[A-Z]{3}$'`, `category_id` FK `ON DELETE SET NULL`, composite
`ix_transactions_user_id_occurred_at`). This is a routes+schemas task on an
existing table plus one small shared-helper extraction — no new tables, no
dependency-direction change — so **no architect involvement** (consistent with
the 1.3 skip rationale). The task brief floated the domain/ boundary question
for the first aggregate; decision (k) answers it explicitly: **summary SQL lives
in the router** (first-consumer rule; 4.1 extracts), so no `domain/` or
`services/` machinery is created here.

Two authorization pillars carry over verbatim from categories.py (the precedent
router): **reads** filter `user_id = me` (transactions are never system rows, so
no `OR user_id IS NULL` on the tx table itself — but the *category reference* a
transaction points at IS visible-scoped, `user_id = me OR user_id IS NULL`);
**writes** force `user_id = me` and never read `user_id` from the body. The
transaction's own path id uses the no-oracle `404 TRANSACTION_NOT_FOUND`
(cross-user and missing byte-identical). A **body** category reference that is
foreign/missing/archived is a `422` (the addressed resource — the transaction —
is fine; the *body* is unprocessable), keeping category existence secret
(byte-identical foreign vs missing).

This task discharges four binding carry-forwards: (1.2 §7) it is the **second
consumer** of the visible-categories query, so that query is **extracted** into a
shared helper and categories.py is refactored onto it in the same task; (1.2 §7)
transaction schemas carry a **required `kind`**; (arch §1) the summary uses a
**CASE aggregate over kind**; and (1.2 §6) it implements the **self-healing
profile get-or-create** at this first profile-reading task.

## Endpoints

Route registration order matters — see decision (j) and Risks. Declared order:
POST, GET (list), GET `/summary`, PATCH `/{transaction_id}`, DELETE
`/{transaction_id}`.

| Method | Path | Success | Error statuses | Error codes (our `{"detail": CODE}`) |
|---|---|---|---|---|
| POST | `/transactions` | 201 `TransactionRead` | 401, 422 | `CATEGORY_NOT_FOUND`, `CATEGORY_ARCHIVED` (+ std Pydantic 422 array) |
| GET | `/transactions` | 200 `TransactionList` | 401, 422 | — (std Pydantic 422 for bad query params) |
| GET | `/transactions/summary` | 200 `SummaryRead` | 401, 422 | — (std Pydantic 422 for bad `month`) |
| PATCH | `/transactions/{transaction_id}` | 200 `TransactionRead` | 401, 404, 422 | `TRANSACTION_NOT_FOUND` (404); `CATEGORY_NOT_FOUND`, `CATEGORY_ARCHIVED`, `AMOUNT_REQUIRED`, `KIND_REQUIRED`, `OCCURRED_AT_REQUIRED` (422) |
| DELETE | `/transactions/{transaction_id}` | 204 (no body) | 401, 404 | `TRANSACTION_NOT_FOUND` |

No `GET /transactions/{id}` — decision (m). No rate limiting — decision (n).

## Decisions (a–n; senior recommendations folded, pushback flagged inline)

**a. DELETE semantics — real DELETE, 204.** ACCEPT the lean recommendation.
Transactions are leaf rows: nothing references them today, and the only future
referrer (2.1 receipts) points the FK the other way (`tx.receipt_id → receipts`,
architecture §5), so deleting a transaction orphans nothing. Archive-instead has
no referential justification here (unlike categories, which old transactions
reference). `DELETE /transactions/{transaction_id}` → `204 No Content`, empty
body, `response_model=None`. No-oracle: cross-user id and missing id both →
`404 TRANSACTION_NOT_FOUND`, byte-identical body (the delete loads via
`user_id = me` scoped query; a foreign/missing id matches nothing → 404, same
path).

**b. Pagination — `limit`/`offset` with a `{items, total}` envelope.** ACCEPT.
Cursor pagination is over-engineering at personal cardinality (a user has
hundreds–low-thousands of rows lifetime); fully unbounded is a buried default
that the list screen would eventually choke on. `offset: int = 0` (`ge=0`);
`limit: int = 50` default, `le=200` max. Justification for the numbers: the 1.6
month view renders ~a screen of rows; 50 is a comfortable page and 200 caps a
pathological pull without ever truncating a normal month (a heavy month is
~100–150 tx). Envelope `TransactionList {items: list[TransactionRead], total:
int}` so the client can render "showing 50 of N" and drive paging without a
second count call.
*Index verdict (recorded either way):* the existing composite
`ix_transactions_user_id_occurred_at` covers the whole read path — `user_id`
equality is the leading column, the `from`/`to` range and `ORDER BY occurred_at
DESC` ride the second column. `SELECT count(*)` per list request is a second
index-only-ish scan of the same tiny per-user slice; **at personal scale this is
sub-millisecond — no new index, no denormalized counter.** Consistent with the
1.2/1.3 no-index verdicts.

**c. Kind enum — NEW `TransactionKind(StrEnum)` in `enums.py`.** ACCEPT (do not
reuse `CategoryKind`). Same two values today (`expense`, `income`). Decisive
argument (recorded 1.2 carry-forward): stage-5 transfers add a **third** kind
value to **transactions only** (one-line CHECK alter), while categories stay
two-valued — the enums *will* diverge, and splitting a shared enum later is a
breaking change in the generated contract (`schema.d.ts` enum members shift).
Two identical two-member enums now is cheap and future-proof. **CHECK
byte-identity duty:** `models/transaction.py` currently hardcodes
`"kind IN ('expense', 'income')"`; it is refactored to rebuild the CHECK from
`TransactionKind` (mirroring `models/category.py`), and the rendered SQL MUST
stay byte-identical to migration 0002 (`kind IN ('expense', 'income')`).
Definition order (`expense`, `income`) is load-bearing; `alembic check` / the
autogenerate probe guards drift, verified at the diff gate.

**d. Currency — no currency field on the wire in; server stamps
`profile.base_currency`; `currency` appears in `TransactionRead`.** ACCEPT.
`TransactionCreate`/`TransactionUpdate` carry **no** `currency` field. On create
the server resolves the base currency via the get-or-create profile helper
(decision below) and stamps it. `TransactionRead` returns `currency` so clients
render from data (never assume). Stage 3.2 later ADDS an optional `currency` to
create — additive, non-breaking. Rejecting free ISO input now is the whole point:
a single mixed-currency row would silently corrupt the summary aggregate (which
sums minor units with no conversion until stage 3). MVP is single-currency by
construction, not by convention.

**e. `category_id` validation on write — visible-or-error; 422 for a body-ref
miss; reject archived for new/repointed; PATCH validates only when in the field
set.** ACCEPT with reasoning.
- *Status for a body category miss:* **422 `CATEGORY_NOT_FOUND`**, not 404.
  Pushback-considered: the categories precedent uses **404 for a PATH id** (the
  addressed resource). Here `category_id` is a **body reference** on
  `POST/PATCH /transactions`; a 404 would tell the client "the transaction you
  addressed doesn't exist," which is false and misleading. `422 Unprocessable
  Content` correctly says "your body references a category you can't use." I
  adopt the senior lean (422).
- *No-oracle:* foreign category (another user's id) and a nonexistent id are
  **byte-identical** `422 CATEGORY_NOT_FOUND` — the shared `load_visible_category`
  helper returns `None` for both, one code path (same construction as
  `_load_visible` in categories.py).
- *Archived category as target for a NEW/repointed transaction:* **reject,
  `422 CATEGORY_ARCHIVED`.** An archived category is a retired bucket; letting new
  spend land in it defeats the archive. (The category is loaded visible first —
  so a foreign archived category is `CATEGORY_NOT_FOUND`, never
  `CATEGORY_ARCHIVED`, preserving the existence oracle. Order: load-visible →
  `None`? 422 `CATEGORY_NOT_FOUND`; else `archived`? 422 `CATEGORY_ARCHIVED`.)
- *PATCH that does not touch `category_id`:* **do NOT revalidate the category.**
  A transaction whose category was archived *after* the fact must still accept an
  amount/note/date/kind edit. Category validation runs **only when
  `"category_id" in payload.model_fields_set`**. This is binding and pytest-pinned
  (`test_patch_amount_only_on_archived_category_tx_succeeds`).
- *Clearing to uncategorized:* `PATCH {"category_id": null}` sets it NULL
  (uncategorized) with no validation — null is always valid.

**f. Kind mismatch tx.kind vs category.kind — ALLOW, no cross-check.** RECORDED,
not reopened (1.2 ruling). `tx.kind` is the sign/aggregation authority;
`category.kind` is prefill only. An income transaction against an expense
category is a **refund** and is legal. No write-time cross-check. This is
exercised by the summary refund test (income tx on an expense category counted as
income).

**g. `occurred_at` — allow any date, including the future.** ACCEPT the lean.
No product feature depends on rejecting a future date, and a fat-fingered future
date is trivially user-fixable via PATCH. Adding a "no future dates" rule buys
zero integrity and invites timezone-boundary bugs (is "tomorrow" the server's or
the client's?). *Summary implication (recorded):* a future-dated row that falls
inside the queried month **does** count in that month's totals — correct and
predictable given `occurred_at` is the sole period axis.

**h. `amount_minor` bound — API rejects zero (`ge=1`); DB stays `>= 0`.** ACCEPT.
The zero-amount policy was explicitly deferred from 1.2 to this contract task. A
zero-amount transaction is meaningless (it moves no money and pollutes counts and
averages) — reject it at the contract with `Field(ge=1)`. The DB CHECK stays the
looser `>= 0` (it is frozen in migration 0002 and a zero row is not a *corruption*,
just a policy violation the API now forbids). `ge=1` also rejects negatives (the
magnitude invariant). This is a deliberate deferred-policy pin → one pytest guards
it (see test plan, R6 analogue).

**i. `note` — cap 500, strip, empty→None.** DECIDED. `note` is a free-text memo,
not a document; 500 chars is generous for "lunch with A, split 3 ways" and caps
abuse. Normalization mirrors the categories `icon` validator: **strip
surrounding whitespace; a value that is empty after stripping → `None`** (so
`""` and `"   "` both mean "no note," never a stored blank). On PATCH, explicit
`null` clears, an explicit `""`/whitespace also clears (normalized to `None`),
omitted preserves. Cap enforced *after* strip (a 501-char string of spaces isn't
a 501-char note).

**j. Summary endpoint — `GET /transactions/summary?month=YYYY-MM`.** ACCEPT the
senior shape.
- *Param:* single `month: str` validated by `Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")`
  — a malformed month is a standard Pydantic `422` (no custom code needed; the
  pattern also guarantees the subsequent `date(year, month, 1)` parse is safe).
  **(AM-6 folded at /implement):** the Query pattern is the ONLY month validator —
  there is NO date-parsing validation path; `date(year, mon, 1)` runs only AFTER
  the pattern has guaranteed validity, so `2026-00`/`2026-13`/garbage 422 at the
  Query layer and can never reach `date()` to 500.
- *Response `SummaryRead`:* `{month: str, currency: str, income_minor: int,
  expense_minor: int, net_minor: int, by_category: list[CategorySummary]}`.
  `net_minor = income_minor - expense_minor` is **signed** (can be negative — a
  month where you spent more than you earned). `currency` is the profile base
  currency (reference; all rows are single-currency in MVP).
- *`by_category`:* reference-by-id, **no embedded category names** — 1.6 has the
  categories list cached from 1.3 and joins client-side; embedding would
  duplicate mutable state. `CategorySummary {category_id: uuid.UUID | None, kind:
  TransactionKind, total_minor: int}`. `category_id` is **nullable** — the `NULL`
  bucket is the uncategorized total (transactions with `category_id IS NULL`
  after a SET NULL or a deliberate uncategorized entry).
- *Breakdown in or out for 1.6:* **IN.** It is one `GROUP BY` away and 1.6's
  summary screen is anemic without a per-category slice (the headline chart).
  Frontend contract review confirms the consumer.
- *Ordering of `by_category` rows:* `ORDER BY kind, total_minor DESC` —
  deterministic, and "biggest bucket first within each kind" is the natural
  render order for the chart. (Client may re-sort; server order is determinism +
  a sensible default, not a display contract.)
- *Empty month:* **returns zeros, never 404.** A month with no transactions →
  `income_minor=0, expense_minor=0, net_minor=0, by_category=[]`, `currency` =
  base. Never 404 an aggregate — "no data" is a valid answer, not a missing
  resource.

**k. Summary SQL location — IN THE ROUTER.** DECIDED, deliberate precedent. This
is the first aggregate endpoint and the task brief asked whether it is
SQL-in-router, SQL-in-service, or a `domain/` function. Answer: **SQL in the
router** (module-level query construction, inline execution), by the same
first-consumer rule that kept the visible-categories query inline at 1.3. We do
**not** build `domain/` or `services/` machinery for a two-query aggregate.
`domain/` (architecture §4) is for *pure logic* (goals math, currency
conversion) — a `GROUP BY` is not pure logic, it is a query. **4.1 (statistics)
is the extraction point** when the second/third aggregate arrives and a shared
shape emerges; extracting now would be speculative. Recorded as the precedent for
all stage-4 statistics.

**l. List filters + ordering + shared DTO.** DECIDED.
- *Filters:* `from`/`to` (**inclusive** date bounds, `occurred_at >= from AND
  occurred_at <= to`), `category_id` (single value, MVP), `kind`. All optional.
- *`from > to`:* **no custom validation — returns empty** (the `WHERE` naturally
  yields nothing). Rationale: consistent with the READ-filter philosophy below;
  it is a client bug that self-evidences as an empty list, not an oracle or
  integrity issue, and a custom `422` adds a code + test for a non-hazard. (Flag
  for senior: if you prefer an explicit `422 INVALID_PERIOD`, it is a two-line
  add — I lean no.)
- *Foreign/invalid `category_id` filter:* **just filters, returns empty — no
  existence check on a READ filter.** ACCEPT the senior lean. A read filter is
  not a write reference; probing existence here would (a) add a no-oracle concern
  to a place that has none and (b) reject a perfectly well-formed query. An
  unknown/foreign `category_id` simply matches no rows.
- *Ordering:* `ORDER BY occurred_at DESC, created_at DESC, id` — deterministic,
  newest-first, with `created_at` then `id` as tie-breaks so pagination slices
  are stable across requests.
- *Shared DTO:* **yes — list and mutations share `TransactionRead`** (categories
  precedent). Transaction rows carry no heavy fields; a separate list projection
  would add a type for zero benefit.

**m. `GET /transactions/{id}` — OMIT.** ACCEPT (1.3 precedent). The list is the
read path; mutations (POST/PATCH) return the full row; DELETE returns 204. A
single-row GET is trivial to add if a real client need appears (e.g., a deep-link
to one transaction). *Future trigger recorded:* add `GET /transactions/{id}` when
2.1's receipt-confirmation flow or a 1.6 detail view needs to fetch one row by id
out of list context. Consequence: since there is **no** `GET /{transaction_id}`,
the `GET /summary` route has no same-method sibling to collide with (see j /
Risks) — but the defensive ordering still stands for the future trigger.

**n. Rate limiting — none on transaction CRUD.** ACCEPT (mirror 1.3). JWT-gated,
no expensive downstream (no external API, no heavy compute); slowapi stays
reserved for `/auth` (1.1) and future AI routes (4.4). **`prime_rate_limit`
non-issue re-verified for a new router:** `prime_rate_limit` and the rate-limit
contextvar are read *only* by routes post-decorated with `@limiter.limit`
(grep-confirmed at 1.3: referenced solely in `rate_limit.py` + `routers/auth.py`).
The transactions router never calls `limiter.limit`, so mounting it in `app.py`
**without** `Depends(prime_rate_limit)` cannot 500 — identical construction to
the categories mount (app.py:58).

## Schema definitions (`schemas/transaction.py`)

Exact constraints. `kind` is **required** on create (client defaults it from the
picked category; the server never derives it — 1.2 sign-authority ruling).

```python
import uuid
from datetime import date, datetime
from pydantic import BaseModel, ConfigDict, Field, field_validator
from budget_api.enums import TransactionKind

_NOTE_MAX = 500

def _clean_note(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    if not v:
        return None
    if len(v) > _NOTE_MAX:
        raise ValueError(f"note must be at most {_NOTE_MAX} characters")
    return v


class TransactionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    amount_minor: int
    kind: TransactionKind
    currency: str                      # server-stamped base currency (read-only)
    category_id: uuid.UUID | None
    occurred_at: date
    note: str | None
    created_at: datetime               # tz-aware


class TransactionCreate(BaseModel):
    # No currency field (decision d); no user_id field (forced from token).
    amount_minor: int = Field(ge=1)    # decision h: reject zero/negative at contract
    kind: TransactionKind              # REQUIRED (1.2 carry-forward)
    category_id: uuid.UUID | None = None
    occurred_at: date                  # required; any date incl. future (decision g)
    note: str | None = None

    @field_validator("note")
    @classmethod
    def _validate_note(cls, v: str | None) -> str | None:
        return _clean_note(v)


class TransactionUpdate(BaseModel):
    # All optional; omitted vs explicit-null distinguished by the router via
    # model_fields_set. NOT NULL fields (amount/kind/occurred_at) reject explicit
    # null with a *_REQUIRED 422; nullable fields (category_id/note) clear on null.
    amount_minor: int | None = Field(default=None, ge=1)
    kind: TransactionKind | None = None
    category_id: uuid.UUID | None = None
    occurred_at: date | None = None
    note: str | None = None

    @field_validator("note")
    @classmethod
    def _validate_note(cls, v: str | None) -> str | None:
        return _clean_note(v)


class TransactionList(BaseModel):       # pagination envelope (decision b)
    items: list[TransactionRead]
    total: int


class CategorySummary(BaseModel):
    category_id: uuid.UUID | None       # null bucket = uncategorized
    kind: TransactionKind
    total_minor: int


class SummaryRead(BaseModel):
    month: str                          # echoed "YYYY-MM"
    currency: str                       # profile base currency
    income_minor: int
    expense_minor: int
    net_minor: int                      # signed: income - expense
    by_category: list[CategorySummary]


class TransactionError(BaseModel):
    """404/422 error envelope — mirrors CategoryError / RateLimitedError."""
    detail: str
```

### Enum decision (`enums.py`, append — decision c)

```python
class TransactionKind(StrEnum):
    # Independent from CategoryKind by design (decision c): stage-5 transfers add
    # a third value HERE only. Definition order (expense, income) is load-bearing:
    # models/transaction.py rebuilds its kind CHECK from this iteration order and
    # must emit SQL byte-identical to migration 0002 (kind IN ('expense', 'income')).
    expense = "expense"
    income = "income"
```

### Model delta (`models/transaction.py` — decision c)

```python
from budget_api.enums import TransactionKind

_KIND_VALUES = ", ".join(f"'{k.value}'" for k in TransactionKind)  # 'expense', 'income'
# in __table_args__:
CheckConstraint(f"kind IN ({_KIND_VALUES})", name="kind_valid")
```
`kind: Mapped[str]` stays `str` (DB column is `String(16)`); the enum is the
app-level source. No migration edit — the rendered SQL is byte-identical to 0002.

## Extraction refactor — the visible-category helper (1.2 §7 binding)

1.4 is the **second consumer** of `user_id = :u OR user_id IS NULL`, so the query
is extracted now and categories.py is refactored onto it in the same task.

**New file `apps/api/src/budget_api/category_access.py`** (top-level neutral
module, same placement rationale as `enums.py` — imports `models`, imported by
routers; no cycle):

```python
# (AM-3 folded at /implement: `select` added to the imports.)
import uuid
from sqlalchemy import ColumnElement, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from budget_api.models import Category


def visible_categories_clause(user_id: uuid.UUID) -> ColumnElement[bool]:
    """Own rows + shared system rows — the single visibility predicate."""
    return or_(Category.user_id == user_id, Category.user_id.is_(None))


async def load_visible_category(
    session: AsyncSession, category_id: uuid.UUID, user_id: uuid.UUID
) -> Category | None:
    """A category visible to this user (own or system). Foreign/missing → None.

    One code path for both miss cases keeps their error bodies indistinguishable
    (no-oracle) — the property the transactions write path and categories PATCH
    both rely on.
    """
    return await session.scalar(
        select(Category).where(
            Category.id == category_id, visible_categories_clause(user_id)
        )
    )
```

**Refactor `routers/categories.py`** (non-behavioral): replace the inline
`_load_visible` body with a call to `load_visible_category`, and the list
endpoint's inline `or_(Category.user_id == user.id, Category.user_id.is_(None))`
with `visible_categories_clause(user.id)`. `_load_visible` may be dropped in
favor of the shared name, or kept as a one-line delegating alias — I lean drop
and update the two call sites, since the shared helper is now the canonical name.
**Non-regression is covered by the existing `tests/test_categories.py`** (the
cross-user/missing 404, system 403, and list-merge tests exercise exactly these
two extracted pieces) — no new categories test is written; the extraction is a
pure move. This is called out in the test plan.

**Transactions router uses `load_visible_category`** for write-path category
authorization (create + repoint on PATCH), then applies the archived check in the
router (the helper only answers visibility, not policy). This discharges the
binding "cross-user category authorization on write paths — MUST be pytest-covered
there."

## Profile get-or-create helper (1.2 §6 binding — first profile-reading task)

The trigger recorded at 1.2: a pre-1.2 user may have no `profiles` row (the
register hook only backfills go-forward; 0003 backfilled existing users, but the
accepted failure mode is a gap). This task reads `profile.base_currency` to stamp
currency, so it implements the self-heal.

**Location:** a module-level private helper in `routers/transactions.py`
(`_get_or_create_profile`). By the same first-consumer rule as the summary SQL
and the 1.3 visible-query: **transactions is the FIRST profile-reading consumer,
so the helper stays inline; the SECOND profile-reading task extracts it** (record
this trigger). It does not belong in `auth.py` (that owns the *register-time*
provisioning hook, a different lifecycle) nor in a new `services/` module.

```python
from budget_api.models import Profile
from budget_api.models.profile import DEFAULT_BASE_CURRENCY

async def _get_or_create_profile(session: AsyncSession, user_id: uuid.UUID) -> Profile:
    profile = await session.get(Profile, user_id)
    if profile is None:
        profile = Profile(user_id=user_id, base_currency=DEFAULT_BASE_CURRENCY)
        session.add(profile)
        await session.flush()   # persist within the same tx; commit rides create_transaction
    return profile
```

**Usage:** on **POST** only (the currency stamp), where a commit happens anyway —
so a self-healed profile persists atomically with the transaction. **The summary
GET does NOT create a profile** (a GET stays read-only): it does
`profile = await session.get(Profile, user_id)` and falls back to
`DEFAULT_BASE_CURRENCY` if absent — a summary for a profile-less user returns
`currency = "RUB"` without a write, and the next POST self-heals the row. PATCH
does not touch currency and does not read the profile. Coverage: the create-branch
is pinned by `test_create_self_heals_missing_profile` (delete the row, POST,
assert 201 + `currency == "RUB"` + row recreated).

## Summary SQL sketch (decision j/k — CASE aggregate + GROUP BY, in the router)

`month = "YYYY-MM"` → `month_start = date(year, mon, 1)`;
`next_month_start = date(year + (mon == 12), (mon % 12) + 1, 1)`. Half-open range
`[month_start, next_month_start)` on `occurred_at`, riding
`ix_transactions_user_id_occurred_at`.

**Totals — CASE aggregate over kind (arch §1 verdict, binding):**
```python
from sqlalchemy import case, func, select
income_sum = func.coalesce(
    func.sum(case((Transaction.kind == TransactionKind.income.value,
                   Transaction.amount_minor), else_=0)), 0)
expense_sum = func.coalesce(
    func.sum(case((Transaction.kind == TransactionKind.expense.value,
                   Transaction.amount_minor), else_=0)), 0)
income_minor, expense_minor = (await session.execute(
    select(income_sum, expense_sum).where(
        Transaction.user_id == user.id,
        Transaction.occurred_at >= month_start,
        Transaction.occurred_at < next_month_start,
    )
)).one()
net_minor = income_minor - expense_minor        # signed
```

**Breakdown — GROUP BY (feeds by_category):**
```python
rows = (await session.execute(
    select(Transaction.category_id, Transaction.kind,
           func.sum(Transaction.amount_minor).label("total_minor"))
    .where(
        Transaction.user_id == user.id,
        Transaction.occurred_at >= month_start,
        Transaction.occurred_at < next_month_start,
    )
    .group_by(Transaction.category_id, Transaction.kind)
    .order_by(Transaction.kind, func.sum(Transaction.amount_minor).desc())
)).all()
by_category = [CategorySummary(category_id=cid, kind=TransactionKind(k),
                               total_minor=t) for cid, k, t in rows]
```
Two small index-covered scans of the same per-user month slice — fine at personal
scale (decision b index verdict). The `NULL` `category_id` group is the
uncategorized bucket (Postgres `GROUP BY` puts NULLs in their own group). Empty
month → `income/expense = 0` (COALESCE), `by_category = []` → zeros response, no
404.

## Router skeleton (`routers/transactions.py`)

```python
router = APIRouter()
_NOT_FOUND = {status.HTTP_404_NOT_FOUND: {"model": TransactionError}}
# AM-5 folded at /implement: the shared 422 constant declares the RAW content-schema
# anyOf union (refs #/components/schemas/TransactionError + .../HTTPValidationError)
# so the generated POST/PATCH 422 type is honest about both runtime arms. Do NOT
# hand-declare an HTTPValidationError model (component-name mangling). TransactionError
# stays referenced by the 404 {"model": ...} so its component is still emitted.
_UNPROCESSABLE = {
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "description": "Business rule rejection (string code) or validation error",
        "content": {"application/json": {"schema": {"anyOf": [
            {"$ref": "#/components/schemas/TransactionError"},
            {"$ref": "#/components/schemas/HTTPValidationError"},
        ]}}},
    }
}

def _serialize(tx: Transaction) -> TransactionRead: ...

async def _get_or_create_profile(session, user_id) -> Profile: ...  # above

async def _validate_category(session, category_id, user_id) -> None:
    """Body category-ref policy (decision e). Only call when category_id is set
    AND non-null. load_visible → None ⇒ 422 CATEGORY_NOT_FOUND (foreign==missing,
    byte-identical); archived ⇒ 422 CATEGORY_ARCHIVED."""
    cat = await load_visible_category(session, category_id, user_id)
    if cat is None:
        raise HTTPException(422, "CATEGORY_NOT_FOUND")
    if cat.archived:
        raise HTTPException(422, "CATEGORY_ARCHIVED")

async def _load_own(session, transaction_id, user_id) -> Transaction | None:
    """user_id-scoped load; foreign/missing → None → 404 (no-oracle)."""
    return await session.scalar(
        select(Transaction).where(
            Transaction.id == transaction_id, Transaction.user_id == user_id))

@router.post("", response_model=TransactionRead, status_code=201,
             responses=_UNPROCESSABLE)
async def create_transaction(payload: TransactionCreate, user=..., session=...):
    if payload.category_id is not None:
        await _validate_category(session, payload.category_id, user.id)
    profile = await _get_or_create_profile(session, user.id)
    tx = Transaction(user_id=user.id, amount_minor=payload.amount_minor,
                     kind=payload.kind.value, currency=profile.base_currency,
                     category_id=payload.category_id, occurred_at=payload.occurred_at,
                     note=payload.note)
    session.add(tx); await session.commit(); await session.refresh(tx)
    return _serialize(tx)

@router.get("", response_model=TransactionList)
async def list_transactions(from_: date | None = Query(None, alias="from"),
                            to: date | None = Query(None, alias="to"),
                            category_id: uuid.UUID | None = None,
                            kind: TransactionKind | None = None,
                            limit: int = Query(50, ge=1, le=200),
                            offset: int = Query(0, ge=0),
                            user=..., session=...):
    filters = [Transaction.user_id == user.id]
    if from_ is not None: filters.append(Transaction.occurred_at >= from_)
    if to is not None:    filters.append(Transaction.occurred_at <= to)
    if category_id is not None: filters.append(Transaction.category_id == category_id)
    if kind is not None:  filters.append(Transaction.kind == kind.value)
    total = await session.scalar(select(func.count()).select_from(Transaction).where(*filters))
    rows = (await session.scalars(
        select(Transaction).where(*filters)
        .order_by(Transaction.occurred_at.desc(), Transaction.created_at.desc(), Transaction.id)
        .limit(limit).offset(offset))).all()
    return TransactionList(items=[_serialize(t) for t in rows], total=total or 0)

@router.get("/summary", response_model=SummaryRead)          # BEFORE /{id} (Risks)
async def summary(month: str = Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$"),
                  user=..., session=...): ...                # decision j/k

@router.patch("/{transaction_id}", response_model=TransactionRead,
              responses={**_NOT_FOUND, **_UNPROCESSABLE})
async def update_transaction(transaction_id: uuid.UUID, payload: TransactionUpdate,
                             user=..., session=...):
    tx = await _load_own(session, transaction_id, user.id)
    if tx is None:
        raise HTTPException(404, "TRANSACTION_NOT_FOUND")
    fields = payload.model_fields_set
    # NOT NULL columns: explicit null → *_REQUIRED 422 (else a bare apply 500s)
    if "amount_minor" in fields and payload.amount_minor is None:
        raise HTTPException(422, "AMOUNT_REQUIRED")
    if "kind" in fields and payload.kind is None:
        raise HTTPException(422, "KIND_REQUIRED")
    if "occurred_at" in fields and payload.occurred_at is None:
        raise HTTPException(422, "OCCURRED_AT_REQUIRED")
    # category validated ONLY when in the field set AND non-null (decision e)
    if "category_id" in fields and payload.category_id is not None:
        await _validate_category(session, payload.category_id, user.id)
    if "amount_minor" in fields: tx.amount_minor = payload.amount_minor
    if "kind" in fields:         tx.kind = payload.kind.value
    if "occurred_at" in fields:  tx.occurred_at = payload.occurred_at
    if "category_id" in fields:  tx.category_id = payload.category_id   # null clears
    if "note" in fields:         tx.note = payload.note                # null/"" clears
    await session.commit(); await session.refresh(tx)
    return _serialize(tx)

@router.delete("/{transaction_id}", status_code=204, responses=_NOT_FOUND)
async def delete_transaction(transaction_id: uuid.UUID, user=..., session=...) -> None:
    tx = await _load_own(session, transaction_id, user.id)
    if tx is None:
        raise HTTPException(404, "TRANSACTION_NOT_FOUND")
    await session.delete(tx); await session.commit()
```

## Files to create

- `apps/api/src/budget_api/schemas/transaction.py` — the DTOs above.
- `apps/api/src/budget_api/routers/transactions.py` — the router.
- `apps/api/src/budget_api/category_access.py` — extracted visibility helper.
- `apps/api/tests/test_transactions.py` — pytest suite (below).

## Files to modify

- `apps/api/src/budget_api/enums.py` — add `TransactionKind` (decision c).
- `apps/api/src/budget_api/models/transaction.py` — rebuild `kind` CHECK from
  `TransactionKind` (byte-identical to 0002). No migration edit.
- `apps/api/src/budget_api/routers/categories.py` — refactor `_load_visible` +
  the list `or_(...)` onto `category_access` (non-behavioral; existing tests
  guard it).
- `apps/api/src/budget_api/app.py` — mount:
  `app.include_router(transactions.router, prefix="/transactions", tags=["transactions"])`,
  **no `Depends(prime_rate_limit)`** (decision n). Add `transactions` to the
  `from budget_api.routers import ...` line.
- `apps/api/openapi.json` — regenerated (new `/transactions*` paths + DTOs).
- `packages/api-client/src/generated/schema.d.ts` — regenerated, same commit.

## Contract regeneration + files-to-commit-together

```bash
cd /Users/nikitazaretski/work/budget
pnpm openapi          # turbo: @budget/api#openapi -> apps/api/openapi.json,
                      # then @budget/api-client#generate -> src/generated/schema.d.ts
git add apps/api/openapi.json packages/api-client/src/generated/schema.d.ts
```
`tests/test_openapi_export.py::test_committed_schema_matches_current_app` stays
red until `openapi.json` is regenerated — the commit gate. `turbo.json` already
wires `api-client#generate` → `api#openapi` and globs `src/**` — **no root-file
edit expected** (stop-and-escalate if one appears; root files are backend-owned
but require explicit justification).

## Test plan (`tests/test_transactions.py`)

Real Postgres, class-based, `make_client`/`client`/`db_session` fixtures (names
verified in conftest.py). Register+login helper reused from the
`test_categories.py` shape. Own categories are created per-test for isolation
(not the seeds), except where a seed id is convenient.

**Binding coverage (grooming mandate):** cross-user category authz on write
(3, 10); no-oracle byte-identity for tx 404 (7, 11); summary correctness incl.
uncategorized bucket + refund case (14); extraction-refactor non-regression for
categories (existing `test_categories.py` — no new test, stated below).

`TestCreateTransaction`
1. `test_create_stamps_currency_forces_owner_and_serializes` — POST valid (own
   category, `amount_minor`, `kind`, `occurred_at`) → 201; `currency == "RUB"`
   (base stamped, no wire input); `category_id`/`kind`/`amount_minor` echoed;
   `db_session` confirms stored `user_id == caller` (forced ownership); DTO has
   no `user_id`.
2. `test_create_self_heals_missing_profile` — delete the caller's profile via
   `db_session`, POST → 201, `currency == "RUB"`, and the `profiles` row now
   exists (pins the get-or-create create-branch, 1.2 §6 binding).
3. `test_create_rejects_foreign_and_missing_category_422_identical` — userB POSTs
   with userA's `category_id`, and with a random uuid → both `422
   CATEGORY_NOT_FOUND` with **byte-identical body** (binding cross-user write
   authz + no-oracle for the category ref).
4. `test_create_rejects_archived_category` — own archived category as target →
   `422 CATEGORY_ARCHIVED` (decision e).
5. `test_create_allows_null_category_uncategorized` — `category_id: null` → 201,
   `category_id` null (the uncategorized path the summary later buckets).
6. `test_create_rejects_zero_amount` — `amount_minor: 0` → 422. **Deferred-policy
   pin (decision h, R6 analogue):** the zero-amount API bound was explicitly
   deferred from 1.2 to this task; kept in pytest so a loosened `ge=1` goes red
   in CI, not a one-time curl. Flagged for senior visibility (sits near the
   pure-Pydantic line, like `test_color_pattern_rejected`).

`TestUpdateTransaction`
7. `test_patch_cross_user_and_missing_both_404` — userB PATCH of userA's tx id,
   and a random uuid → both `404 TRANSACTION_NOT_FOUND`, **identical body**
   (no-oracle, binding; the headline security test).
8. `test_patch_null_clears_category_and_note_omitted_preserves` — `{"category_id":
   null}` → `category_id` null; `{"note": null}` clears note; omitted
   `amount_minor`/`kind` unchanged (the `model_fields_set` mechanics — the subtle
   custom logic).
9. `test_patch_null_on_not_null_fields_422` — `{"amount_minor": null}` →
   `AMOUNT_REQUIRED`; `{"kind": null}` → `KIND_REQUIRED`; `{"occurred_at": null}`
   → `OCCURRED_AT_REQUIRED`; each 422 (guards the bare-apply-500 the custom
   guards prevent).
10. `test_patch_category_validation` — (a) create tx on own category, **archive
    that category**, PATCH `amount_minor` only → **200** (category NOT
    revalidated when absent from the field set — binding decision e); (b) PATCH
    `category_id` → a foreign uuid → `422 CATEGORY_NOT_FOUND` (write authz on the
    update path).

`TestDeleteTransaction`
11. `test_delete_removes_row_and_no_oracle_404` — DELETE own tx → 204 and
    `db_session` confirms the row is gone (real delete, decision a); DELETE the
    same id again (now missing) → 404; DELETE userA's tx as userB → 404
    **identical body** (no-oracle).

`TestListTransactions`
12. `test_list_envelope_ordering_isolation_pagination` — seed several tx for
    userA across dates + one for userB; list returns `{items, total}`; `items`
    ordered `occurred_at DESC`; `total` = userA's full count; userB's row absent
    (isolation); `limit=1&offset=1` returns the 2nd row with `total` unchanged
    (pagination slice, decision b).
13. `test_list_filters_period_category_kind` — `from`/`to` inclusive bounds narrow
    to the in-range rows; `category_id` narrows to that category; `kind` narrows
    to that kind; a **foreign `category_id` filter returns empty** (READ filter
    just-filters, no existence check — decision l).

`TestSummary`
14. `test_summary_totals_uncategorized_and_refund` — **THE summary correctness
    test (binding).** In one month create: an expense tx on an expense category;
    an **income (refund) tx on that same expense category** (decision f); an
    uncategorized expense tx (`category_id` null); and a tx in a *different*
    month. Assert: `income_minor` = the refund (counted as income, not netted
    into the category's expense); `expense_minor` = the two expenses;
    `net_minor` = income − expense (signed, verify it can be negative here);
    `by_category` contains the expense-category bucket, an income bucket for the
    same `category_id` (refund), and a `category_id: null` bucket (uncategorized);
    the other-month tx is excluded (range correctness).
15. `test_summary_empty_month_returns_zeros` — **(AM-1 rewrite, folded at
    /implement):** fresh user, **delete the caller's `profiles` row via
    `db_session`** (so the fallback branch actually runs), GET summary for a month
    with no tx → 200, `income_minor=expense_minor=net_minor=0`, `by_category=[]`,
    `currency == "RUB"` (never 404 an aggregate; the read-only base-currency
    fallback for a profile-less path), **AND assert no `profiles` row exists after
    the GET** (pins the write-on-GET asymmetry — a GET never self-heals).

`TestAuth`
16. `test_requires_auth` — `GET /transactions` without a token → 401 (once per
    router, per conventions).

**NOT writing (and why):**
- `note` > 500, invalid `kind` enum value, malformed `occurred_at`/`from`/`to`
  date, malformed `month` (`2026-13`), `amount_minor` non-integer, `limit`/`offset`
  out of range — **pure Pydantic/param rejection, no custom logic on top** →
  QA-curl owns the wire behavior (grooming split, mirroring 1.3's TC-8/9/10).
- Categories extraction non-regression — **covered by existing
  `tests/test_categories.py`** (cross-user/missing 404, system 403, list merge
  all run through `load_visible_category` / `visible_categories_clause` after the
  refactor). No new categories test; the extraction is a pure move and the
  standing suite is its guard.
- 401 on every method — asserted once (test 16).
- Kind/currency/amount DB CHECK enforcement — already pinned in
  `test_core_model.py` (1.2); not re-asserted.
- Route-ordering resolution of `/summary` — proven live by tests 14/15 hitting
  the endpoint; no separate ordering test.

## Standing infra

- **Test Postgres on :5443 via `TEST_DATABASE_URL`.** `conftest.DEFAULT_TEST_DATABASE_URL`
  and the committed `docker-compose.yml` both target **5433** (foreign to the 5443
  convention), so the suite MUST run with
  `TEST_DATABASE_URL=postgresql+asyncpg://budget:budget@localhost:5443/budget_test`.
  No conftest/compose edit in this task.
- **Test command.** There is **no `Makefile`** in this repo (verified); the
  pytest-conventions `make test` maps to `pnpm --filter @budget/api test`
  (turbo `@budget/api#test` → `uv run pytest`) or, from `apps/api`,
  `TEST_DATABASE_URL=…5443… uv run pytest`. Run the FULL gate on any post-review
  fix round, including `uv run ruff format --check .` (1.3 retro standing rule —
  a nit-fix round that skips it ships unformatted files).
- **No root-file edits expected.** `turbo.json` already globs `src/**`/`tests/**`
  and wires the contract regen; `env: ["TEST_DATABASE_URL"]` is present. If
  implementation reveals a root file must change, stop and escalate.

## Risks

- **Route ordering (decision j/m).** `GET /transactions/summary` MUST be declared
  **before** any `/{transaction_id}` route so a future `GET /{transaction_id}`
  (currently omitted) cannot swallow `summary` as a UUID → 422. Today there is
  **no** `GET /{transaction_id}` (only PATCH/DELETE, different methods), so no
  live collision exists — but the summary route is placed first defensively and
  this trap is recorded against the `GET /{id}` future trigger (decision m).
- **CHECK byte-identity (decision c).** Rebuilding `models/transaction.py`'s kind
  CHECK from `TransactionKind` must emit `kind IN ('expense', 'income')`
  byte-for-byte (definition order `expense`, `income`), matching migration 0002.
  Guarded by `alembic check` / the autogenerate probe; verified at the diff gate.
  If it diverges, autogenerate wants a spurious migration — a loud signal.
- **No-oracle bodies.** Tx path 404 (`TRANSACTION_NOT_FOUND`) and body category
  422 (`CATEGORY_NOT_FOUND`) must each be byte-identical across foreign vs
  missing. Structural by construction (`_load_own` filters `user_id = me`;
  `load_visible_category` filters visible) — pinned by tests 3, 7, 11.
- **PATCH category revalidation trap.** Revalidating `category_id` on *every*
  PATCH would break an amount-only edit of a tx whose category was later
  archived. The `"category_id" in model_fields_set` guard is the fix — pinned by
  test 10a. A refactor that moves the validation outside the field-set check
  reopens this.
- **Get-or-create on a GET.** Deliberately **not** done — summary reads the
  profile and falls back to `DEFAULT_BASE_CURRENCY` without writing, so a GET
  stays side-effect-free; only POST self-heals. Recorded so a reviewer doesn't
  mistake the asymmetry for a miss.
- **Extraction non-regression.** The categories refactor is behavior-preserving;
  its only guard is the existing `test_categories.py`. If that suite is ever
  trimmed, the extracted helper loses coverage — noted.
- **Two-query summary.** Totals (CASE) + breakdown (GROUP BY) are two scans of the
  same index-covered month slice; fine at personal scale (decision b verdict).
  If a future profile shows it hot (it won't at personal cardinality), 4.1 folds
  them into one grouping-set query during the statistics extraction.

## Open questions (veto-style; defaults = recommendations, none blocking)

1. **Body category miss = 422 vs 404 (decision e).** Recommend **422
   `CATEGORY_NOT_FOUND`** — a 404 on `POST /transactions` misleads about the
   transaction resource; the category is a body reference. Veto = 404 to match
   the categories PATH precedent.
2. **`from > to` returns empty vs `422 INVALID_PERIOD` (decision l).** Recommend
   **empty** (READ filters don't error; the empty list self-evidences the bug).
   Veto = add the code + one test.
3. **Keep `test_create_rejects_zero_amount` in pytest (near-Pydantic) vs
   QA-curl-only (decision h/test 6).** Recommend **keep** — the zero-amount policy
   was deferred *to this task*; the R6 precedent kept exactly this kind of
   deferred-contract pin.
4. **`limit` default 50 / max 200 (decision b).** Recommend as stated. Veto =
   retune; envelope is unaffected.
5. **`by_category` order `kind, total_minor DESC` (decision j).** Recommend as
   stated (determinism + sensible chart default). Client may re-sort.
```
