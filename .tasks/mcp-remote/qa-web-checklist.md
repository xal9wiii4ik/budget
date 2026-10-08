# QA Web Checklist: mcp-remote W1 — страница согласия + «Подключённые AI-приложения»

## Scope
Только браузерное: армы `/oauth/consent` на РЕАЛЬНЫХ запросах авторизации, навигация на `redirect_to`,
перенос `?next=` через логин и регистрацию, порядок секций Settings, инвалидация после revoke, RU/EN,
консоль/сеть, 375px, клавиатура.
НЕ покрываю (закрыто дешевле): `isAllowedRedirect` — `redirectGuard.test.ts` (8 кейсов); коды/тела
`/oauth/*`, PKCE, 429, скоупинг, одноразовость кода — pytest `test_oauth_*.py`; армы `loading` и
`unreachable` — код-ревью (локальный сервер отвечает мгновенно, искусственная пауза ничего не доказывает).
НЕ тестируемо на этом стенде: анти-фрейминг (`X-Frame-Options`, `frame-ancestors`) — заголовки nginx,
нужен prod-like compose; сам `/mcp` — это B2, не веб.

Стенд: БД `budget_qa_mcpremote` (5443) · API :8021 без `--reload`, `PUBLIC_BASE_URL=http://localhost:5199`
· vite :5199 · listener `127.0.0.1:4242` для loopback-колбэка · headless Google Chrome, Playwright 1.64.
DCR-клиенты: C1 — loopback `http://localhost:4242/cb`, `client_name` = враждебный HTML;
C2 — `https://claude.ai/api/mcp/auth_callback`. Пользователи `qa-mcpr-web-1@budgetqa.dev` (регистрация
через UI, TC-1) и `qa-mcpr-web-2@budgetqa.dev` (через консент-поток, TC-11); логин каждого один раз,
дальше `storageState`.

## Test cases

### TC-1: регистрация пользователя 1 через UI
- **Steps**: `/register` → email/пароль → отправить. **Expected**: попадание в приложение, сессия, чистая консоль.
- **Status**: ✅ → `/transactions`, `budget.auth` записан, `h1` «Операции», 0 console error.

### TC-2: ready-арм, loopback-клиент с враждебным `client_name`
- **Precondition**: user 1 вошёл, свежий `req` от C1.
- **Expected**: имя как литеральный текст, `nameDeclared`, хост, loopback-бейдж, default `read`, «Вы вошли как», без шелла.
- **Status**: ✅ `h1` = «`<b>Claude</b> QA <img src=x onerror=alert(1)>` просит доступ к вашему бюджету» /
  «… is asking for access to your budget»; в `<main>` `b`=0, `img`=0, перехватчик `dialog` пуст (alert не
  вызван); `nameDeclared` на обоих языках; хост `localhost`; бейдж «Этот компьютер»/«This computer» +
  loopback-строка; radio `read` checked, `full` нет; «Вы вошли как qa-mcpr-web-1@budgetqa.dev»; `nav`/`aside`=0.

### TC-3: Allow → loopback-колбэк с кодом
- **Status**: ✅ `http://localhost:4242/cb?code=bgt_oac_NBamG-…&state=qa-state-1`; ровно один
  `POST /oauth/requests/<id>/decision` 200.

### TC-4: Deny на свежем запросе
- **Status**: ✅ `http://localhost:4242/cb?error=access_denied&state=qa-state-deny`.

### TC-5: повторное открытие отвеченного `req`
- **Status**: ✅ «Срок этого запроса истёк или на него уже ответили…» в `role=alert`; `h1` нет, в карточке
  0 кнопок (кроме тумблеров в углу), Retry нет.

### TC-6: `?req=` отсутствует
- **Status**: ✅ «В этой ссылке нет запроса доступа…» в `role=alert`; `GET /oauth/requests/*` НЕ уходит
  (в сети только `/users/me` + `/profile`); кнопок нет.

### TC-7: `?req=<случайный uuid>`
- **Status**: ✅ тот же gone-текст (no-oracle: «не существовал» и «уже отвечен» неотличимы);
  `GET /oauth/requests/1111…` → 404; кнопок нет.

### TC-8: не-loopback клиент (claude.ai) — бейджа «Этот компьютер» НЕТ
- **Steps**: открыть consent-URL от C2 и прочитать; Allow НЕ нажимать (ушло бы на реальный claude.ai).
- **Status**: ✅ хост `claude.ai`; бейджей 0, loopback-строки нет; имя «Claude»; обе кнопки на месте.

### TC-9: RU/EN на странице согласия
- **Status**: ✅ EN↔RU меняет заголовок, дисклеймер, бейдж, легенду, тела режимов и кнопки; `client_name`
  и `localhost` не переведены; выбранный `full` после переключения языка остался checked.

### TC-10: вышедший пользователь → `/login?next=…` → назад на тот же `req`
- **Status**: ✅ `/login?next=%2Foauth%2Fconsent%3Freq%3D718d737a-…` без `reason=expired` и без баннера
  «сессия истекла» → после входа `/oauth/consent?req=718d737a-…` (тот же id), ready-арм.

### TC-11: новый пользователь: consent → login → «Создать» → register → назад на consent
- **Status**: ✅ ссылка = `/register?next=%2Foauth%2Fconsent%3Freq%3D8b4b04bd-…`; после регистрации
  `/oauth/consent?req=8b4b04bd-…`, ready-арм, «Вы вошли как qa-mcpr-web-2@budgetqa.dev»; 0 console error.

### TC-12: Settings — пустой арм, секция ВЫШЕ «Токенов доступа»
- **Status**: ✅ порядок `h2`: Язык → Пароль → Уведомления → Основная валюта → Месячный доход →
  **Подключённые AI-приложения** → Токены доступа; «Пока не подключено ни одного AI-приложения.» + шаги +
  `<code>http://localhost:5199/mcp</code>`; `li`=0; `GET /oauth/apps` 200 `{"items":[]}`; цифр/сумм нет.

### TC-13: грант появился после обмена кода — одна строка
- **Precondition**: код из TC-10 обменян curl'ом (`scope: read`).
- **Status**: ✅ одна `li`: имя как текст (`b`=0, `img`=0), бейдж «Только просмотр», «Подключено 8 окт.
  2026 г., 16:51 · ни разу не использовано», кнопка «Отключить».

### TC-14: Disconnect → ConfirmDialog с именем → строка тускнеет без перезагрузки
- **Status**: ✅ диалог «Отключить приложение» + «Отключить «<имя>»? Оно сразу перестанет работать…»;
  после подтверждения `DELETE /oauth/apps/<id>` → `GET /oauth/apps`, строка осталась с классом
  `_revoked_`, бейдж «Отключено 8 окт. 2026 г., 16:53», кнопок в строке 0, диалог закрылся.

### TC-15: отозвано в другом месте → Disconnect на устаревшем списке
- **Precondition**: второй грант (`full`, из TC-20) отозван curl'ом при открытом списке.
- **Status**: ✅ в диалоге «Это приложение уже отключено.»; сеть `DELETE` (404) + `GET /oauth/apps`;
  строка стала `_revoked_` «Отключено … 16:54», активных кнопок в списке 0.

### TC-16: секция «Токены доступа» рядом не изменилась
- **Status**: ✅ одна строка «QA PAT manual · Просмотр и изменение · Отозвать»; имени OAuth-приложения
  в блоке токенов нет, PAT в секции приложений нет.

### TC-17: скоупинг в UI — user 2 не видит приложений user 1
- **Status**: ✅ пустой арм, `GET /oauth/apps` → `{"items":[]}` (у user 1 в это время активный грант).

### TC-18: консоль и сеть по всем пройденным потокам
- **Status**: ✅ 0 console error приложения. Все пойманные 404 чужие и ожидаемые: страница слушателя
  `:4242` («File not found») и намеренные 404 API (`GET /oauth/requests/<gone>`, `DELETE` уже отозванного).
  На монтаж `/settings` ровно один `GET /oauth/apps` (всего 5 запросов), на монтаж согласия один
  `GET /oauth/requests/<id>`; дублей и штормов нет; `POST …/decision` один на решение.

### TC-19: 375px — согласие и секция Settings
- **Status**: ✅ 375×812: на обоих экранах `scrollWidth` 375 = `innerWidth`, элементов за правой границей 0,
  кнопки доступны (`ev/tc19-settings-375.png`, `ev/tc19-consent-375.png`).

### TC-20: клавиатура — согласие проходится без мыши
- **Status**: ✅ Tab №1 с body даёт radio `read` (`:focus-visible`), ↓ переводит на `full` (checked),
  Tab → «Не разрешать», Tab → «Разрешить доступ», Enter → `…/cb?code=…&state=qa-state-20`; обмен кода
  вернул `scope: "full"` — выбранный клавиатурой режим доехал до гранта.

## Summary
Всего 20 · ✅ 20 · ❌ 0 · ⏸ 0 — **✅ READY FOR REVIEW**, дефектов не найдено.

Наблюдения без статуса дефекта:
1. Тумблер языка на странице согласия сохраняет выбор в профиль (`PATCH /profile`) — работает, но
   неочевидный побочный запрос на странице, которая не про настройки.
2. Арм `loading` помечен `aria-hidden="true"` без текстовой альтернативы: скринридер во время загрузки
   карточки не слышит ничего. Тот же приём уже в блоке токенов — не регрессия этого скоупа.

Прогон: `…/747ab211-…/scratchpad/{t1..t5}.js` + `ev/*.png` (сессионный scratchpad, вне репозитория).
