import type { components } from "./generated/schema";

export { createApiClient } from "./client";
export type { ApiClient } from "./client";
export type { paths, components } from "./generated/schema";

export {
  login,
  refresh,
  logout,
  register,
  getErrorCode,
} from "./auth";
export type { TokenPair, UserRead, ErrorModel } from "./auth";

export type HealthResponse = components["schemas"]["HealthResponse"];

export {
  buildAccountPatch,
  buildCategoryPatch,
  buildGoalPatch,
  buildRecurringTemplatePatch,
  buildTransactionPatch,
  buildTransferPatch,
  emptyToNull,
} from "./patch";
export type { GoalItemLink } from "./patch";
// The CREATE counterpart of the patch builders (mobile-catchup-2): the one place
// a transaction form's output shape becomes a POST body, for both clients.
export { buildCreateBody } from "./createBody";
// Which money lines a transaction row shows, and what titles it (mobile-catchup-3,
// moved out of apps/web on the `buildCreateBody` precedent): the mobile list grew
// the same spent/charged pair, and a second copy of "which amount leads" is exactly
// the kind of second opinion about money this project does not keep.
export { baseEquivalent, primaryAmount, rowTitle } from "./rowDisplay";
export type {
  BaseEquivalent,
  RowMoneySource,
  RowMoney,
  RowAmounts,
  RowTitleLabels,
} from "./rowDisplay";
// The goal PLAN's pure structure rules (mobile-catchup-3, line C — moved out of
// apps/web, which now re-exports them). All four are structure, never money: the
// tree's order and nesting, which parents a node may legally move under, when the
// transaction form's plan-item field exists, and the item PATCH diff.
export { buildTree, subtreeSize, descendantCount, descendantIds } from "./buildTree";
export type { PlanNode, PlanTree } from "./buildTree";
export { moveTargets, MAX_PLAN_DEPTH } from "./moveTargets";
export type { MoveTarget } from "./moveTargets";
export {
  NO_GOAL_ITEM,
  showsGoalItemField,
  goalItemSelectionForKind,
  goalItemOptions,
} from "./goalItemField";
export type { GoalItemSelection, GoalItemOption } from "./goalItemField";
export { buildGoalItemPatch } from "./goalItemPatch";
export type { GoalItemFormValues } from "./goalItemPatch";
// The SSE escape hatch (0.3 D2c / 4.4 WS-7): hand-written, types-only against the
// generated schema, because `POST /advisor/ask` streams text/event-stream — which
// openapi-fetch cannot parse and EventSource (GET-only) cannot request.
export { askAdvisor } from "./advisor";
export type { AskAdvisorOptions, AdvisorStreamEvent, AdvisorAsk, AdvisorTurn } from "./advisor";
export { createSseFrameParser } from "./sse";
export type { SseFrame, SseFrameParser } from "./sse";

export { ApiError, throwOnError } from "./errors";
export { getValidationIssues, locTailField, routeIssue } from "./errors";
export type { ValidationIssue, FieldError } from "./errors";
