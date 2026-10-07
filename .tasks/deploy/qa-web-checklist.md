# QA Web Checklist: deploy — prod compose stack behind Caddy TLS (local stand)

## Scope
Браузерная проверка `docker-compose.prod.yml` + `deploy/Caddyfile` + `apps/web/nginx.conf`,
поднятых локально: `https://localhost:8443` (Caddy internal CA). Только то, что навязывает
браузер: secure context, service worker, same-origin `/api` и `/storage`, заголовки
документа, редиректы, формы. Контракты API — у `qa-engineer` (`qa-checklist.md`).
Не проверяем заново то, что закрыто vitest/pytest и скоупами `web-pwa` / `web-push`
(рендер offline.html при мёртвом сервере, расчёты, валидация форм).

**Окружение**: headless Google Chrome 154 через CDP (вариант (1) из брифа —
`--headless=new --ignore-certificate-errors --remote-debugging-port=9333`, профиль в
scratch; в системный keychain ничего не ставилось). Драйвер и скрипты journeys:
`<scratch>/qa-web/cdp.mjs`, `j1.mjs`…`j7.mjs`. Пользователь `qa-deploy-web@budgetqa.dev`,
зарегистрирован через UI, логин переиспользуется между сценариями.

## Test cases

### J1: SPA грузится и переживает deep-link reload
- **Действие**: открыть `https://localhost:8443/`; затем F5 на `/transactions` под логином.
- **Ожидание**: index.html 200, все ассеты 200, нет ошибок консоли; `/transactions`
  возвращает приложение (nginx fallback), а не 404.
- **Status**: ✅ — `/` → редирект `/login?next=%2Ftransactions`; 200 на html, обоих woff2,
  `assets/index-C0is9WGS.js`, `index-KiNwCgX_.css`, manifest, иконках. F5 на `/transactions`
  → `location.pathname === '/transactions'`, шелл отрисован. Console errors: none.

### J2: регистрация → вход → сессия переживает перезагрузку
- **Действие**: `/register`, форма email+password, submit; затем F5 и повторный вход после logout.
- **Ожидание**: 201/200, попадание в приложение, токен в `budget.auth`, сессия жива после F5.
- **Status**: ✅ — `POST /api/auth/register` 201 → `POST /api/auth/login` 200 → `/transactions`;
  `localStorage['budget.auth']` = `access_token,refresh_token,token_type`; после F5 и после
  повторного логина экран восстанавливается, созданная операция на месте. Console errors: none.

### J3: чек через UI — загрузка в `/storage` того же origin
- **Действие**: «Добавить по фото» → выбрать `receipt.jpg` (64×64, сгенерирован в scratch) →
  обе ветки: «Распознать через AI» и «Сохранить без распознавания» → операция 12.50 / Кафе.
- **Ожидание**: PUT уходит на `https://localhost:8443/storage/…` (никакого `minio.localhost`),
  AI-ветка показывает честное «не настроено», операция создаётся, сводка обновляется без reload.
- **Status**: ✅ — `POST /api/receipts` 201 → `PUT https://localhost:8443/storage/receipts/<uid>/<id>.jpg?X-…`
  **200**, host-переписывание `sub_filter` работает. AI-ветка: `POST …/parse` **503** и текст
  «Распознавание недоступно: на сервере не настроен AI-ключ. Фото сохранено…» — не краш.
  `POST /api/transactions` 201, список и сводка перерисовались сами: `Расход 12,50 ₽ / Итог −12,50 ₽`
  (формат денег через общий хелпер, символ ₽). Console errors: none (кроме сетевой записи о 503).

### J3b: картинка из `/storage` реально рендерится
- **Действие**: чек «без AI» остаётся `pending` и по дизайну не получает `view_url`
  (`apps/api/src/budget_api/routers/receipts.py::_view_url`), поэтому тем же механизмом
  проверено фото пункта плана: цель и пункт заведены curl'ом, фото приложено через UI.
- **Ожидание**: presigned GET переписан в same-origin `/storage/…`, `<img>` декодируется.
- **Status**: ✅ — `GET https://localhost:8443/storage/receipts/<uid>/goal-items/…` 200,
  `img.naturalWidth×Height = 64×64`. Ни одного запроса на `minio.localhost`.

### J4: PWA — secure context, manifest, worker
- **Действие**: на `/transactions` прочитать `isSecureContext`, регистрации SW,
  `Page.getInstallabilityErrors`, `Page.getAppManifest`, `/offline.html`, Настройки → Уведомления.
- **Ожидание**: secure context, worker `activated` со scope `/`, installability без ошибок,
  манифест парсится, `/offline.html` доступен, секция пушей показывает server-off арм.
- **Status**: ✅ — `isSecureContext: true`; регистрация `{scope:'https://localhost:8443/',
  active:'activated', script:'…/sw.js'}`, страница им контролируется; `installabilityErrors: []`;
  `getAppManifest.errors: []`, манифест `{name:Budget, start_url:/, display:standalone,
  icons:192/512/512-maskable}`; `/offline.html` 200 `text/html`; Настройки:
  «Уведомления недоступны — на сервере не настроены ключи» (`GET /api/push/config` 200).

### J4b: рендер `/offline.html` при мёртвом бэкенде
- **Status**: ⏸ blocked — останавливать контейнеры запрещено (параллельный прогон qa-engineer),
  а `Network.emulateNetworkConditions{offline:true}` не распространяется на таргет SW, поэтому
  навигация прошла через воркер в сеть. Поведение закрыто скоупом `web-pwa`; здесь доказано
  лишь, что воркер активен и `/offline.html` отдаётся. Побочно: при недоступном API экраны
  показывают восстановимое «Не удалось загрузить счета. Повторить», а не белый лист.

### J5: TLS, заголовки, отсутствие mixed content
- **Действие**: заголовки ответа документа + скан всех URL страницы.
- **Ожидание**: HSTS, nosniff, никаких `http://` подресурсов.
- **Status**: ✅ — `strict-transport-security: max-age=31536000`, `x-content-type-options: nosniff`,
  `cache-control: no-store`, `via: 1.1 Caddy`, HTTP/2. Не-https запросов: `[]`.
  Побочно (curl): `http://localhost:8480/` → 308 на `https://localhost/` — порт теряется, но в
  проде Caddy слушает 80/443, так что это артефакт локального стенда, не дефект.

### J6: выход, защищённые маршруты, неверный пароль
- **Действие**: «Выйти»; затем открыть `/stats` без сессии; затем логин с неверным паролем.
- **Ожидание**: редирект на `/login`, `budget.auth` очищен, защищённый маршрут недостижим,
  ошибка пароля — текстом, не крашем.
- **Status**: ✅ — после logout `/login?next=%2Ftransactions`, `localStorage['budget.auth'] === null`;
  `/stats` → `/login?next=%2Fstats`; неверный пароль: `POST /api/auth/login` 400 и на экране
  «Неверная почта или пароль.», форма жива. Console errors: none (кроме сетевой записи о 400).

### J7: мобильная ширина (ради чего и делается деплой)
- **Действие**: эмуляция 375×812, `/transactions`.
- **Ожидание**: нет горизонтальной прокрутки, навигация достижима.
- **Status**: ✅ — `scrollWidth 375 === clientWidth 375`, бургер-кнопка присутствует.

## Summary
Total 9 (J1, J2, J3, J3b, J4, J4b, J5, J6, J7) / Passed 8 / Failed 0 / Blocked 1
(J4b — нельзя гасить контейнеры; поведение закрыто скоупом `web-pwa`).

✅ READY FOR REVIEW — браузерных дефектов не найдено.
