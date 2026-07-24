import createClient from "openapi-fetch";

import type { paths } from "./generated/schema";

export type ApiClient = ReturnType<typeof createClient<paths>>;

export function createApiClient(options: {
  baseUrl: string;
  fetch?: typeof fetch;
}): ApiClient {
  return createClient<paths>({ baseUrl: options.baseUrl, fetch: options.fetch });
}
