import { NavLink, Navigate, Outlet, useLocation } from 'react-router';

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

  const navClass = ({ isActive }: { isActive: boolean }) =>
    isActive ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink;

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.brand}>Budget</span>
          <nav className={styles.nav} aria-label="Primary">
            <NavLink to="/transactions" className={navClass}>
              Transactions
            </NavLink>
            <NavLink to="/categories" className={navClass}>
              Categories
            </NavLink>
          </nav>
        </div>
        <div className={styles.user}>
          {/* A1: a terminally-errored me-query (retries exhausted, non-401) surfaces
              an inline, actionable affordance instead of a silent blank. The shell and
              nav still render; content below is not blocked. A 401 never reaches here
              (the coordinator owns it). */}
          {me.isError ? (
            <span className={styles.meError} role="alert">
              Couldn&apos;t load your account.
              <button
                type="button"
                className={styles.meRetry}
                onClick={() => me.refetch()}
              >
                Retry
              </button>
            </span>
          ) : me.isPending ? (
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
