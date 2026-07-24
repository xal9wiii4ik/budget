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
