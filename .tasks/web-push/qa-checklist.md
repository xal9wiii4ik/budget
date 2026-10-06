# QA-чеклист: скоуп `web-push` (FULL, API-уровень)

## Scope
Живьём — только шов внешней интеграции: флаг без VAPID, upsert/rebind и no-oracle на собранном приложении,
реальный `pywebpush` против ЛОКАЛЬНОГО стаба push-сервиса (201/500/410), лимитер, PAT-гейт, суточная джоба.
Реальный push-сервис и браузер — вне скоупа (веб — web-qa). Решения: `architecture.md` §3–§6, §8. Все CT — `[stop-probe]`.

## Section A: pytest (владелец — backend-engineer; ✅ когда `make test` зелёный)
- PT-1 (§8.1) unsubscribe: своя → удалена; чужая/несуществующая → строка цела; оба 204 байт-в-байт. ⏸
- PT-2 (§8.2) subscribe дважды → одна строка, тот же `id`; POST чужим юзером переносит `user_id`. ⏸
- PT-3 (§8.3) VAPID пуст: config `{enabled:false, public_key:null}`, subscribe/test 503 `PUSH_NOT_CONFIGURED`, unsubscribe 204; 401 раньше 503. ⏸
- PT-4 (§8.4) два прогона джобы на один `today` → одна отправка на устройство, одна claim-строка. ⏸
- PT-5 (§8.5) `gone` (404 И 410) → строка удалена (джоба и `/test`); `failed` → строка жива, исключение не всплывает. ⏸
- PT-6 (§8.6) в тексте дайджеста нет цифр сумм; URL по семействам + mixed; payload ровно `{title,body,url,tag}`. ⏸
- PT-7 (§8.7) язык профиля бьёт язык устройства; NULL в профиле → `lang` устройства. ⏸
- PT-8 (§8.8) push-джоба зарегистрирована при включённом гейте и отсутствует при выключенном. ⏸
- PT-9 (§8.9) четыре пары `/push/*` в `NEVER_PAT`; производный allowlist остаётся 38. ⏸

## Стенд: подъём / снос (рабочую `budget`, 8010, 5173, 5433, 8000, 8081 не трогаем)
Не запускать в 23:50–00:10 UTC (`today` — UTC). Шелл zsh, состояние между Bash-вызовами не живёт: переменные,
`export` и функции ниже сложить в `$QA_TMP/env.sh` и `source` его в начале каждого вызова.
```bash
API=/Users/nikitazaretski/work/budget/apps/api; QA_TMP=<scratchpad сессии>; BASE=http://localhost:8021
STAND=postgresql+asyncpg://budget:budget@localhost:5443/budget_qa_push
PSQL="psql postgresql://budget:budget@localhost:5443/budget_qa_push -tA -c"
PGPASSWORD=budget psql -h localhost -p 5443 -U budget -d postgres -c 'CREATE DATABASE budget_qa_push'
cd $API && DATABASE_URL=$STAND uv run alembic upgrade head && $PSQL 'select version_num from alembic_version'  # 0015
export FX_SCHEDULER_ENABLED=false RECURRING_SCHEDULER_ENABLED=false PUSH_SCHEDULER_ENABLED=false
lsof -nP -iTCP:8021 -iTCP:8097 -sTCP:LISTEN   # пусто, иначе взять другие порты
# boot #1 — VAPID ЯВНО пустые (env бьёт apps/api/.env, где ключи может держать владелец):
cd $API && env DATABASE_URL=$STAND VAPID_PUBLIC_KEY= VAPID_PRIVATE_KEY= VAPID_SUBJECT= \
  nohup uv run uvicorn budget_api.app:create_app --factory --port 8021 > $QA_TMP/api.log 2>&1 &
# VAPID-пара (сверить с API py_vapid на прогоне; from_string принимает 32 сырых байта base64url):
cd $API && uv run python - <<'PY' > $QA_TMP/vapid.env && source $QA_TMP/vapid.env
import base64
from py_vapid import Vapid
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
b = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=").decode()
v = Vapid(); v.generate_keys()
priv = b(v.private_key.private_numbers().private_value.to_bytes(32, "big"))
assert Vapid.from_string(private_key=priv).public_key.public_numbers() == v.public_key.public_numbers()
print("export VAPID_PUBLIC_KEY=" + b(v.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)))
print("export VAPID_PRIVATE_KEY=" + priv); print("export VAPID_SUBJECT=mailto:qa-push@budgetqa.dev")
PY
# boot #2 (после CT-1): lsof -ti tcp:8021 | xargs kill; source vapid.env; та же команда БЕЗ трёх пустых VAPID_*
# снос: lsof -ti tcp:8021,8097 | xargs kill. DROP базы — оркестратор.
```
**Стаб push-сервиса** (127.0.0.1:8097; `POST /_mode/<code>` задаёт ответ, `GET /_hits`, `POST /_reset`):
```bash
cat > $QA_TMP/stub.py <<'PY'
import http.server, json, sys
S = {"mode": 201, "hits": []}
class H(http.server.BaseHTTPRequestHandler):
    def _r(self, c, b=b""): self.send_response(c); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path.startswith("/_mode/"): S["mode"] = int(self.path.rsplit("/", 1)[1]); return self._r(200)
        if self.path == "/_reset": S["hits"].clear(); return self._r(200)
        S["hits"].append({"path": self.path, "len": len(body), "enc": self.headers.get("Content-Encoding"),
                          "ttl": self.headers.get("TTL"), "auth": self.headers.get("Authorization")})
        self._r(S["mode"])
    def do_GET(self): self._r(200, json.dumps(S["hits"]).encode())
    log_message = lambda self, *a: None
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
python3 $QA_TMP/stub.py 8097 & STUB=http://127.0.0.1:8097
# ключи браузера: валидная P-256 точка + 16-байтный auth (pywebpush шифрует ДО отправки)
gen_keys() { (cd $API && uv run python -c 'import base64,os,json
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding as E, PublicFormat as P
b=lambda x: base64.urlsafe_b64encode(x).rstrip(b"=").decode()
k=ec.generate_private_key(ec.SECP256R1()).public_key()
print(json.dumps({"p256dh": b(k.public_bytes(E.X962, P.UncompressedPoint)), "auth": b(os.urandom(16))}))'); }
sub() { curl -s -w '\n%{http_code}\n' -X POST $BASE/push/subscriptions -H "Authorization: Bearer $1" \
  -H 'Content-Type: application/json' -d "{\"endpoint\":\"$STUB/push/$2\",\"keys\":$(gen_keys),\"lang\":\"ru\"}"; }
```
**LOGIN ONCE**: `POST /auth/register {email,password}` для `qa-push-{a,b,c}@budgetqa.dev` / `Qa!Test1234`,
один `POST /auth/login` (form `username/password`) на юзера → `TOKEN_A/B/C` на весь прогон.

## Section B: живые stop-probe (владелец — qa-engineer)

### CT-0b SSRF-гард `endpoint` (решение 1 grooming-review) — НЕ живьём, закрыт PT
- Стенд обязан жить с `PUSH_ALLOW_INSECURE_ENDPOINTS=true` (иначе `http://127.0.0.1` стаб → 422), так что на нём
  гард не наблюдаем; третьего рестарта ради него не делаем. Покрытие: `tests/test_push_api.py::
  test_endpoint_must_be_https_to_a_named_host_unless_the_stand_flag_is_on` — без флага `http://push.example.com/…`
  и `https://127.0.0.1/…` → 422 `{"detail":"PUSH_ENDPOINT_INVALID"}`, строк 0; с флагом те же принимаются.
  Живое косвенное: на стенде с флагом все `http://127.0.0.1:8097/…` приняты 201 (CT-3/5/10).
- Status: ✅ (PT-covered, прочитано)

### CT-1 Без VAPID: честный флаг, 503 на запись, 204 на отписку (boot #1)
- `GET /push/config` (A) → 200 `{"enabled":false,"public_key":null}`; `POST /push/subscriptions` (A, валидное
  тело через `sub $TOKEN_A x`) → 503 `{"detail":"PUSH_NOT_CONFIGURED"}`; `POST /push/test` → 503 тот же;
  `POST /push/unsubscribe {"endpoint":"$STUB/push/x"}` → 204, пустое тело. `push_subscriptions` пуста.
- `curl -s -w '\n%{http_code}\n' $BASE/push/config -H "Authorization: Bearer $TOKEN_A"` (+ три вызова выше)
- Actual (2026-10-06, boot #1, VAPID пустые): config 200 `{"enabled":false,"public_key":null}`; subscribe 503 `{"detail":"PUSH_NOT_CONFIGURED"}`; test 503 тот же; unsubscribe 204, 0 байт; `push_subscriptions` = 0, стаб без хитов. | Status: ✅

### CT-2 С VAPID: флаг включён, ключ отдаётся как есть (boot #2)
- `GET /push/config` (A) → 200 `{"enabled":true,"public_key":<1:1 с env>}`: `curl -s $BASE/push/config -H "Authorization: Bearer $TOKEN_A" | jq -e --arg k "$VAPID_PUBLIC_KEY" '.enabled and .public_key==$k'`
- Actual: 200 `{"enabled":true,"public_key":"BOwORm…"}`, `jq -e` → true (1:1 с env). Повторено после вынужденного boot #2' (см. «Ход прогона») с новой парой — снова true. | Status: ✅

### CT-3 Upsert и rebind одного endpoint
- `sub $TOKEN_A dev1` дважды → 201 оба раза, `id` совпадает, тело `{id,endpoint,created_at}`. Затем B шлёт
  тот же endpoint (новые ключи) → 201, тот же `id`. SQL: одна строка, `user_id` = B.
- `$PSQL "select count(*), max(user_id::text) from push_subscriptions where endpoint='$STUB/push/dev1'"` → `1|<GET /users/me B>`;
  `POST /push/test` под A → `{"sent":0,"removed":0}`, стаб не тронут.
- Actual: A×2 и B → 201, все три `id=98e3ebb5-…`, `created_at` один и тот же, тело `{id,endpoint,created_at}`; SQL `1|94159283-…` (= `/users/me` B); `/push/test` под A → 200 `{"sent":0,"removed":0}`, хитов 0. | Status: ✅

### CT-4 Отписка без оракула: чужой endpoint неотличим от несуществующего
- A: `POST /push/unsubscribe` с `$STUB/push/dev1` (строка B) и с `$STUB/push/nope` → оба 204;
  `curl -s -D - … | grep -vi '^date:'` у двух ответов — `diff` пуст. Строка B жива; B отписывает dev1 → 204, count 0.
- Actual: оба ответа A `HTTP/1.1 204 No Content` + `server`, `content-type: application/json`; `diff` (без `date:`) пуст. Строка B жива (`1|<B>`); B отписывает → 204 0 байт, count 0. | Status: ✅

### CT-5 Тестовый пуш доходит: шифрование + VAPID-заголовок (стаб 201)
- `curl -s -X POST $STUB/_reset; sub $TOKEN_A dev2`; `POST /push/test` (A) → 200 `{"sent":1,"removed":0}`.
- Стаб: `curl -s $STUB/_hits | jq` → ровно 1 хит, `path=/push/dev2`, `enc=aes128gcm`, `ttl=86400`, `len>0`,
  `auth` = `vapid t=…, k=$VAPID_PUBLIC_KEY`. Приватность payload по проводу не видна (шифротекст) — это PT-6.
- Actual: subscribe 201; `/push/test` → 200 `{"sent":1,"removed":0}`; стаб: 1 хит `path=/push/dev2, len=254, enc=aes128gcm, ttl=86400`, `auth` = `vapid t=eyJ…, k=<VAPID_PUBLIC_KEY>` (совпал); JWT claims `{"aud":"http://127.0.0.1:8097","exp":+~12ч,"sub":"mailto:qa-push@budgetqa.dev"}`. | Status: ✅

### CT-6 Сбой push-сервиса (500): устройство не удаляется
- `curl -s -X POST $STUB/_mode/500`; `POST /push/test` (A) → 200 `{"sent":0,"removed":0}`; count строк dev2 = 1;
  в `$QA_TMP/api.log` warning, без трейсбека 500 от API.
- Actual: 200 `{"sent":0,"removed":0}`; dev2 count = 1; стаб 1 хит; лог: `WARNING: budget_api.services.push_sender: push failed (500 Internal Server Error) host=127.0.0.1` (только хост, без endpoint), трейсбеков 0. | Status: ✅

### CT-7 Мёртвое устройство (410): строка удаляется сама
- `curl -s -X POST $STUB/_mode/410`; `POST /push/test` (A) → `{"sent":0,"removed":1}`; count dev2 = 0;
  повторный `/push/test` → `{"sent":0,"removed":0}`, новых хитов у стаба нет. Вернуть `_mode/201`.
- Actual: 1-й → 200 `{"sent":0,"removed":1}`, dev2 count 0; 2-й → 200 `{"sent":0,"removed":0}`, хитов по-прежнему 1; `_mode/201` возвращён; трейсбеков 0. | Status: ✅

### CT-8 Лимит `/push/test`: 6-й вызов за минуту → 429
- C (устройств нет, ничего не шлётся): `for i in 1 2 3 4 5 6; do curl -s -w ' %{http_code}\n' -X POST
  $BASE/push/test -H "Authorization: Bearer $TOKEN_C"; done` → 5× `{"sent":0,"removed":0} 200`, затем
  `{"detail":"RATE_LIMITED"} 429`. Сразу же B (0 вызовов до этого) → 200: ключ лимита per-user.
- Actual: C: 5× `{"sent":0,"removed":0} 200`, 6-й `{"detail":"RATE_LIMITED"} 429`; сразу B → `{"sent":0,"removed":0} 200`. | Status: ✅

### CT-9 PAT не пускают ни на один `/push/*`
- `PAT=$(curl -s -X POST $BASE/tokens -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json'
  -d '{"name":"qa-push","scope":"full"}')` → `.token`, `.id`. Под PAT все четыре `/push/*` (config, subscriptions,
  unsubscribe, test) → 401 (JWT-only роуты; исходно ошибочно 403 `TOKEN_ENDPOINT_FORBIDDEN`), строк не прибавилось; `DELETE /tokens/{id}` (JWT) → 204.
- Actual: PAT `bgt_pat_…` создан; все четыре `/push/*` → **401** `{"detail":"Unauthorized"}` (ожидание 403 в чеклисте было НЕВЕРНЫМ: роуты зависят от JWT-only `current_active_user`, PAT падает на разборе JWT — так задумано, `pat_auth.py` шаг 4 и докстринг `routers/push.py`; прецедент `/tokens`, `/advisor`. Недостижимость из allowlist — PT-9). Строк 0→0; тот же PAT на `GET /accounts` → 200 (токен рабочий); `DELETE /tokens/{id}` → 204. | Status: ✅ (ожидание исправлено на 401)

### CT-10 Суточная джоба: один пуш на устройство, claim, счётчики семейств, повтор — тишина
- Сиды под A (`TODAY=$(date -u +%F)`, `TMRW=$(date -u -v+1d +%F)`, `WD=$(( $(date -u -v+1d +%u) - 1 ))`):
  `POST /accounts {name:"QA card",currency:"BYN",type:"card"}`; `POST /goals {name:"QA goal",target_minor:100000,
  currency:"BYN"}` → `POST /goals/{id}/items {name:"QA item",amount_minor:5000,remind_on:$TODAY}`;
  `POST /recurring {name:"QA rent",amount_minor:1500,kind:"expense",account_id,interval_unit:"week",
  weekday:$WD,start_date:$TMRW}`; `POST /deposits {name:"QA dep",currency:"BYN",rate_percent:"5",
  capitalization:"none",opened_on:$TODAY,term_end:$TMRW}` (имена полей сверить с `openapi.json`).
  Устройства: `sub $TOKEN_A job-a`, `sub $TOKEN_C job-c` (у C ничего не должно); `POST $STUB/_reset`; строк подписок = 2.
- Запуск на стенд-БД, реальный `PushSender` из Settings стенда (`vapid.env` source'нут; стаб = push-сервис):
```bash
cd $API && env DATABASE_URL=$STAND uv run python -c 'import asyncio
from budget_api.config import Settings
from budget_api.db import build_engine, build_sessionmaker
from budget_api.services.push_sender import PushSender
from budget_api.services.push_jobs import send_daily_reminders
s = Settings(); assert s.database_url.endswith("/budget_qa_push"), s.database_url
async def m():
    e = build_engine(s); await send_daily_reminders(build_sessionmaker(e), sender=PushSender(s), horizon_days=1); await e.dispose()
asyncio.run(m())'
```
- Ожидание: стаб — ровно 1 хит, `path=/push/job-a`, `enc=aes128gcm`; `$PSQL "select user_id,goal_items,charges,
  deposits,delivered,removed from push_reminder_sends where sent_on=(now() at time zone 'utc')::date"` →
  A `1|1|1|1|0`, C `0|0|0|0|0` (claim всегда), строки B нет. Второй запуск → хитов по-прежнему 1, строк 2.
- Actual (14:24 UTC, сиды 201: goal item `remind_on=2026-10-06`, recurring week `weekday=2` с `2026-10-07` (`/recurring/upcoming` → due 2026-10-07), deposit `term_end=2026-10-07`): прогон 1 — стаб 1 хит `path=/push/job-a, len=232, enc=aes128gcm, ttl=86400`, `k=` совпал; claim: A `1|1|1|1|0`, C `0|0|0|0|0`, строки B нет. Прогон 2 — хитов 1, claim-строк 2, значения те же. | Status: ✅

## Не входит в живой прогон (чем закрыто)
- 401 и 401 раньше 503 — PT-3; 404 от push = gone — PT-5; 422 на тело/`lang`/`user_agent`>255 — Pydantic, не пишем.
- Нет сумм в тексте, URL-правило, тег — PT-6 (на проводе шифротекст); язык дайджеста — PT-7.
- Регистрация cron-джобы, нет boot-run — PT-8; гонка двух прогонов на PK claim — PT-4; CORS — `tests/test_cors.py`.
- Архивные цели/вклады и пауза шаблона вне дайджеста — тесты `read_upcoming_deadlines`/`read_upcoming_charges`.

## Вопросы к senior-lead (до B1)
1. **SSRF**: `endpoint` — любой URL, API сам POST-ит на него (test, джоба), включая loopback/LAN. Фильтровать
   (https, не private)? Если да — стабу нужен dev-only флаг-разрешение, иначе CT-3…CT-10 уходят в pytest.
2. **Таймаут**: `webpush()` по умолчанию `timeout=None` — зависший push-сервис подвесит `/push/test` и поток
   джобы. Предлагаю `timeout=` в сендере (→ `failed`) и кейс в PT-5.

## Ход прогона (2026-10-06, 14:20–14:27 UTC)
- Стенд: БД `budget_qa_push` (5443, alembic 0015; рабочая `budget` осталась на 0014, не тронута), API 8021,
  стаб 8097, флаги `FX/RECURRING/PUSH_SCHEDULER_ENABLED=false PUSH_ALLOW_INSECURE_ENDPOINTS=true`.
- Инцидент окружения (не дефект продукта): параллельная линия web-qa делила тот же scratchpad сессии и
  перезаписала общие `api.pid`/`vapid.env`; её рестарт убил мой boot #2 (лог: штатный `Shutting down` после CT-8).
  Файлы стенда перенесены в `scratchpad/qa-push/`, keyed-сервер поднят заново (boot #2') с НОВОЙ VAPID-парой;
  CT-2 переподтверждён, CT-9/CT-10 гнались на нём. Урок для стенда: каждой QA-линии — свой подкаталог.
- Снос: uvicorn 8021 и стаб 8097 (только свои PID) остановлены, порты свободны. БД `budget_qa_push` НЕ дропнута —
  дроп за оркестратором.

## Итог прогона
- Total: 11 (CT-0b + CT-1…CT-10); Passed: 11; Failed: 0; Blocked: 0.
- Отклонение: CT-9 — ожидание чеклиста исправлено 403 → 401 (поведение по дизайну JWT-only роутов).
- Section A (PT-1…PT-9) этой линией не гонялась — targeted pytest на `budget_test` у другой линии.
- **✅ READY FOR REVIEW** (Section B).
