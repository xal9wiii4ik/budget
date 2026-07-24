import { Navigate, Outlet, useLocation } from 'react-router';

import { coordinator } from '../lib/api';
import { useIsAuthenticated } from '../auth/useAuth';
import { useLogout } from '../auth/useAuth';
import { useMe } from '../auth/useMe';
import styles from './ProtectedLayout.module.css';

/**
 * Guard + app shell. Gates on synchronous token presence (never on the me-query,
 * so navigation doesn't block on a round-trip). When unauthenticated it redirects
 * to /login preserving the intended route via `?next=`, appending `reason=expired`
 * only for a terminal refresh failure (not an intentional logout / cold visit).
 */
export function ProtectedLayout() {
  const isAuthenticated = useIsAuthenticated();
  const location = useLocation();

  if (!isAuthenticated) {
    const next = encodeURIComponent(location.pathname + location.search);
    const suffix = coordinator.wasSessionExpired() ? '&reason=expired' : '';
    return <Navigate to={`/login?next=${next}${suffix}`} replace />;
  }

  return <ProtectedShell />;
}

function ProtectedShell() {
  const me = useMe();
  const logout = useLogout();

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.brand}>Budget</span>
        <div className={styles.user}>
          {me.isPending ? (
            <span className={styles.emailSkeleton} aria-hidden="true" />
          ) : me.data ? (
            <span className={styles.email}>{me.data.email}</span>
          ) : null}
          <button
            type="button"
            className={styles.logout}
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            {logout.isPending ? 'Logging out…' : 'Log out'}
          </button>
        </div>
      </header>
      <main className={styles.content}>
        <Outlet />
      </main>
    </div>
  );
}
