# Implementation Plan (web): S2 — «Настройки», управление PAT (STANDARD)

## Подход
`/settings` — тонкая CRUD-поверхность над `/tokens` из S1. Список токенов —
server state (Query). Plaintext-строка — локальный `useState` внутри модала
создания, умирает вместе с ним: ни в кэш, ни в Zustand, ни в localStorage
(её нельзя восстановить — значит, и хранить негде).
Стартуем ТОЛЬКО после S1 + `pnpm openapi`; типы — из `components['schemas']`
(имена даст бэкенд), `schema.d.ts` руками не правим, `as` не пишем. Планирую
против architecture.md §3/§8-S1: `POST /tokens`(name,scope) → одноразовый
plaintext, `GET /tokens` → список, `DELETE /tokens/{id}` → soft-revoke (204).

## Экраны / компоненты
- `apps/web/src/App.tsx` — роут `/settings` внутри `ProtectedLayout`.
- `routes/ProtectedLayout.tsx` (+ css) — nav-пункт «Settings» последним в `<nav>`.
- `packages/shared/src/dates.ts` — ДОБАВИТЬ `formatTimestamp(iso,{locale})`
  (medium+short, кэш форматтера): `formatApiDate` берёт только `YYYY-MM-DD` и на
  ISO-датавремени даёт NaN, а локальный `toLocaleString` запрещён правилом.

## Новые компоненты / хуки
- `routes/SettingsPage.tsx` (+ css) — 4 арма `queryPhase`, список, кнопка создания.
- `features/tokens/`: `TokenFormModal.tsx` (RHF+zod: name, scope),
  `TokenCreatedPanel.tsx` (одноразовый показ + копирование), `TokenRow.tsx`.
- `features/tokens/tokenFormSchema.ts` — zod-схема. [ОТКЛОНЕНИЕ от «схемы форм
  в packages/shared»]: второго потребителя нет (мобилка вне скоупа) — решает
  senior-lead, см. открытые вопросы.
- `data/tokens.ts`; `lib/errors.ts` → `describeTokenError`.

## Data-слой
- `queryKeys.ts`: `tokens: () => ['tokens','list'] as const`. Корень `['tokens']`
  НОВЫЙ и дизъюнктен со всеми существующими (docs/web.md); сегмент `'list'` —
  тот же приём key[1], что у goals/recurring, чтобы будущее `['tokens', id, …]`
  не столкнулось со списком. Никакая существующая мутация его не трогает.
- `useTokens()` — GET через `apiClient` + `throwOnError`.
- `useCreateToken()` — POST; `onSuccess` → `invalidateQueries(['tokens'])`; ответ
  с plaintext возвращается вызывающему и в кэш НЕ пишется.
- `useRevokeToken()` — DELETE; 204 разворачиваем руками (прецедент `limits.ts`:
  `throwOnError` считает `data: undefined` ошибкой); `onSuccess` → инвалидация,
  `onError` 404 → тоже (уже отозван в другой вкладке).
- Оптимистичных апдейтов НЕТ: мутации редкие, а оптимистичный отзыв соврал бы
  про `revoked_at`, который ставит сервер.

## UI-состояния
- **loading**: 3 строки-скелета фиксированной высоты (без джанка).
- **unreachable / error**: `<QueryStateNotice>`, все 4 арма `queryPhase()`.
- **empty**: «Токенов пока нет. Создайте токен, чтобы подключить Claude Desktop
  или Code — инструкция в `packages/mcp-server/README.md`» + кнопка создания.
- **создание**: модал → `name` (обяз., ≤100) + `scope` в `<fieldset>/<legend>`,
  два радио `read`/`read_write` (default `read`) с подписями-объяснениями;
  pending — кнопка дизейблена, `closeDisabled` (Modal не спросит discard).
- **успех**: тот же модал переключается на `TokenCreatedPanel` — readonly-строка,
  кнопка «Копировать» (`navigator.clipboard.writeText`, состояние «Скопировано»,
  при отказе «скопируйте вручную», текст выделяем), красный блок «Эту строку мы
  больше НИКОГДА не покажем — сохраните сейчас» ДО кнопки «Готово».
- **список**: активные (created_at desc) сверху, отозванные снизу; name, бейдж
  scope, «создан <formatTimestamp>», «использован <…>» либо «никогда».
  РЕШЕНИЕ: отозванные не скрываем — приглушаем + бейдж «Отозван <дата>», без
  кнопки отзыва; скрытие сделало бы `revoked_at` мёртвым полем.
- **отзыв**: `<ConfirmDialog destructive>` — «Отозвать токен „<name>“? Клиенты с
  ним сразу перестанут работать»; ошибка рендерится внутри диалога.
- a11y: `<h1>`, `<ul>/<li>`, `<button>`, label на инпуте, радио в fieldset,
  фокус держит общий Modal.

## Чистая логика / тесты
Реально ломаемого почти нет (сортировка и лейблы — три строки JSX). Пишем ОДИН
тест — `formatTimestamp` в `packages/shared` (UTC-ISO → локальное время под
пиннутой TZ=America/Los_Angeles: этот сдвиг ломается молча). `tokenStatus.ts` с
node-vitest — только если сортировка+лейблы вылезут за пределы JSX.

## Открытые вопросы
1. `tokenFormSchema` рядом с фичей (моё предложение) или в `packages/shared`?
2. Точные имена схем/полей `/tokens`, коды 201/204 — сверю после regen; язык
   строк: UI веба английский, тексты выше — черновик смысла.

## Риски
- Старт до S1/regen → соблазн `as` и ручной правки `schema.d.ts`. Митигация:
  S2 не начинается, пока `pnpm openapi` не прошёл.
- Утечка plaintext в кэш/URL/логи — явный пункт ревью; Clipboard вне secure
  context — фолбэк обязателен.
- `formatTimestamp` трогает shared (его читает и мобилка): только новый экспорт.
