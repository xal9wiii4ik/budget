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
  buildCategoryPatch,
  buildGoalPatch,
  buildTransactionPatch,
  emptyToNull,
} from "./patch";
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
