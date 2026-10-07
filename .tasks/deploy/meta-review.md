# Meta-review: deploy (senior-lead on review.md, 2026-10-07)

Reviewer verdict "APPROVE WITH FIXES, 2 MAJOR / 7 MINOR / 9 NIT" — accepted. All findings
below were checked against the files, not taken on faith.

## MAJOR
- **M1 sshd drop-in order — AGREE.** sshd keeps the first value per keyword and the
  `Include sshd_config.d/*.conf` is lexical; a cloud-init `50-cloud-init.conf` with
  `PasswordAuthentication yes` beats `99-budget.conf`, and the script would still print
  "disabled". Fix as proposed: `00-budget.conf` + assert `sshd -T` after reload, print a
  WARNING when the effective value is not `no`. This is the lock-out-adjacent step, so the
  claim must be a measurement.
- **M2 restore of an older dump — AGREE.** `pg_restore --clean` drops only objects present in
  the dump; a rollback restore leaves newer tables while `alembic_version` goes back, and
  `alembic upgrade head` then fails on "relation already exists" under `restart:
  unless-stopped`. Fix: `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` after the
  straggler kill, then `pg_restore --no-owner --exit-on-error` (no `--clean`). MUST be
  re-drilled on the QA stand (P16 re-run) because PG 17's dump may or may not emit a
  `CREATE SCHEMA public` entry; if `--exit-on-error` trips on that, fall back to
  `--clean --if-exists` on the empty schema + an explicit post-check that
  `alembic_version` matches the dump.

## MINOR — all AGREE, all land in the same fix round
- m1 pre-restore safety dump (`pre-restore-<ts>.dump`, `.part` rename). Cheap insurance.
- m2 authorized_keys regex must match `ecdsa-`, `sk-` and option-prefixed lines.
- m3 root `.dockerignore` — the build context is `/opt/budget` and ships `.env` to the
  daemon; add `.env`, `.env.*`, `!.env.example`, `!.env.prod.example`.
- m4 docs: `\password budget` instead of a password in argv.
- m5 docs: only sessions whose refresh token is in the dump survive a restore.
- m6 docs: no AAAA record while Docker's bridge is IPv4-only (all v6 clients would share one
  rate-limit bucket).
- m7 `umask 077` at the top of backup.sh.

## NIT — adopted: nginx `map` whitelist (`https`/`http`/default `$scheme`), hex-only note for
POSTGRES_PASSWORD, `config -q` in the example header, docs lines for "timer is live before
the first update.sh", "Caddyfile edit → `compose restart caddy`", "ufw does not filter
Docker-published ports — the `ports:` discipline is the control".
Deferred: `minio/mc` pin (would have to change the dev file too — out of this scope's remit);
ssh-keyscan TOFU (accepted for a read-only key); open registration + AI quotas = owner's
call, surfaced in the final report.

## Process
- qa-engineer F-2 (R2 arity check after the dump; ERROR text credits `$ENV_FILE`) — fold:
  move the arity check before the dump.
- qa-engineer F-3 (restore while web-qa probing) — no overlap in fact: web-qa finished
  15:26 local, the restore window was 15:30:04–15:30:23 local.
- P14 (scheduler registration invisible in api logs) — `app.py` observability gap, NOT a
  deploy defect; registration is pinned by `tests/test_scheduler_wiring.py`. Reported to the
  owner as an optional one-liner follow-up, not widened into this scope.
