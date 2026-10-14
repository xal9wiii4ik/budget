# Implementation Plan: pdf-reconcile (backend) — S1 llm tool-use · S2 anchors+migration+gate · S3 Alfa extractor · S4 reconcile agent · S5 evals · S6 contract

Implements `architecture.md` D-E1…D-E13 / D-B1 / D-R1…D-R6 / D-L1…D-L2 / D-M1 / D-C1 + A1–A6 as
written. Insertion points, not prose. Every place I believe the architecture is WRONG or
underspecified is a `FLAG-n` at the end — all of them are planned the architecture's way regardless,
except `FLAG-1` where the architecture contradicts a DB fact and there is nothing to plan the wrong
way (`occurred_at` is a `Date`).

## Approach (3 paragraphs)

`llm/` grows a tool loop and stays app-free. The three providers already share one `complete()`;
S1 makes `tools`/`tool_choice`/`ToolUseBlock`/`ToolResultPart` real in all three plus the fake's
replay/record store, and nothing else in the scope can start before that (both new features are
provider calls). The replay key grows ONLY when `tools` is non-empty, so the committed
`fake-fake-categorize-v1.jsonl` keeps replaying byte for byte — that fixture is the regression alarm
for the whole seam.

The Alfa extractor is the first async member of the parser family, so it gets its own registry
(`EXTRACTORS`) instead of widening `PARSERS`: membership IS "needs a provider", the two sync parser
modules stay byte-identical, and `FORMAT_IDS = (*PARSERS, *EXTRACTORS)` becomes the one tuple
`GET /formats` publishes and `FINGERPRINT_VERSIONS` is pinned against. Inside the module the split is
`text_lines(bytes)` (pypdf) → deterministic header anchors + operation lines → LLM rows → server-side
money → self-check against the anchors; the self-check is DATA on the session (the preview must show
the rows so the user can find the misread line), and only `apply`/`replace` refuse a failed one.

The reconcile agent is a pure bounded tool loop (`services/reconcile.py`) over facts the ROUTER
assembles from the ORM — exactly as `_load_candidates` already builds `TxCandidate`s today. The
deterministic matcher settles `exact` first and hands the model only what it could not settle, with
the arithmetic already done (amount/date deltas as facts). The model classifies and explains; it
never subtracts and never sees a uuid (see `FLAG-4`). Storage is a CLAIM, not last-writer-wins.

---

# Subtask order and dependencies

| # | subtask | depends on | files touched (count) |
|---|---|---|---|
| S1 | `llm/` tool-use | — | 6 src + 1 test |
| S2 | anchors + migration 0019 + apply/replace gate + balance stamp | — (parallel with S1) | 8 src + 3 test |
| S3 | Alfa extractor + registry + router upload gate | S1, S2 | 7 src + 4 test |
| S4 | `services/reconcile.py` + the two routes + claim | S1, S2 | 7 src + 3 test |
| S5 | evals (extract + reconcile) | S3, S4 | 7 evals + 1 test |
| S6 | contract regen + docs | S2, S3, S4 | 2 generated + 2 docs |

S1 and S2 are independent and may run in either order or in parallel. S3 and S4 both need S1's
providers and S2's columns; they are independent of each other. S6 is last by construction (the
contract pair must be regenerated from the final schemas in ONE commit).

---

## S1 [FULL] — `llm/` tool-use

### Modified (`apps/api/src/budget_api/llm/`)

**`types.py`**
- `ContentPart = TextPart | ToolResultPart | ToolUseBlock` — `ToolUseBlock` is reused AS a content
  part rather than a new `ToolUsePart`, because the assistant's tool_use turn and the model's
  tool_use block are the same JSON in both directions (`FLAG-3`: today an assistant turn carrying a
  tool call is INEXPRESSIBLE, so the loop could not run at all).
- `part_json` gains the arm `{"type": "tool_use", "id", "name", "input"}`.
- New `def tool_json(spec: ToolSpec) -> dict[str, Any]` → `{"name", "description", "input_schema"}`
  (architecture §5 canonical JSON) — ONE function used by the replay key and by `anthropic.py`, so
  the hashed shape and the wire shape cannot drift. Ollama re-wraps it (below).
- New `def tool_uses(response: LLMResponse) -> tuple[ToolUseBlock, ...]` beside `text_of`.
- Docstring: the "What v1 only DECLARES" paragraph is replaced (it is now false).

**`anthropic.py`**
- Drop the `if request.tools: raise LLMError("unsupported")` guard.
- `tools=[tool_json(t) for t in request.tools] or omit`,
  `tool_choice=_tool_choice(request.tool_choice)` (`None`/`"auto"` → `{"type":"auto"}` (omit when
  `tools` is empty), `"any"` → `{"type":"any"}`, `"tool:<name>"` → `{"type":"tool","name":name}`;
  unknown spelling → `LLMError("unsupported")`).
- `_message_param`: third arm for a `ToolUseBlock` part → `{"type":"tool_use","id","name","input"}`.
- `stop_reason` already passes through (`"tool_use"`); the `tool_use` block arm already exists at
  lines 109-112 and now stops being dead code.

**`ollama.py`**
- Drop the `unsupported` guard. `payload["tools"] = [{"type":"function","function":{"name","description","parameters": input_schema}}]`.
- `_messages` gains a second message shape: a message whose content holds `ToolUseBlock`s becomes
  `{"role":"assistant","content":<joined text or "">, "tool_calls":[{"function":{"name","arguments":input}}]}`;
  a message holding `ToolResultPart`s becomes one `{"role":"tool","content":<part.content>}` per part
  (Ollama has no `tool_use_id`).
- Response: `message.tool_calls[i].function.{name,arguments}` → `ToolUseBlock(id=f"ollama-{i}", ...)`,
  deterministic per response because the NEXT request's `ToolResultPart` keys the replay hash;
  `stop_reason="tool_use"` when `tool_calls` is non-empty; `arguments` that is not a dict →
  `LLMError("invalid_output")`.
- `tool_choice` is SILENTLY IGNORED (Ollama has none) — documented in the module docstring, not an
  `unsupported`, per architecture §5.

**`fake.py`**
- `request_key`: `canonical["tools"] = [tool_json(t) for t in request.tools]` and
  `canonical["tool_choice"] = request.tool_choice` **only when `request.tools`** (D-L1). Pinned by a
  test that replays the existing categorize fixture unchanged.
- `_response_json` / `_response_from_json`: serialize and restore `ToolUseBlock`s
  (`{"type":"tool_use","id","name","input"}`); today they are silently dropped — the loop's first
  recorded step would come back empty.
- `_data_document`: dispatch on the document's single top-level key — `"operations"` → categorize,
  `"lines"` → extract (S3's arm, D-E12), `"reconcile"` → the scripted loop (D-L2).
- Scripted reconcile arm (`_script`), deterministic by the number of `ToolResultPart`s ALREADY in
  `request.messages`: 0 → `ToolUseBlock("fake-1","list_unmatched_statement_rows",{})`; 1 →
  `list_unmatched_app_transactions`; ≥2 → `report_discrepancies` built from the JSON the two tool
  results carry (every open row `missing_in_app`, every open tx `extra_in_app`, `summary` fixed
  text). `stop_reason="tool_use"`. `FAIL_MARKER` anywhere in the request's text or tool-result parts
  → `LLMError("unavailable")` (one scan, so a QA row named `LLMFAIL` fails whichever step reaches it).
- The extract arm's regex and merchant rule are S3's (D-E12), added there.

**`usage.py`** — `log_call`'s `batch_size` carries lines (extract) or the step index (reconcile); only
the docstring changes.

**`errors.py`** — unchanged, no new codes (`unsupported` stays for `ImagePart` and for a `tool_choice`
spelling no provider has).

### Tests — 6 (`tests/test_llm_providers.py`, all `MockTransport`, no network)
1. Anthropic: a request with two tools and `tool_choice="auto"` puts `tools`/`tool_choice` on the
   wire in the canonical shape, and a `tool_use` content block comes back as `ToolUseBlock` with
   `stop_reason="tool_use"`.
2. Anthropic: the loop's SECOND call — an assistant message carrying a `ToolUseBlock` and a user
   message carrying a `ToolResultPart` serialize as `tool_use`/`tool_result` content blocks
   (the `FLAG-3` guard; without it the loop cannot continue a conversation).
3. Ollama: `message.tool_calls` → `ToolUseBlock`s with `ollama-0`/`ollama-1` ids and
   `stop_reason="tool_use"`; the echoed assistant turn goes out with `tool_calls` and the result as
   `{"role":"tool"}`.
4. The committed `replay/fake-fake-categorize-v1.jsonl` still answers a tool-less request — the
   replay key did not move (D-L1).
5. A `ToolUseBlock` answer round-trips through record → replay with its `input` dict intact.
6. The fake's scripted arm: three sequential calls produce rows-tool → txs-tool → terminal report,
   and `LLMFAIL` in a row description raises `unavailable`.

### Risky spots
- `anthropic.Omit`/`omit` typing: `tools` must be `omit` (not `[]`) when empty, or the SDK sends an
  empty array and the newest families refuse it.
- `_tool_choice` must emit NOTHING when `tools` is empty, or a categorize call (no tools) would start
  carrying a tool_choice and every replay fixture would miss.
- pyright strict over `message.content` blocks: the `tool_use` arm's `block.input` is
  `dict[str, object]`-ish from the SDK; `dict(block.input)` is already the cast in place.

### Estimate (agent-minutes): write 55 / gates 15 / verification 10

---

## S2 [FULL] — balance anchors, migration 0019, the apply/replace gate, the balance stamp

### New files
- `apps/api/alembic/versions/0019_pdf_reconcile.py` — revision `"0019"`, down `"0018"`, 0018's
  docstring style.

### Modified

**`enums.py`** (appended, in this order; each comment states whether its definition order renders a CHECK)
```python
class StatementSelfCheckStatus(StrEnum):      # CHECK: self_check_status_valid (0019)
    not_available = "not_available"; passed = "passed"; failed = "failed"
class StatementSelfCheckFailure(StrEnum):     # CHECK: self_check_failed_valid (0019)
    balance = "balance"; income_total = "income_total"
    expense_total = "expense_total"; date_range = "date_range"
class StatementBalanceCheck(StrEnum):         # CHECK: balance_check_valid (0019)
    not_available = "not_available"; match = "match"; mismatch = "mismatch"
class StatementReconciliationStatus(StrEnum): # CHECK: reconciliation_status_valid (0019)
    none = "none"; running = "running"; ok = "ok"; failed = "failed"
class DiscrepancyKind(StrEnum):               # NO CHECK — lives inside the reconciliation JSONB,
    missing_in_app = "missing_in_app"         # so appending is free (the TransactionSort precedent)
    extra_in_app = "extra_in_app"; amount_differs = "amount_differs"
    date_differs = "date_differs"; fx_difference = "fx_difference"
```
`none` shadows nothing (`StrEnum` member, not the builtin) but is referenced as
`StatementReconciliationStatus.none.value` everywhere.

**`services/statement_import/types.py`**
```python
@dataclass(frozen=True)
class SelfCheck:
    status: str                      # StatementSelfCheckStatus value
    failed: str | None = None        # StatementSelfCheckFailure value, iff status == failed
    expected_minor: int | None = None
    actual_minor: int | None = None  # both None for date_range (nothing numeric to show)
```
`ParsedStatement` gains `opening_balance_minor: int | None = None`,
`closing_balance_minor: int | None = None`, `self_check: SelfCheck | None = None` — defaults, so
`priorbank.py` is **not touched at all**.

**`services/statement_import/credo.py`** — keep the opening value in its own variable
(`opening_minor`) before the loop mutates `balance_minor`, then return
`opening_balance_minor=opening_minor`, `closing_balance_minor=balance_minor`,
`self_check=SelfCheck(status=StatementSelfCheckStatus.passed.value)`. Its chain still RAISES on
failure (architecture §Trade-offs) — a Credo mismatch means mis-read COLUMNS, not a model slip.

**`models/statement_import.py`** — on `StatementImport`, in migration order: the 2 anchors, the 4
self-check columns, the 3 balance columns, the 7 agent columns; 5 value CHECKs rendered from the
enums through the existing `_values()` helper plus 3 pair CHECKs written as literals:
```python
_SELF_CHECK_STATUS_VALUES = _values(*(s.value for s in StatementSelfCheckStatus))
# … the other three the same way
CheckConstraint(f"self_check_status IN ({_SELF_CHECK_STATUS_VALUES})", name="self_check_status_valid")
CheckConstraint(f"self_check_failed IS NULL OR self_check_failed IN ({_SELF_CHECK_FAILURE_VALUES})",
                name="self_check_failed_valid")
CheckConstraint("(self_check_status = 'failed') = (self_check_failed IS NOT NULL)",
                name="self_check_detail")
CheckConstraint(f"balance_check IN ({_BALANCE_CHECK_VALUES})", name="balance_check_valid")
CheckConstraint("((balance_check = 'not_available') = (app_balance_minor_at_end IS NULL)) AND "
                "((app_balance_minor_at_end IS NULL) = (balance_diff_minor IS NULL))",
                name="balance_check_pair")
CheckConstraint(f"reconciliation_status IN ({_RECONCILIATION_STATUS_VALUES})",
                name="reconciliation_status_valid")
CheckConstraint("(reconciliation_status = 'ok') = (reconciliation IS NOT NULL)",
                name="reconciliation_present")
```
Columns: `opening_balance_minor`/`closing_balance_minor` BigInteger NULL ·
`self_check_status` String(16) NOT NULL `server_default=text("'not_available'")` ·
`self_check_failed` String(16) NULL · `self_check_expected_minor`/`self_check_actual_minor` BigInteger NULL ·
`balance_check` String(16) NOT NULL `server_default=text("'not_available'")` ·
`app_balance_minor_at_end`/`balance_diff_minor` BigInteger NULL ·
`reconciliation_status` String(16) NOT NULL `server_default=text("'none'")` ·
`reconciliation_started_at`/`reconciled_at` `DateTime(timezone=True)` NULL ·
`reconciliation` `JSONB` NULL · `reconcile_provider` String(32) / `reconcile_model` String(64) /
`reconcile_prompt_version` String(32) NULL.
`source_format` stays String(32) (`alfa_pdf_v1` is 11 chars) and no index is added.

**`alembic/versions/0019_pdf_reconcile.py`** — four blocks in the architecture's order, every CHECK
string byte-identical to what the model renders, every name through
`op.f("ck_statement_imports_<name>")` (the 0013/0018 precedent):
1. `opening_balance_minor`, `closing_balance_minor`.
2. the 4 self-check columns + `self_check_status_valid`, `self_check_failed_valid`, `self_check_detail`.
3. the 3 balance columns + `balance_check_valid`, `balance_check_pair`.
4. the 7 agent columns + `reconciliation_status_valid`, `reconciliation_present`.
`downgrade()` is symmetric (CHECKs then columns, reverse order) and KEEPS every row: an
`alfa_pdf_v1` session survives as a journal row whose format the old registry no longer names.
No backfill, no data touched — unlike 0018 there is nothing to null out.

**`services/account_balances.py`** — one new function beside `account_balances`:
```python
async def account_balance_as_of(
    session: AsyncSession, user_id: uuid.UUID, account_id: uuid.UUID, as_of: date
) -> int:
    """The balance GET /accounts would show for this account on ``as_of``."""
```
Same UNION ALL of the two leg shapes, both legs filtered `Transaction.occurred_at <= as_of`, plus
`select(Account.starting_balance_minor).where(id == account_id, user_id == user_id)` — two scalars,
self-contained, so the number is the same definition `GET /accounts` publishes. Transfers (both
legs) and debt movements are INCLUDED: it is the account's balance, not a money aggregate.
**`occurred_at` is a `Date` column** (`models/transaction.py:275`, migration `0002:85`), so
`<= as_of` is exact — see `FLAG-1` for amendment A1.

**`services/statement_import/apply.py`**
- `_load_target` gains, after the `require_parsed` gate and before the account load:
  ```python
  if session_row.self_check_status == StatementSelfCheckStatus.failed.value:
      raise StatementApplyError("STATEMENT_BALANCE_MISMATCH")
  ```
  Both writes inherit it; the row PATCH, bulk-decision, replace-preview and DELETE stay allowed.
  In `_load_target` and not in the routes: the refusal must sit next to the write, inside the
  retried procedure (architecture §3).
- New private `async def _stamp_balance_check(session, user_id, account, session_row) -> None`,
  called in BOTH `apply_import` and `replace_import` after `_create_transactions` +
  `learn_categories` and before `session.commit()`:
  ```python
  if session_row.closing_balance_minor is None:
      return                                  # not_available stays, both numbers stay NULL
  await session.flush()                        # ← the pending inserts must be visible to the SUM
  app_balance = await account_balance_as_of(session, user_id, account.id, session_row.period_to)
  diff = app_balance - session_row.closing_balance_minor
  session_row.app_balance_minor_at_end = app_balance
  session_row.balance_diff_minor = diff
  session_row.balance_check = (StatementBalanceCheck.match if diff == 0
                               else StatementBalanceCheck.mismatch).value
  ```
  The `flush()` is load-bearing: `_create_transactions` only `session.add()`s, so without it the SUM
  reads the ledger as it was before the apply and every import would report a mismatch.

**`schemas/statement_import.py`** — `StatementImportRead` gains, in the architecture §7 order:
`opening_balance_minor: int | None`, `closing_balance_minor: int | None`,
`self_check_status: StatementSelfCheckStatus`, `self_check_failed: StatementSelfCheckFailure | None`,
`self_check_expected_minor: int | None`, `self_check_actual_minor: int | None`,
`balance_check: StatementBalanceCheck`, `app_balance_minor_at_end: int | None`,
`balance_diff_minor: int | None`. (The three reconciliation fields are S4's — they need
`DiscrepancyCounts`.)

**`routers/statement_imports.py`** — `_serialize` carries the nine new fields. Nothing else.

### Tests — 8
`tests/test_core_model.py`, class `TestStatementBalanceConstraints` — **2**:
1. the four new value CHECKs accept every enum value and refuse one unknown value each (raw SQL
   insert, the `TestStatementAiConstraints` shape, matching on the constraint name).
2. the three pair CHECKs: `self_check_status='failed'` with a NULL `self_check_failed` is refused,
   `balance_check='match'` with NULL numbers is refused, `reconciliation_status='ok'` with a NULL
   `reconciliation` is refused.

`tests/test_statement_balance.py` (new; the Priorbank/Credo upload helpers already live in
`tests/helpers.py`) — **6**:
3. a session whose `self_check_status='failed'` (set directly on the row) answers 422
   `STATEMENT_BALANCE_MISMATCH` to BOTH `POST /apply` and `POST /replace`, creates no transaction and
   leaves the session `parsed`; a row PATCH on it still answers 200.
4. apply stamps `balance_check='match'` + `balance_diff_minor=0` when the ledger agrees, with one
   transaction dated exactly `period_to` included in the sum (the A1 boundary, see `FLAG-1`) and one
   dated `period_to + 1 day` excluded.
5. apply stamps `mismatch` with the signed `balance_diff_minor` when an extra transaction sits inside
   the period.
6. a Priorbank apply (no closing balance in the format) leaves `balance_check='not_available'` with
   both numbers NULL.
7. `replace` stamps the same three columns in its own transaction.
8. a Credo upload's session read carries `opening_balance_minor`/`closing_balance_minor` and
   `self_check_status='passed'` (the format now exposes what it already proved).

### Risky spots
- The `flush()` above. Without it test 4 passes by accident on an empty ledger and test 5 fails.
- CHECK byte-identity: `alembic check` cannot see a CHECK on an existing table, so test 1/2 are the
  only alarm. The pair CHECKs are hand-written literals in BOTH places — copy them, do not retype.
- `balance_check_pair` must tolerate the DEFAULT state of a fresh `parsed` session
  (`not_available` + both NULL) and of a `not_available` session after apply.
- `self_check_detail` makes `status='failed'` without a `failed` value unrepresentable — the
  extractor must always set both (S3's `_self_check` returns them together).

### Estimate: write 70 / gates 25 (incl. `alembic upgrade head` + `alembic check` + a full
`downgrade base` cycle, which the suite runs anyway) / verification 15

---

## S3 [FULL] — the Alfa extractor, the registry, the upload gate

### New files
- `apps/api/src/budget_api/services/statement_import/alfa_pdf.py`
- `apps/api/tests/test_statement_alfa_extractor.py`
- `apps/api/tests/fixtures/alfa/{alfa_happy,alfa_fx,alfa_mismatch}.pdf` + `make_fixtures.py` (A2)

### `pyproject.toml` — the exact change (the engineer runs `uv add`, not now)
In `[project].dependencies`, alphabetically between `"openpyxl>=3.1.5",` and
`"pydantic-settings>=2.14.2",`:
```toml
    # Alfa-Bank PDF statements (pdf-reconcile). Pure Python, BSD, no system binaries and no
    # binary wheel — pdfplumber would pull pdfminer.six + pypdfium2 and truncates cells, and
    # plain `extract_text()` already yields one line per operation. Capped below 7.x: the text
    # extraction layout engine IS the surface this parser depends on (the apscheduler/mcp rule).
    "pypdf>=6,<7",
```
Command, from `apps/api`: `uv add 'pypdf>=6,<7'` (updates `uv.lock`; the API image's
`uv sync --frozen --no-dev` picks it up because it is a RUNTIME dependency). No dev dependency is
added anywhere — A2 keeps the fixture generator out of the project (`uv run --with fpdf2 --isolated
--no-project python -I tests/fixtures/alfa/make_fixtures.py <path-to-cyrillic.ttf>`).

### `alfa_pdf.py` — the module

```python
FORMAT_ID = "alfa_pdf_v1"
PROMPT_VERSION = "extract-alfa-v1"
PROMPT_FINGERPRINTS: dict[str, str] = {"extract-alfa-v1": "<16 hex>"}   # pinned by a test
SYSTEM_PROMPT = """…"""                                                 # A5

class StatementExtractionError(Exception):
    def __init__(self, code: str) -> None: ...   # code: invalid_output|truncated|unavailable|
                                                 # request_rejected|quota|too_many_lines|error
@dataclass(frozen=True)
class ExtractConfig:
    lines_per_call: int; concurrency: int; time_budget_seconds: float; max_lines: int

def text_lines(data: bytes) -> list[str]                       # pypdf only
async def extract_from_text(lines: Sequence[str], provider: LLMProvider, config: ExtractConfig,
                            quota: Callable[[int], bool], *, user_id: str | None = None
                            ) -> ParsedStatement
async def extract(data: bytes, provider: LLMProvider, config: ExtractConfig,
                  quota: Callable[[int], bool], *, user_id: str | None = None) -> ParsedStatement
def prompt_fingerprint() -> str
```
`quota` is a callback like `categorize`'s (the module must not import the limiter); the router builds
it. `extract` = `text_lines` + `extract_from_text`, so the suite and the evals drive TEXT and exactly
one pytest opens a PDF (D-E2).

**`text_lines`** — `PdfReader(io.BytesIO(data))`, `page.extract_text()` per page, `splitlines()`,
concatenated in page order. `except Exception` → `StatementParseError` (pypdf raises
`PdfReadError`, `DependencyError` for an encrypted file, `KeyError`/`ValueError`/`struct.error` on
corruption, and a non-PDF is any of them — a specific tuple here would be a list of pypdf internals
that moves with the library). Empty text (a scanned PDF) → `StatementParseError`.

**Anchors — the exact regexes** (searched over the HEADER REGION only: the text joined with `\n` and
cut at the first `_TABLE_HEADER_RE` match, so a description containing "Приход" can never be read as
the header's total):
```python
_DAY  = r"\d{2}\.\d{2}\.\d{4}"
#      sign · integer part with OPTIONAL space/NBSP/narrow-NBSP thousands groups · optional fraction
_NUM  = r"-?\d{1,3}(?:[   ]\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?"
_CCY  = r"[A-Z]{3}"
_TABLE_HEADER_RE = re.compile(r"^Дата\s+Примечание")                       # per LINE
_CURRENCY_RE = re.compile(rf"Валюта\s+сч[ёе]та\s+({_CCY})")
_PERIOD_RE   = re.compile(rf"(?<![А-Яа-яЁё])Период\s+({_DAY})\s*-\s*({_DAY})")
_OPENING_RE  = re.compile(rf"Баланс\s+на\s+начало\s+периода\s+({_NUM})\s+({_CCY})")
_CLOSING_RE  = re.compile(rf"Баланс\s+на\s+конец\s+периода\s+({_NUM})\s+({_CCY})")
_INCOME_RE   = re.compile(rf"(?<![А-Яа-яЁё])Приход\s+({_NUM})\s+({_CCY})")
_EXPENSE_RE  = re.compile(rf"(?<![А-Яа-яЁё])Расход\s+({_NUM})\s+({_CCY})")
```
Verified against the owner's sample (inspected with masked digits, no values copied): the header
label/value pairs WRAP in plain `extract_text()` too — `'Баланс на начало '` / `'периода <n> BYN'`,
`'Процентная ставка, '` / `'текущая d.ddd%'`, `'Дата и время '` / `'формирования выписки …'`. That is
why every anchor is searched over the JOINED text with `\s+` between label words and NOT per line
(the architecture's "label may wrap" is the normal case, not an edge case). `Период` is distinguished
from `Выписка за период` by the capital `П` plus the Cyrillic look-behind; `Баланс на конец периода`,
`Приход` and `Расход` are single lines; `Доступный остаток` / `Кредитный лимит` /
`Неснижаемый остаток` are never matched because each anchor names its own label. Any anchor missing
or unparseable → `StatementParseError`, **before any provider call** (no token spent).

**Operation lines** (D-E4) — lines AFTER the first `_TABLE_HEADER_RE` line that match
```python
_OP_RE   = re.compile(rf"^({_DAY})\s+(?P<rest>\S.*)$")
_TAIL_RE = re.compile(rf"\s({_NUM})\s+({_CCY})\s+({_NUM})\s+({_CCY})\s*$")
```
Everything else is dropped unseen: the page footer `N / N`, the repeated column-title fragments
(`Дата Примечание`, `Сумма в`, `валюте`, `счета`, `операции`), the header's own PII block. A line
matching `_OP_RE` whose `rest` does NOT end with `_TAIL_RE` → `StatementParseError` (my addition,
flagged as `FLAG-2`: it is the only way a PDF that wrapped an operation shows up as a refusal rather
than as a row with a mangled description and a sum check that fails for an unexplainable reason).

**`description` — how it is cut (D-E8)**: `rest` with the `_TAIL_RE` match removed, then
`re.sub(r"\s+", " ", s).strip()`. The whitespace collapse is deliberate and part of the `alfa:v1`
canon: a pypdf upgrade that changes the spacing INSIDE a line (trailing space before a wrap,
NBSP vs space) would otherwise re-import the user's whole history as new. Word-split artefacts
(`соглас но`, `М ария`) survive verbatim — they are single spaces already.

**`possible_transfer`**: `re.search(r"перевод", description, re.IGNORECASE)` — flags both
`Перевод средств …` and `Зачисление перевода …`. A flag, never a conversion (the Priorbank/Credo rule).

**Chunking + the prompt (D-E5, D-E9, A5)**: lines in FILE order cut into `lines_per_call` chunks;
per chunk the user message is ONE JSON document
`{"currency": "<header currency>", "lines": [{"key": "l<global index>", "text": "<operation line>"}]}`
(keys are GLOBAL line indices, so the union over chunks cannot collide); response schema per D-E5
with `additionalProperties: false` and `key` enumerated to the chunk's keys;
`asyncio.Semaphore(concurrency)`, the whole gather under `asyncio.timeout(time_budget_seconds)`.
`max_tokens = max(1024, _TOKENS_PER_LINE * len(chunk))` with `_TOKENS_PER_LINE = 150` — see
`FLAG-5` (the architecture says 80; a Cyrillic merchant name plus six fields is longer per row than
a categorize answer, which already budgets 150, and a truncation loses the whole chunk while unused
budget costs nothing).
Per-chunk retry ONCE on `invalid_output`/`truncated`; any chunk still lost, or `unavailable` /
`request_rejected` / the time budget / a non-`LLMError` exception (logged by CLASS only) →
`StatementExtractionError(<code>)`. A statement with a hole cannot pass a sum check and must not be
stored half-read. `len(lines) > config.max_lines` → `StatementExtractionError("too_many_lines")`
BEFORE the quota; `quota(len(lines))` false → `StatementExtractionError("quota")`, also before the
first call. One `log_call` per chunk call (`batch_size=len(chunk)`), plus ONE extraction summary line
(`lines=`, `chunks=`, `tail_mismatch_rows=` — a COUNT, never text; see `FLAG-6`).

**Server-side conversion and structural validity (D-E6)**, per answered line:
`Decimal(amount)` after stripping thousands separators → `to_minor_units(text, currency)`; REFUSE
(⇒ the whole extraction is `invalid_output`) a missing key, a key not in the chunk, a duplicate key,
a non-`^[A-Z]{3}$` code, `currency != header currency`, more fraction digits than
`currency_exponent(currency)`, an unparseable `dd.mm.yyyy` date, a half `original_*` pair.
`kind` from the sign, `amount_minor = abs(...)`; `original_*` kept only when
`original_currency != currency` and `abs(original_minor) > 0`, else NULL/NULL (the Credo `_pair`
rule — every non-FX Alfa row prints the same number twice);
`merchant` = model value stripped and truncated to 255, **`None` → `""`** (A5: nullable in the
schema, three-valued in the column, NEVER `None` for a sentence-shaped format);
`section = StatementSection.card.value`, `txn_date = booked_date = date`, `txn_time = None`,
`bank_category = None`, `fee_minor = 0`, `raw = {"line": <the raw operation line>}` and nothing else
(D-E4: no PII ever reaches the DB). `amount_minor == 0` → the row is DROPPED and counted in
`rows_zero_skipped` (the Priorbank/Credo rule; a zero contributes 0 to every sum, so the self-check
is unaffected). `row_index` is assigned over the KEPT rows in file order.

**Self-check (D-E7)** — data, in this order, first failure wins:
| order | `failed` | expectation | expected_minor | actual_minor |
|---|---|---|---|---|
| 1 | `balance` | `opening + Σ signed == closing` | `closing` | `opening + Σ signed` |
| 2 | `income_total` | `Σ income == Приход` | `Приход` | `Σ income` |
| 3 | `expense_total` | `Σ expense == abs(Расход)` | `abs(Расход)` | `Σ expense` |
| 4 | `date_range` | every row date ∈ `[period_from; period_to]` | `None` | `None` |
Pass → `SelfCheck(status="passed")`. The statement is returned either way; `apply`/`replace` refuse a
`failed` one (S2).

### Modified
- **`services/statement_import/__init__.py`** — `PARSERS` byte-identical; new
  ```python
  class AsyncExtractor(Protocol):
      async def __call__(self, data: bytes, provider: LLMProvider, config: ExtractConfig,
                         quota: Callable[[int], bool], *, user_id: str | None = None
                         ) -> ParsedStatement: ...
  EXTRACTORS: Mapping[str, AsyncExtractor] = {alfa_pdf.FORMAT_ID: alfa_pdf.extract}
  FORMAT_IDS: tuple[str, ...] = (*PARSERS, *EXTRACTORS)
  ```
  `__all__` grows by three names. This module now imports `llm` — still no app, no DB.
- **`services/statement_import/fingerprint.py`** — `FINGERPRINT_VERSIONS[alfa_pdf.FORMAT_ID] = "alfa:v1"`.
- **`ai_gate.py`** — new `async def require_llm_provider(request: Request) -> None`: 503
  `AI_NOT_CONFIGURED` when `request.app.state.llm is None` (the EXISTING `require_ai_configured`
  checks `anthropic_api_key`, which is empty under `LLM_PROVIDER=fake|ollama`). Same code string, so
  the web's existing copy applies (A6).
- **`config.py`** — a new block after the categorize block (~line 158):
  `extract_lines_per_call: int = 60`, `extract_concurrency: int = 4`,
  `extract_time_budget_seconds: int = 60`, `extract_max_lines: int = 2000`,
  `extract_daily_line_quota: str = "3000/day"`. (S4 adds the reconcile block.) No model knob —
  `app.state.llm` is ONE provider with ONE model (D-E11).
- **`routers/statement_imports.py`**
  - `_row_quota(request, settings, user_id)` → `_row_quota(request, settings, user_id, *,
    namespace: str, quota: str)`; the categorize call site passes
    `namespace="categorize", quota=settings.categorize_daily_row_quota`, the extraction call site
    `namespace="extract", quota=settings.extract_daily_line_quota`. One closure, two budgets.
  - `create_statement_import` gate order (D-E10), the ONLY change to the handler's shape:
    ```
    account → size → format ∈ FORMAT_IDS (else 422 STATEMENT_FORMAT_UNKNOWN)
      → if format in EXTRACTORS:  provider (app.state.llm is None → 503 AI_NOT_CONFIGURED)
                                  → extract (quota inside, see the table)   # async
        else:                      PARSERS[format](data)                     # unchanged
      → currency → fingerprints → match → suggestions → categorize (A3) → store
    ```
  - New `_extraction_failed(exc: StatementExtractionError) -> HTTPException` — the decision table:
    | code | answer |
    |---|---|
    | `too_many_lines` | 422 `STATEMENT_TOO_LARGE` (reused) |
    | `quota` | 429 `{"detail": "RATE_LIMITED"}` |
    | `unavailable` | 503 `AI_UNAVAILABLE` |
    | `invalid_output` · `truncated` · `request_rejected` · `error` | 422 `STATEMENT_EXTRACTION_FAILED` |
    `StatementParseError` keeps answering 422 `STATEMENT_PARSE_FAILED`.
  - `list_statement_formats` returns `list(FORMAT_IDS)`.
  - The upload's `responses` gains 503 (`AI_NOT_CONFIGURED` / `AI_UNAVAILABLE`).
  - A3: the categorize pass runs AFTER the extraction exactly as it does after a parser — two
    provider passes per Alfa upload, `ai_status` keeps its meaning, and both run BEFORE the `try`
    so the IntegrityError retry spends nothing.
- **`llm/fake.py`** — the `"lines"` arm (D-E12): per line the regex
  `^(dd.mm.yyyy) (.+?) (-?[\d.]+) ([A-Z]{3}) (-?[\d.]+) ([A-Z]{3})$`, merchant = the tail after
  `Покупка товара / получение услуг ` else `null`; `LLMFAIL` → `unavailable`. A fake answering a
  known layout, not a second extractor.
- **`docs/backend.md`** — the `llm/` bullet's "`tools`/`ToolUseBlock` declared for pdf-reconcile,
  unimplemented in v1 → `LLMError("unsupported")`" sentence is now FALSE (S1 broke it, S3 relies on
  it): fix it in this pass. The `services/statement_import/` bullet's "реестр `PARSERS` … второй банк
  = новый модуль + строка реестра" gains the `EXTRACTORS`/`FORMAT_IDS` sentence.

### Tests — 10 (8 new + 2 edited)
`tests/test_statement_alfa_extractor.py`, driving TEXT built by a new
`tests/helpers.build_alfa_statement_text()` (hand-written like `build_credo_xlsx` — a fixture a human
can review, holding every trap at once: the wrapped opening-balance label, a negative `Расход`, a
trailing-zero-dropped amount, an integer amount, a zero-turnover line, an FX pair, a same-currency
pair, a card purchase, an ERIP line, a long `Зачисление` whose description contains three inner
dates and a `№`, a `Перевод` line, the repeated page-2 column header and a `N / N` footer) — **7**:
1. happy path with `FakeProvider("fake")`: rows in file order with kind from the sign, the FX pair
   kept and the same-currency pair dropped, the merchant isolated, the description cut and collapsed,
   `possible_transfer` on both wordings, the zero row counted in `rows_zero_skipped`, anchors on the
   statement, `self_check.status == "passed"`.
2. the wrapped `Баланс на начало` / `периода …` label is read (THE regex trap — this is the one case
   a per-line anchor search would silently miss, and it is the shape the real file has).
3. a missing/unreadable anchor → `StatementParseError` and ZERO provider calls (counting fake).
4. a statement whose rows do not add up to the closing balance → `self_check.failed == "balance"`
   with both numbers, and the statement is still RETURNED with all its rows.
5. a structurally unusable answered row (a foreign currency code, three decimals in a 2-exponent
   currency, an unknown key) → `StatementExtractionError("invalid_output")`, nothing half-built.
6. chunk boundary: 61 lines with `lines_per_call=60` → 2 calls, the union validated, `row_index`
   contiguous and `l*` keys not colliding across chunks.
7. `LLMFAIL` in a line → `StatementExtractionError("unavailable")`.
`tests/test_statement_alfa_extractor.py::TestAlfaPdf` — **1**:
8. the ONE pypdf test: `tests/fixtures/alfa/alfa_happy.pdf` → `text_lines` yields one line per
   operation, and `extract` end-to-end produces the same rows as the text fixture does.
`tests/test_statement_imports_api.py` — **1 new + 2 edited**:
9. (new) uploading `alfa_pdf_v1` to a server with `app.state.llm is None` answers 503
   `AI_NOT_CONFIGURED` and stores nothing, while a Priorbank CSV upload on the SAME server still
   answers 201 (the gate is per format, not per server).
10. (edited) `test_formats_are_the_parser_registry_in_registry_order` compares against `FORMAT_IDS`;
    `tests/test_statement_matching.py:335` becomes `set(FINGERPRINT_VERSIONS) == set(FORMAT_IDS)`.
Plus **1** fingerprint pin in test 1's file: `PROMPT_FINGERPRINTS[PROMPT_VERSION] ==
prompt_fingerprint()` (the categorize precedent). Total 10 new assertions-of-record.

### Risky spots
- **The anchor region cut.** Searching the WHOLE text would let an operation description carrying
  "Приход"/"Расход" (a free-text `Зачисление`) become the header total. Cut at the first table
  header, always.
- **`_NUM`'s thousands groups.** The sample's largest amount has four digits with no separator, so
  whether Alfa groups thousands is UNKNOWN. Accepting optional space/NBSP groups is free in the
  anchors and in `_TAIL_RE`; NOT accepting them would turn the first five-figure salary into a
  `StatementParseError`. The server strips them before `to_minor_units`.
- **Fingerprint stability.** `alfa:v1`'s canon takes `description` (collapsed) and the model's
  numbers. A model that misreads one digit produces a different `client_id` AND a failed self-check —
  the second is the alarm, the first is why a re-upload after a model change can double-import. This
  is the strongest argument for `FLAG-6`.
- **pypdf's exception surface** — see `text_lines` above; a narrow tuple will leak a 500.
- **`extract_time_budget_seconds=60` + the 10/min upload limit** keeps the handler bounded, but an
  Alfa upload is now TWO provider passes (extract 60 s + categorize 45 s worst case). QA should time
  one 400-line upload against the fake.

### Estimate: write 90 / gates 20 / verification 20

---

## S4 [FULL] — `services/reconcile.py`, the two routes, the claim

### New files
- `apps/api/src/budget_api/services/reconcile.py`
- `apps/api/tests/test_reconcile.py` (pure, no DB)
- `apps/api/tests/test_statement_reconcile_api.py`

### `services/reconcile.py` — the module (pure: `llm`, `domain`, `enums`, `matching`, stdlib)

```python
PROMPT_VERSION = "reconcile-v1"
PROMPT_FINGERPRINTS: dict[str, str] = {"reconcile-v1": "<16 hex>"}
SYSTEM_PROMPT = """…"""                                  # demands ending with the terminal tool
MAX_EXPLANATION_CHARS = 300
MAX_SUMMARY_CHARS = 1000

@dataclass(frozen=True)
class RowFact:                     # one statement row, as the agent sees it
    id: uuid.UUID; row_index: int; client_id: uuid.UUID
    txn_date: date; booked_date: date; kind: str; amount_minor: int; currency: str
    original_amount_minor: int | None; original_currency: str | None
    description: str; merchant: str | None

@dataclass(frozen=True)
class TxFact:
    id: uuid.UUID; occurred_at: date; kind: str; amount_minor: int; currency: str
    merchant: str | None; note: str | None; is_transfer: bool; is_debt_movement: bool

@dataclass(frozen=True)
class ReconcileConfig:
    max_steps: int; max_total_tokens: int; time_budget_seconds: float; max_items_per_side: int

@dataclass(frozen=True)
class Pair:                        # the arithmetic, done by the SERVER
    row_id: uuid.UUID; transaction_id: uuid.UUID
    amount_delta_minor: int; date_delta_days: int

@dataclass(frozen=True)
class Prematch:
    settled: tuple[tuple[uuid.UUID, uuid.UUID], ...]
    open_rows: tuple[RowFact, ...]; open_transactions: tuple[TxFact, ...]
    pairs: tuple[Pair, ...]

@dataclass(frozen=True)
class Discrepancy:
    kind: str; row_id: uuid.UUID | None; transaction_id: uuid.UUID | None; explanation: str

@dataclass(frozen=True)
class Report:
    version: str; settled_exact: int; open_rows: int; open_transactions: int
    items: tuple[Discrepancy, ...]; counts_by_kind: Mapping[str, int]
    unmentioned_rows: int; unmentioned_transactions: int; summary: str

@dataclass(frozen=True)
class ReconcileOutcome:
    report: Report | None; calls: list[Usage]; steps: int; aborted_reason: str | None

def prematch(rows: Sequence[RowFact], candidates: Sequence[TxCandidate]) -> Prematch
async def reconcile(provider: LLMProvider, pre: Prematch, config: ReconcileConfig, *,
                    period_from: date, period_to: date, currency: str,
                    user_id: str | None = None) -> ReconcileOutcome
def report_json(report: Report) -> dict[str, Any]
def report_from_json(payload: Mapping[str, Any]) -> Report | None
def prompt_fingerprint() -> str
```

**`client_id` rides ON `RowFact`** rather than as a parallel sequence — `match_rows` needs rows and
client_ids positionally aligned, and one aligned sequence cannot be mis-zipped. `prematch` converts
each `RowFact` into a throwaway `ParsedRow` internally (`_as_parsed`: `raw={}`, `fee_minor=0`,
`section=card`, `txn_time=None`, `bank_category=None`, `possible_transfer=False` — `match_rows` reads
only `row_index/txn_date/booked_date/kind/amount_minor/description`), calls
`matching.match_rows(...)` UNCHANGED, and then: `exact` → `settled`; `similar` and `new` → OPEN.
This answers the architecture's open question about `row_to_parsed`'s home — **there is no public
ORM-reading helper at all**: the ROUTER builds `RowFact`s from `StatementImportRow`s (its established
job — `_load_candidates` already builds `TxCandidate`s from ORM rows in that very file), and
`types.py` stays ORM-free. `pairs` = for every open row, every open tx of the SAME kind within
±`RECONCILE_PAIR_WINDOW` (3 days) of `txn_date`, with the two deltas computed here.

**`reconcile` — the loop.** Three tools (D-R2): `list_unmatched_statement_rows` and
`list_unmatched_app_transactions` (`{"type":"object","properties":{},"additionalProperties":false}`)
and the terminal `report_discrepancies`. `tool_choice="auto"`. First user message = ONE document
`{"reconcile": {"period": [from, to], "currency": ..., "settled_exact": n, "open_rows": n,
"open_transactions": n}}` — METADATA only; the lists arrive through the tools, which is what makes
the loop a loop and what the fake's step counter keys on.
```
for step in 1..max_steps:
    response = await provider.complete(LLMRequest(system=SYSTEM_PROMPT, messages=tuple(messages),
                                       max_tokens=_max_tokens(pre), tools=TOOLS, tool_choice="auto"))
    log_call(..., batch_size=step); calls.append(usage); total_tokens += in + out
    response.stop_reason == "max_tokens"      -> abort "truncated"
    uses = tool_uses(response); not uses      -> abort "invalid_output"   (a loop ending in text)
    terminal present                          -> validate -> Report, return
    total_tokens > max_total_tokens           -> abort "tokens"
    messages += assistant(uses) + user(ToolResultPart per use)
else:                                          abort "steps"
```
Wrapped in `asyncio.timeout(time_budget_seconds)` → `time_budget`; `LLMError` → its own code
(`unavailable`/`request_rejected`/`invalid_output`/`truncated`); a non-`LLMError` exception → `error`,
logged by CLASS only. **Never raises.** An unknown tool name in a `ToolUseBlock` is answered with a
`ToolResultPart(is_error=True)` and the loop continues (it costs one step, and refusing would turn a
model typo into a failed reconciliation). `_max_tokens(pre) = min(16384, max(2048, 60 *
(len(open_rows) + len(open_transactions))))`.

**Terminal validation (D-R4) — the decision table** (invalid items are DROPPED and counted in one log
line; the valid ones survive):
| `kind` | `row_id` | `transaction_id` | |
|---|---|---|---|
| `missing_in_app` | must name an OPEN row | must be absent/null | else drop |
| `extra_in_app` | must be absent/null | must name an OPEN tx | else drop |
| `amount_differs` · `date_differs` · `fx_difference` | OPEN row | OPEN tx | else drop |
Plus: unknown `kind` → drop; `explanation` stripped, empty → drop (the item's whole value IS the
explanation), else truncated to 300; one item per `(row, tx)` pair, FIRST wins; `summary` stripped
and truncated to 1000, absent → `""`. `counts_by_kind` (five keys, always present) and the two
`unmentioned_*` numbers are computed BY THE SERVER from the surviving items.

**`report_json` / `report_from_json`** are the two directions of the `reconciliation` JSONB, both
here so the stored shape has ONE definition; `report_from_json` returns `None` for a payload it
cannot read (a report written by a future `reconcile-vN`), and the route then answers `status='ok'`
with `items: []` plus a WARNING log rather than a 500.

### Modified
- **`config.py`** — `reconcile_max_steps: int = 8`, `reconcile_max_total_tokens: int = 60_000`,
  `reconcile_time_budget_seconds: int = 60`, `reconcile_max_items_per_side: int = 300`,
  `reconcile_rate_limit: str = "3/minute;10/day"`.
- **`rate_limit.py`** — `def reconcile_limit_value() -> str` + `reconcile_rl_key = user_rl_key("reconcile")`.
- **`schemas/statement_import.py`** —
  ```python
  class DiscrepancyCounts(BaseModel):     # five ints, never null
      missing_in_app: int; extra_in_app: int; amount_differs: int
      date_differs: int; fx_difference: int
  class StatementDiscrepancy(BaseModel):
      kind: DiscrepancyKind; row_id: uuid.UUID | None; transaction_id: uuid.UUID | None
      explanation: str
  class StatementReconciliationRead(BaseModel):
      import_id: uuid.UUID; status: StatementReconciliationStatus; reconciled_at: datetime | None
      provider: str | None; model: str | None; prompt_version: str | None
      settled_exact: int; open_rows: int; open_transactions: int
      counts: DiscrepancyCounts; unmentioned_rows: int; unmentioned_transactions: int
      items: list[StatementDiscrepancy]; summary: str | None
  ```
  `StatementImportRead` gains `reconciliation_status: StatementReconciliationStatus`,
  `reconciled_at: datetime | None`, `reconciliation_counts: DiscrepancyCounts | None` (null unless
  `ok`) and `reconciliation_summary: str | None` (A4).
- **`routers/statement_imports.py`**
  - `_candidate_window(statement)` → `_candidate_window(period_from: date, period_to: date,
    dates: Iterable[tuple[date, date]], *, widen: timedelta = SIMILAR_WINDOW)`; the upload passes
    `((r.txn_date, r.booked_date) for r in statement.rows)`, the reconcile route passes the stored
    rows' pairs with `widen=RECONCILE_PAIR_WINDOW` (3 days). ONE window function, two callers.
  - `_load_candidates` is split: a new `_load_account_tx_views(session, user_id, account_id, since,
    until) -> list[_AccountTxView]` does the query and resolves the transfer LEG ONCE (`_AccountTxView`
    = a NamedTuple with `id, client_id, kind, amount_minor, currency, occurred_at, merchant, note,
    is_transfer, is_debt_movement`; the counter leg becomes an income of `counter_amount_minor` in
    `counter_currency`, exactly as today), and `_load_candidates` becomes a two-line adapter building
    `TxCandidate`s from it. The leg logic — the thing `docs/backend.md` calls out — stays in ONE
    place, and the upload path's behaviour is pinned by the existing tests.
  - New `_row_fact(row: StatementImportRow) -> RowFact` and `_tx_fact(view) -> TxFact`.
  - New `async def _stash_rl_user_jwt(request, user = Depends(current_active_user)) -> User` (the
    `/push` precedent: `current_active_user` imported straight from `auth.py`, so a PAT can never
    reach these two routes even if the allowlist derivation ever changed).
  - `POST /{import_id}/reconcile` → `response_model=StatementReconciliationRead`, dep order
    `_stash_rl_user_jwt` → `Depends(require_llm_provider)` (401 before 503), the
    `reconcile_rate_limit` decorator, `responses` = 404/409/422/429/503. Body: none.
  - `GET /{import_id}/reconciliation` → `StatementReconciliationRead`, `responses={**_NOT_FOUND}`;
    a session never reconciled answers 200 with `status='none'`, empty counts and `items: []`
    (D-R5 — a second 404 would be a second code path for one resource). Declared next to the other
    `/{import_id}/…` routes (after `/formats`, so no route-order landmine).
  - `# MCP: no — escalation surface` on both, and `tests/test_pat_auth.py::NEVER_PAT` gains
    `("POST", "/statement-imports/{import_id}/reconcile")` and
    `("GET", "/statement-imports/{import_id}/reconciliation")`.
  - `_serialize` carries the four A4/D-R5 fields, reading them out of the JSONB through
    `report_from_json`.

**The POST handler, in order** (the only place where the sequencing matters):
```python
session_row = await _load_own(...)            # 404 IMPORT_NOT_FOUND, no-oracle; ANY status is fine
rows   = <stored rows, ordered by row_index>  # -> RowFact[]
since, until = _candidate_window(session_row.period_from, session_row.period_to,
                                 ((r.txn_date, r.booked_date) for r in rows),
                                 widen=RECONCILE_PAIR_WINDOW)
views  = await _load_account_tx_views(session, user.id, session_row.account_id, since, until)
pre    = prematch([_row_fact(r) for r in rows], [_candidate(v) for v in views])
if max(len(pre.open_rows), len(pre.open_transactions)) > settings.reconcile_max_items_per_side:
    raise _unprocessable("RECONCILIATION_TOO_LARGE")        # before any call
claimed = await session.scalar(
    update(StatementImport)
    .where(StatementImport.id == import_id, StatementImport.user_id == user.id,
           or_(StatementImport.reconciliation_status != StatementReconciliationStatus.running.value,
               StatementImport.reconciliation_started_at
                   < datetime.now(UTC) - timedelta(seconds=2 * settings.reconcile_time_budget_seconds)))
    .values(reconciliation_status=StatementReconciliationStatus.running.value,
            reconciliation_started_at=datetime.now(UTC))
    .returning(StatementImport.id))
await session.commit()                        # COMMITTED before the loop (the receipts claim)
if claimed is None:
    raise HTTPException(409, detail="RECONCILIATION_RUNNING")
outcome = await reconcile(provider, pre, ReconcileConfig(...from settings...),
                          period_from=..., period_to=..., currency=session_row.statement_currency,
                          user_id=str(user.id))
# one more short transaction, whatever happened:
#   report  -> status ok,     reconciliation = report_json(...), reconciled_at = now, trio stamped
#   else    -> status failed, reconciliation = None,             reconciled_at = now, trio stamped
await session.commit()
if outcome.report is None:
    raise HTTPException(503, "AI_UNAVAILABLE") if outcome.aborted_reason == "unavailable" \
          else _unprocessable("RECONCILIATION_FAILED")
return <the same full read the GET returns>
```
`reconciliation_started_at` is NULL while the status is `none`, and `NULL < x` is NULL — the `!=
'running'` arm is what covers that row, which is why the two conditions are OR'd in that order. The
existence gate runs BEFORE the claim so that "zero rows updated" can only mean "already running".
A later run OVERWRITES (`reconciliation_present` keeps `ok` ⇔ JSONB non-null, so the `failed` arm
must NULL the column).

### Tests — 12
`tests/test_reconcile.py` (pure, stub/fake providers, no DB) — **7**:
1. `prematch` settles `exact` by `client_id` and by value, keeps `similar` OPEN, and emits pairs with
   the right `amount_delta_minor`/`date_delta_days` signs.
2. the fake's scripted loop produces a report naming every open row `missing_in_app` and every open
   tx `extra_in_app`, with `counts_by_kind`, `unmentioned_rows`/`unmentioned_transactions` and
   `settled_exact` all consistent with the prematch.
3. terminal validation: an unknown kind, a foreign row id, a `missing_in_app` carrying a transaction
   id, a duplicate `(row, tx)` pair and an empty explanation are all dropped; the valid items and the
   server-computed counts survive.
4. `max_steps` exhausted (a stub that always calls a list tool) → `aborted_reason="steps"`,
   `report is None`, and `len(calls) == max_steps`.
5. the token budget: a stub reporting a huge usage aborts with `tokens` after the first step.
6. the time budget: a sleeping stub aborts with `time_budget` and never raises.
7. `PROMPT_FINGERPRINTS[PROMPT_VERSION] == prompt_fingerprint()`.

`tests/test_statement_reconcile_api.py` (real Postgres, `make_llm_client(FakeProvider("fake"))`) — **5**:
8. POST answers 200 with the full read; `GET /{id}` then carries `reconciliation_status='ok'`,
   `reconciliation_counts` and `reconciliation_summary`; `GET /{id}/reconciliation` returns the items
   with resolvable row and transaction ids.
9. a second POST while `running` → 409 `RECONCILIATION_RUNNING`; after back-dating
   `reconciliation_started_at` past 2× the budget the re-claim succeeds (the crash-recovery arm).
10. `LLMFAIL` in a row description → `reconciliation_status='failed'`, `reconciliation IS NULL`, the
    provider/model/prompt trio stamped, and the POST answers 503 `AI_UNAVAILABLE`.
11. `llm=None` → 503 `AI_NOT_CONFIGURED` and NOTHING claimed (the status stays `none`); a session
    that was never reconciled answers `GET /{id}/reconciliation` 200 with `status='none'` and
    `items: []`, and a foreign id answers 404 `IMPORT_NOT_FOUND` on both routes.
12. `reconcile_max_items_per_side=1` → 422 `RECONCILIATION_TOO_LARGE` before any provider call
    (counting fake), nothing claimed.

### Risky spots
- **The request session is held across the loop** (up to 60 s of a pooled connection). The
  `3/minute;10/day` limit and the 60 s budget bound it; the receipts parse route holds its session
  the same way. If a QA run shows pool starvation, the fix is a fresh sessionmaker for the write-back,
  not a different design.
- **`report_from_json` on the read path.** `reconciliation` is `dict[str, Any]` under pyright strict;
  every field needs an isinstance guard, and a `None` return must be a WARNING log plus an empty
  read, never a 500.
- The claim's `UPDATE … RETURNING` must be committed before the loop, or a parallel POST sees no
  claim and both loops run.
- `prematch`'s throwaway `ParsedRow`s must not leak out of the module — `Prematch` carries `RowFact`s.

### Estimate: write 95 / gates 20 / verification 20

---

## S5 [STANDARD] — evals: extraction and reconciliation

### Approach
`run.py` keeps its CLI and every public name (so `tests/test_evals_regression.py`'s existing three
tests are untouched) and the shared machinery moves into `evals/common.py` — provider building,
`replay_file`, `replay_header`, percentiles, `_slug`, the report writer, the `_text`/`_integer`/
`_object` JSON readers — which `run.py` re-exports from its old names. Two new runners and two
seeded generators join it; both report into `evals/reports/` with `synthetic: true` for the fake.

### New files
- `evals/common.py` — the lift described above (no behaviour change).
- `evals/gen_alfa.py` — `--seed --statements N [--mismatch-share 0.0]` →
  `dataset/synthetic-alfa-v1/statements.jsonl`, one object per statement:
  `{id, currency, period: [from,to], opening_minor, closing_minor, income_minor, expense_minor,
  lines: [...], gold_rows: [{key, date, kind, amount_minor, original_amount_minor,
  original_currency, merchant}], expect_self_check: "passed"|"failed"}`.
  **Anchors are consistent BY CONSTRUCTION**: the rows are generated first (seeded `random.Random`,
  invented merchants, ~15 % income, ~10 % FX pairs, a mix of 2-decimal / 1-decimal /
  integer amounts), then `income_minor = Σ income`, `expense_minor = Σ expense`,
  `opening_minor` is drawn and `closing_minor = opening + income − expense` is COMPUTED — never
  written independently, so a generated statement can only fail the self-check on purpose.
  `--mismatch-share` seeds exactly one defect per affected statement by DROPPING a line from `lines`
  while leaving it in the sums (`expect_self_check: "failed"`), which is what the self-check exists
  to catch. The line renderer lives here and is reused by `tests/fixtures/alfa/make_fixtures.py`
  (A2); the pytest text fixture is hand-written in `tests/helpers.py` because it must hold traps the
  generator never emits.
- `evals/extract.py` — text → `alfa_pdf.extract_from_text` with `quota=lambda n: True` → per-field
  accuracy (date / amount / currency / original pair / merchant), row-count exact rate, self-check
  precision/recall against `expect_self_check`; report
  `reports/extract-<provider>-<model>-extract-alfa-v1.{md,json}`.
- `evals/gen_reconcile.py` — `--seed --cases N` → `dataset/synthetic-reconcile-v1.jsonl`:
  `{id, period, currency, rows: [...], transactions: [...], gold: [{kind, row_key, transaction_key}]}`.
  The transactions start as a COPY of the rows and a seeded RNG applies one perturbation per case
  family — drop a tx (`missing_in_app`), add one (`extra_in_app`), change an amount
  (`amount_differs`), shift a date by 1–3 days (`date_differs`), change the FX original
  (`fx_difference`) — the untouched rest being what `prematch` must settle. `gold` is written FROM
  the perturbation log, so it cannot disagree with what was done.
- `evals/reconcile.py` — precision/recall per kind over `(kind, row, transaction)` triples plus the
  settled count and the step/token usage; report `reports/reconcile-<provider>-<model>-reconcile-v1.{md,json}`.
- `evals/replay/{fake-fake-extract-alfa-v1,fake-fake-reconcile-v1}.jsonl` — recorded NOW with
  `--mode record` against the fake, provenance header first line.
- `evals/README.md` — two new sections (the two runners, their generators, "the numbers below are the
  fake's") and the same "no figure may be quoted until a live run" rule.

### Risky spots
- The fake must NOT be an oracle, and must not be tuned to look good (ruling R3 of ai-layer): the
  extract fake is a regex over the generator's own layout, so it will score ~100 % on field accuracy
  — the report says so in its first lines, and the FLOOR in the regression test is "what the fake
  scores", not a quality bar. The reconcile fake reports everything as missing/extra, so recall on
  those two kinds is 100 % and precision is low; the three `*_differs` kinds score 0.
- Replay keys embed the prompt and the schema: editing either invalidates both new fixtures, which is
  the intended loud failure (re-record + bump the version).
- `common.py` must not change `run.py`'s behaviour — the existing three regression tests are the guard.

### Tests — 3 (`tests/test_evals_regression.py`, extended)
1. the extract replay run scores exactly what an in-process fake run scores and clears
   `EXTRACT_MIN_ACCURACY`; a missing fixture raises `EvalError` naming the unanswered rows.
2. the reconcile replay run scores exactly what an in-process fake run scores and clears
   `RECONCILE_MIN_RECALL`.
3. generator integrity: every generated statement's anchors equal the sums of its own `gold_rows`
   (so a `passed` case can only fail on the extractor), and every `gold` triple of a reconcile case
   corresponds to a perturbation actually applied.

### Estimate: write 60 / gates 15 / verification 15

---

## S6 [STANDARD] — contract pair + docs

- `pnpm openapi` from the repo root → `apps/api/openapi.json` +
  `packages/api-client/src/generated/schema.d.ts`, **one commit** (the drift test enforces it).
  `schema.d.ts` is never hand-edited.
- Consumer gates: `pnpm --filter @budget/api-client test` (drift) and `pnpm --filter @budget/shared
  test`. `@budget/web typecheck` is expected GREEN: every new field is additive and the one web module
  that constructs a session object takes a `Partial` (`features/imports/aiStatusLine.test.ts`); the
  bank picker fills itself from `GET /formats`, so `alfa_pdf_v1` needs no web release (a human NAME
  for it, the self-check banner, the balance line and the reconciliation screen are the web scope's).
- `docs/backend.md`: the `/statement-imports` bullet (the two new routes, the gate order, the five new
  codes, the self-check/balance/reconciliation fields), the `llm/` bullet (tool-use is real — already
  fixed in S1/S3), `ai_gate.py` (`require_llm_provider`), `services/` (`alfa_pdf.py`,
  `reconcile.py`, `account_balances.account_balance_as_of`), the migrations list (`0019`), the error
  envelope (`STATEMENT_EXTRACTION_FAILED`, `STATEMENT_BALANCE_MISMATCH`, `RECONCILIATION_FAILED`,
  `RECONCILIATION_TOO_LARGE`, `RECONCILIATION_RUNNING`, `AI_UNAVAILABLE`).
  `docs/conventions.md` §LLM calls: the seam is no longer structured-output-only.
  (Scope-close doc ownership stays `senior-lead`'s; what S1/S3 broke, S1/S3 fix in-pass.)
- `.env` lines for the orchestrator: **none required.** Defaults keep `app.state.llm is None`, so
  `alfa_pdf_v1` uploads answer 503 and `GET /formats` still lists it honestly. A QA stand demo needs
  `LLM_PROVIDER=fake`; a live run needs `ANTHROPIC_API_KEY` (shared with receipts/advisor) or
  `LLM_PROVIDER=ollama`.

### Estimate: write 15 / gates 25 / verification 10

---

# Gates (per subtask, from `apps/api` unless noted)
`uv run ruff check . && uv run ruff format --check .` · `uv run pyright` · `uv run pytest` ·
(S2) `uv run alembic upgrade head && uv run alembic check` · (S3) `uv add 'pypdf>=6,<7'` then the
above · (S6) `pnpm openapi` from the root + the two consumer filters.
Review tier is FULL for S1–S4 (migration, money math, external integration, contract) — the
code-reviewer stage runs, so no `/review-pr` self-review is owed there; S5 and S6 are STANDARD and
DO owe it.

---

# FLAGS — where the architecture is wrong or underspecified

**FLAG-1 (architecture WRONG — amendment A1).** A1 says "`transactions.occurred_at` is a tz-aware
DATETIME — the cutoff is `occurred_at < (as_of + 1 day) at 00:00 UTC`, never `occurred_at <= as_of`
(that drops every row of the last day). Pin with one test row dated `period_to 23:59`."
`occurred_at` is a **`Date`** column (`models/transaction.py:275`:
`occurred_at: Mapped[date] = mapped_column(Date)`; `alembic/versions/0002_core_tables.py:85`:
`sa.Column("occurred_at", sa.Date(), nullable=False)`), and every existing range query compares it to
plain dates (`apply.replace_import`, `_load_candidates`, `tx_read_query`). So `<= as_of` is exact, the
`+1 day` form would be a silent off-by-nothing that only confuses the next reader, and A1's test row
("dated `period_to 23:59`") is unrepresentable. **Planned: `occurred_at <= as_of`**, with S2 test 4
pinning the boundary the way the schema allows (a row dated exactly `period_to` is IN, one dated
`period_to + 1 day` is OUT). Nothing else in A1 changes.

**FLAG-2 (addition, not in the architecture).** A line that starts with `dd.mm.yyyy ` but whose tail
is not `<amt> <CCY> <amt> <CCY>` is planned as a `StatementParseError`. D-E4 only says which lines
ARE operation lines; it does not say what happens to a candidate the server cannot cut. Silently
dropping it would produce a sum mismatch with no diagnosable cause; keeping it would feed the model a
line it cannot answer. Refusing before any token is spent is the cheapest honest answer.

**FLAG-3 (architecture UNDERSPECIFIED — §5).** §5 gives the canonical JSON of `ToolSpec`,
`ToolUseBlock` and `TextBlock`, but a tool LOOP must echo the assistant's tool_use turn back on the
next call, and `types.ContentPart = TextPart | ToolResultPart` makes that INEXPRESSIBLE — the loop
could not reach a second step in any provider. Planned fix: widen `ContentPart` to include
`ToolUseBlock` (no new type: an assistant tool_use content block and a response tool_use block are
the same JSON), with the `part_json` / `_message_param` / Ollama `_messages` arms spelled in S1 and a
dedicated test (S1 test 2).

**FLAG-4 (deliberate refinement of D-R2/D-R4 — needs a ruling, planned my way unless refused).**
The tool payloads and the terminal call use SHORT OPAQUE KEYS (`r1..rN`, `t1..tM`) instead of uuids,
mapped back to uuids by the server before the `Report` is built. Reason: 300 open items × 2 uuids is
~10 000 tokens of pure identifier that the model must copy character-perfectly, and a single mangled
uuid is a dropped item with no recourse. It is the categorize precedent (`o1`/`c1`) exactly, it keeps
`max_total_tokens` honest, and the STORED report and the WIRE still carry real uuids, so D-R4's "ids
from the open sets" is satisfied by construction (an unknown key is not resolvable, hence dropped).

**FLAG-5 (numeric default, D-E9).** `max_tokens = max(1024, 80 × lines)` is planned as
`max(1024, 150 × lines)`. An extract answer carries seven fields plus a Cyrillic merchant name per
line — strictly more than a categorize answer, which already budgets 150 tokens per row; a truncation
costs the whole chunk (one retry, then the whole upload), and unused budget costs nothing. The
architecture lists the numeric defaults as starting points.

**FLAG-6 (design observation, planned the architecture's way).** D-E8 requires the SERVER to regex
the trailing `<amt> <CCY> <amt> <CCY>` block off every line (to make `description`, and therefore the
fingerprint, independent of the model). That same regex already yields both amounts and both currency
codes — i.e. the server can read the money deterministically, and the model's numeric answer is
redundant for every line whose tail matched. Two consequences worth a ruling at scope close rather
than now: (a) the self-check's "two independent sources" is really "the model vs the header", while a
per-row server-vs-model comparison would localize a misread to ONE line instead of an aggregate
difference; (b) if the comparison were adopted, the LLM's remaining job is merchant extraction, which
is a smaller (and honest) claim than "the LLM extracts the operations". Planned as written, plus ONE
free piece of evidence: the extraction's summary log line carries a COUNT of rows where the model's
amount/currency disagreed with the line's own tail (`tail_mismatch_rows=`, a number, never text), so
the first live run decides this with data instead of opinion.

**FLAG-7 (small gap).** An Alfa session stores `ai_prompt_version` = the CATEGORIZE prompt version;
nothing records that its ROWS came from `extract-alfa-v1`. No column is planned (nothing reads it, and
A3 keeps `ai_status`' meaning) — the `log_call` line carries it. Raising it only because a future
"why does this old import look wrong" question has no answer in the DB.

# Open questions
- `reconciliation_summary` on the session read (A4) is planned as a read-through of the JSONB. If the
  frontend plan wants the headline WITHOUT the item list on an `applied` session that was never
  reconciled, it already gets `status='none'` + `null` — confirm that is the copy they expect.
- `tool_choice`'s `"any"` spelling is implemented but unused (D-R2 picks `auto`). Keep it, or drop it
  until something needs it? Planned: keep — it is three lines and `anthropic.py`'s docstring already
  explains why `any` is refused by the newest families.
- The three committed fixture PDFs (A2) need a Cyrillic-capable system TTF passed as an argument. On
  macOS that is a predictable path; on a Linux CI box it is not, which is why the script is manual and
  the PDFs are committed. Confirm 3 files ≤ 50 KB each is still the target after the first render (the
  owner's real 2-page statement is 76 KB, mostly embedded font subsets).

# Risks
- **Two provider passes per Alfa upload** (extract then categorize, A3). Worst case 60 s + 45 s inside
  one request. The 10/min upload limit bounds the damage, but QA must time a 400-line upload.
- **The self-check blocks apply.** A model that misreads one digit turns a good file into an
  un-appliable session; the user's only recourse is a re-upload (the preview is read-only about money).
  That is the architecture's intent (D-E7) and the honest behaviour, but it is the single most likely
  source of "the import does not work" reports, and the web copy must name the two numbers.
- **`alfa:v1` fingerprint stability** depends on the model's numbers (`FLAG-6`): a model upgrade that
  reads a previously-misread line correctly produces a NEW `client_id` for it, so a re-upload would
  create a second transaction for that one row. Bounded by the self-check (a misread statement cannot
  be applied in the first place), but it is why `FINGERPRINT_VERSIONS` and `PROMPT_VERSION` must move
  together if the extraction prompt ever changes what the model reports.
- **The claim holds a session for 2× the budget** after a crash (120 s). A user who reloads sees 409
  for up to two minutes. Deliberate (a double click must not burn two loops); the web should render it
  as "already running", not as an error.
