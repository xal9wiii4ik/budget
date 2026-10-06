# QA Web Checklist: web-push W1 — раздел «Уведомления» в Settings + push в `sw.js`

## Scope
Только то, что обеспечивает браузер: арм раздела по реальному конфигу сервера, запрос разрешения из
клика, регистрация воркера, `pushManager.subscribe`, CORS новых `/push/*` (GET + POST из приложения),
обработчик `push` в воркере, отсутствие регрессии offline-навигации, console, 375px, клавиатура.
НЕ покрывает (закрыто дешевле): таблица из шести армов и порядок приоритетов, `isIOSDevice`
(`notificationsState.test.ts`); base64url/`sameServerKey` (`pushKeys.test.ts`); коды/тела `/push/*`,
422 на endpoint, 429, скоупинг, дайджест и джоб (pytest + CT-1…CT-10 у qa-engineer).
`notificationclick` (фокус/навигация) — CDP не умеет кликать уведомление, поэтому это ручной TC.

Стенд: БД `budget_qa_push_web` (5443), API :8022 (boot #1 без ключей; boot #2/#3 с одноразовыми
VAPID K1/K2), vite :5199 (`VITE_API_URL=http://localhost:8022`), headless Google Chrome через
Playwright 1.62 (`channel:'chrome'`). Пользователь `qa-webpush@budgetqa.dev`, логин ОДИН раз (curl
`/auth/login` → `budget.auth` в localStorage). Скриншоты — `qa-web-evidence/`.

### TC-1: сервер без ключей → арм server-off, RU и EN
- **Steps**: boot без VAPID; открыть /settings; прочитать раздел; переключить язык RU→EN; назад.
- **Expected**: текст server-off на обоих языках, кнопки нет, ошибок в консоли нет.
- **Status**: ✅ RU «Уведомления недоступны — на сервере не настроены ключи.», EN «Notifications are
  unavailable — no push keys are configured on the server.»; `button` в разделе: 0/0. `GET /push/config`
  200, воркер не зарегистрирован. Console: только vite/React DevTools debug/info. `A-server-off-{ru,en}.png`.

### TC-2: ключи есть → арм off, раскладка Settings не изменилась
- **Steps**: boot с K1; открыть /settings.
- **Expected**: «Выключены на этом устройстве.» + «Включить»; раздел после «Пароль»; сумм нет.
- **Status**: ✅ порядок h2: Язык → Пароль → Уведомления → Основная валюта → Месячный доход → Токены
  доступа. Цифр и символов валют в разделе нет (лид говорит «без сумм»). До клика `requestPermission`
  вызван 0 раз. `B-off.png`.

### TC-3: «Включить» → разрешение из клика → подписка → арм on
- **Steps**: контекст с `grantPermissions(['notifications'])`; клик «Включить».
- **Expected**: разрешение запрошено при активном жесте; `/sw.js` зарегистрирован; subscribe → POST 201 → on.
- **Status**: ✅ исход «успех» (headless Chrome получил РЕАЛЬНУЮ подписку FCM). `requestPermission`:
  1 вызов, `userActivation.isActive=true`. Регистрация scope `http://localhost:5199/`, `activated`,
  endpoint `https://fcm.googleapis.com/fcm/send/…`. Сеть: ровно один `POST /push/subscriptions 201`
  (CORS-preflight прошёл). Арм: «Включены на этом устройстве.» + «Отправить тестовое» + «Выключить». `B-on.png`.

### TC-3b: разрешение не выдано → тихо, без воркера
- **Steps**: свежий контекст без grant; Tab до «Включить» (20 нажатий), Enter.
- **Expected**: 'default' → остаётся off молча, либо 'denied' → арм denied; без регистрации/сети.
- **Status**: ✅ headless сам ответил `denied` (не `default`) → «Уведомления для этого сайта запрещены.
  Разрешите их в настройках сайта в браузере и перезагрузите страницу.» Регистрации нет, запросов
  `/push/*` нет. С клавиатуры проходится. `C-375-after-dismiss.png`.

### TC-4: «Отправить тестовое» и «Выключить»
- **Steps**: в арме on — клик «Отправить тестовое»; F5; клик «Выключить».
- **Expected**: `POST /push/test` → строка `{sent, removed}`; F5 → ре-синк ровно одним POST; выключение → POST 204 → off.
- **Status**: ✅ `POST /push/test 200` → role=status «Отправлено на 1 устройство.»; доставка реальная:
  уведомление «Уведомления включены» / «Это пробное уведомление.», tag `budget-test`,
  `data.url=/settings` пришло через FCM. F5: `GET /push/config` + ровно ОДИН `POST /push/subscriptions`
  (StrictMode-guard работает), арм on восстановился, `controller` есть. «Выключить» →
  `POST /push/unsubscribe 204`, арм off, `getSubscription()` = null.

### TC-5: обработчик `push` в воркере (CDP `ServiceWorker.deliverPushMessage`)
- **Status**: ✅ JSON `{"title":"Скоро","body":"x","url":"/goals","tag":"t"}` → уведомление title «Скоро»,
  body «x», tag «t», `data.url=/goals`, icon `/icons/icon-192.png`. Не-JSON `not json at all` → title
  «Budget», body '', `data.url=/`. Сверх брифа: `url:"https://evil.example/steal"` → `data.url=/`
  (safePath держит origin).

### TC-6: offline-поведение воркера не сломано
- **Status**: ✅ под управлением воркера: навигация /transactions 200, h1 «Операции», `controller` есть;
  `[vite] connected` после каждой загрузки (HMR жив). `setOffline(true)` + навигация /goals →
  offline-страница «Нет соединения … Повторить».

### TC-7: console на /settings в обоих армах
- **Status**: ✅ ошибок 0 в server-off, off, on, denied. Единственная `[error]` за прогон —
  `ERR_INTERNET_DISCONNECTED` в TC-6 (намеренный offline).

### TC-8: ротация VAPID и сервер без ключей при живой подписке (решение 6 груминга)
- **Steps**: включить с K1 → перезапуск API с K2 → открыть /settings; включить с K2 → перезапуск без ключей → /settings.
- **Status**: ✅ K1→K2: `POST /push/unsubscribe 204`, подписка в браузере снята, арм off + «Ключи
  уведомлений на сервере сменились…» (`D-rotated.png`). Без ключей: арм server-off, подписка браузера
  не тронута, POST нет (`D-keyless-subscribed.png`).

### TC-9: 375px и клавиатура
- **Status**: ✅ на 375px `scrollWidth` документа 375 = ширине окна, раздел 343/343, переполнения нет.
  ⚠ cosmetic (a11y): когда арм меняется после клика (off→on, off→denied), нажатая кнопка
  размонтируется и фокус падает на `BODY` (`document.activeElement.tagName === 'BODY'` после Enable и
  после Enter); пользователю с клавиатуры приходится снова проходить Tab'ом с начала страницы.

### TC-M1: iPhone, вкладка Safari (не установлено) — ⏸ manual (устройство, нужен HTTPS)
- **Steps**: iPhone iOS ≥16.4, Safari, HTTPS-сборка → /settings.
- **Expected**: без кнопки; RU «На iPhone и iPad уведомления работают только в установленном приложении:
  в Safari нажмите «Поделиться» → «На экран „Домой“», откройте Budget с иконки и вернитесь сюда.»
  EN «On iPhone and iPad notifications work only in the installed app: in Safari tap Share → Add to Home
  Screen, then open Budget from its icon and come back here.»
- **Status**: ⏸ manual

### TC-M2: iPhone, установленное приложение — ⏸ manual
- **Steps**: открыть Budget с иконки → Настройки → «Включить».
- **Expected**: «Выключены на этом устройстве.» + «Включить»; системный запрос появляется ПО ТАПУ (не при
  загрузке); «Разрешить» → «Включены на этом устройстве.»; «Отправить тестовое» → уведомление на экране
  блокировки без сумм; тап по нему открывает /settings в приложении. «Не разрешать» → «Уведомления для
  Budget выключены. Разрешите их в «Настройки» → «Уведомления» → Budget и откройте приложение заново.»
- **Status**: ⏸ manual

### TC-M3: клик по уведомлению (desktop Chrome/Safari) — ⏸ manual
- **Expected**: открыто окно приложения → фокус и переход на `data.url`; окна нет → новое окно на `data.url`.
- **Status**: ⏸ manual (CDP не кликает системное уведомление)

## Итог прогона
Прогон 2026-10-06, БД `budget_qa_push_web` (оставлена), API :8022, vite :5199 — остановлены.
Всего: 9 автоматизированных + 3 ручных. Пройдено: 9. Провалено: 0. Заблокировано: 0. Manual: TC-M1…M3.
Находки: functional 0; cosmetic 1 — фокус теряется на `BODY` при смене арма (TC-9).
Вердикт: ✅ READY FOR REVIEW (cosmetic — на усмотрение senior-lead).
