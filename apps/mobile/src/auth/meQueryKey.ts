// The ['me'] query key lives in its own module so useAuth (which invalidates it after
// login/register) does not have to import useMe (which imports useIsAuthenticated
// from useAuth) — that import loop was the "Require cycle" warning Metro logged on
// every launch (F-2).
export const meQueryKey = ['me'] as const;
