import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';

import { coordinator } from '../lib/api';
import { useIsAuthenticated } from './useAuth';

interface RequireAuthProps {
  children: ReactNode;
}

/**
 * The app's ONE session gate, extracted from `ProtectedLayout` in mcp-remote W1
 * so that a screen can need the session WITHOUT needing the nav shell: the OAuth
 * consent page is a dialogue a third party opened, and a sidebar inviting the
 * user off to /stats in the middle of granting access is the wrong page.
 *
 * It is a `{children}` wrapper rather than a second layout route on purpose —
 * there is nothing to lay out, only a redirect to decide, and the redirect
 * expression (`?next=` + the `reason=expired` suffix) must stay written exactly
 * once.
 *
 * Gates on SYNCHRONOUS token presence, never on the me-query, so navigation does
 * not block on a round-trip. `reason=expired` is appended only for a terminal
 * refresh failure — not for an intentional logout or a cold visit.
 */
export function RequireAuth({ children }: RequireAuthProps) {
  const isAuthenticated = useIsAuthenticated();
  const location = useLocation();

  if (!isAuthenticated) {
    // pathname + search, encoded: this is what carries `?req=<uuid>` through the
    // login (and the register) screen back to the consent page.
    const next = encodeURIComponent(location.pathname + location.search);
    const suffix = coordinator.wasSessionExpired() ? '&reason=expired' : '';
    return <Navigate to={`/login?next=${next}${suffix}`} replace />;
  }

  return <>{children}</>;
}
