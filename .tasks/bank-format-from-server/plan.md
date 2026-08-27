# Implementation Plan: bank-format-from-server (API)

## Approach
Один read-only маршрут поверх готового реестра. `PARSERS` — `Mapping[str, ...]`
на dict-литерале, порядок вставки = порядок реестра, поэтому `list(PARSERS)`
и есть контрактный ответ; ничего кэшировать и дублировать не нужно.

## Files to modify
- `apps/api/src/budget_api/schemas/statement_import.py` — `StatementFormatsRead`
  (`formats: list[str]`) с комментарием, почему это не enum (новый банк не должен
  ломать клиента).
- `apps/api/src/budget_api/routers/statement_imports.py` — `GET /formats`,
  объявлен ДО `/{import_id}` (иначе "formats" уедет в path-параметр UUID → 422);
  `Depends(current_user_jwt_or_pat)` как у остальных read-маршрутов; в
  `PAT_ALLOWLIST` пару НЕ добавляем — fail-closed даст 403.
- `apps/api/tests/test_statement_imports_api.py` — два теста (см. ниже).
- контрактная пара: `apps/api/openapi.json` + `packages/api-client/src/generated/schema.d.ts`
  через `pnpm openapi`.

## Tests
- `/formats` == `list(PARSERS)` — импорт реестра в тест, не второй список.
- 401 без токена: у роутера нет общего auth-теста (проверено grep'ом), а этот
  маршрут не user-scoped — забытая зависимость не даст других симптомов.
- `STATEMENT_FORMAT_UNKNOWN` уже покрыт:
  `tests/test_statement_imports_api.py::TestStatementUpload::test_a_refused_upload_stores_nothing` — не дублируем.

## Risks
Порядок маршрутов и CORS-verb-список (GET уже есть). Дрейф-тесты api-client/mcp-server
должны позеленеть только за счёт регенерации.
