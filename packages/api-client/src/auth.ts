// PLATFORM-FREE MODULE — do NOT reference web/DOM globals here (AM-2, mobile
// constraint 1). No `window`, `document`, `localStorage`, `sessionStorage`,
// `navigator`, or any DOM/browser API may appear in this file or in
// `getErrorCode`. These helpers operate ONLY on the passed `ApiClient`, plain
// arguments, and returned values so the React Native client (task 1.8, which has
// none of those globals) reuses them unchanged. The senior greps this file at
// diff review — any web global here is an automatic send-back.

import type { ApiClient } from "./client";
import type { components } from "./generated/schema";

/** JWT access+refresh pair returned by /auth/login and /auth/refresh. */
export type TokenPair = components["schemas"]["TokenPair"];
/** The authenticated user object from /users/me and /auth/register. */
export type UserRead = components["schemas"]["UserRead"];
/** The single {detail} error envelope (string code | {code,reason} object). */
export type ErrorModel = components["schemas"]["ErrorModel"];

/**
 * POST /auth/login — form-encoded (1.1 §7.1 carry-forward 1). openapi-fetch
 * 0.17.0 hard-defaults a JSON Content-Type; the login endpoint 422s without an
 * explicit form Content-Type AND a urlencoded body serializer, so we set BOTH
 * defensively. The server's OAuth2 form expects `username`, so email maps to it.
 */
export function login(client: ApiClient, email: string, password: string) {
  return client.POST("/auth/login", {
    body: { username: email, password, scope: "" },
    bodySerializer: (body) => {
      const params = new URLSearchParams();
      params.set("username", body.username);
      params.set("password", body.password);
      params.set("scope", body.scope ?? "");
      return params.toString();
    },
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

/** POST /auth/refresh — exchange a (single-use, rotating) refresh token for a new pair. */
export function refresh(client: ApiClient, refreshToken: string) {
  return client.POST("/auth/refresh", {
    body: { refresh_token: refreshToken },
  });
}

/** POST /auth/logout — server-side revoke of the given refresh token (204, no bearer). */
export function logout(client: ApiClient, refreshToken: string) {
  return client.POST("/auth/logout", {
    body: { refresh_token: refreshToken },
    // Let the revoke complete even if the tab closes right after Log out.
    // `keepalive` is a plain standard RequestInit field (no web global — AM-2
    // safe; RN ignores it harmlessly); openapi-fetch spreads it into the Request.
    keepalive: true,
  });
}

/**
 * POST /auth/register — create an account. Returns UserRead, NO tokens (the app
 * auto-chains a login). email+password only; the stock BaseUserCreate privilege
 * fields are dropped server-side (carry-forward 3).
 */
export function register(client: ApiClient, email: string, password: string) {
  return client.POST("/auth/register", {
    body: { email, password, is_active: true, is_superuser: false, is_verified: false },
  });
}

/**
 * Narrow a parsed error body to its stable machine code, per the single {detail}
 * envelope (1.1 §7.3). Returns the raw code string only — the CALLER owns the
 * code -> user-copy mapping (so new codes extend a table, not this function):
 *   - detail is a string  -> the code itself (LOGIN_BAD_CREDENTIALS,
 *     REGISTER_USER_ALREADY_EXISTS, RATE_LIMITED, ...).
 *   - detail is an object -> REGISTER_INVALID_PASSWORD's {code, reason}; return
 *     detail.code when it is a string.
 *   - anything else (e.g. a Pydantic ValidationError[] array) -> undefined.
 */
export function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const detail = (error as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (typeof detail === "object" && detail !== null) {
    const code = (detail as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}
