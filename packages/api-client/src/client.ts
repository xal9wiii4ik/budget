import createClient from "openapi-fetch";

import type { paths } from "./generated/schema";

export type ApiClient = ReturnType<typeof createClient<paths>>;

export function createApiClient(options: {
  baseUrl: string;
  // openapi-fetch always hands the injected fetch a fully-built `Request`, so we
  // type the seam that way (matching openapi-fetch's own ClientOptions["fetch"]).
  // This is the reuse boundary the mobile client plugs its async authFetch into.
  fetch?: (input: Request) => Promise<Response>;
}): ApiClient {
  return createClient<paths>({ baseUrl: options.baseUrl, fetch: options.fetch });
}
