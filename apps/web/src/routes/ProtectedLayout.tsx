import { NavLink, Navigate, Outlet, useLocation } from 'react-router';

import { coordinator } from '../lib/api';
import { NETWORK_MESSAGE } from '../lib/errors';
import { queryPhase } from '../lib/queryPhase';
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
  const mePhase = queryPhase(me);
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
            <NavLink to="/stats" className={navClass}>
              Stats
            </NavLink>
            <NavLink to="/advisor" className={navClass}>
              AI
            </NavLink>
            {/* accounts-and-transfers W1: next to Categories, the other setup
                screen — and before it, because an account is what a transaction
                cannot be recorded without. */}
            <NavLink to="/accounts" className={navClass}>
              Accounts
            </NavLink>
            <NavLink to="/categories" className={navClass}>
              Categories
            </NavLink>
            {/* WR-1: a top-level item because this is the screen that explains
                machine-created money (D9) — placed next to Categories, the other
                setup/management screen. */}
            <NavLink to="/recurring" className={navClass}>
              Recurring
            </NavLink>
            <NavLink to="/goals" className={navClass}>
              Goals
            </NavLink>
            {/* Last, and deliberately so: it is the account-level screen (access
                tokens), not one of the money screens above it. */}
            <NavLink to="/settings" className={navClass}>
              Settings
            </NavLink>
          </nav>
        </div>
        <div className={styles.user}>
          {/* A1: a terminally-errored me-query (retries exhausted, non-401) surfaces
              an inline, actionable affordance instead of a silent blank. The shell and
              nav still render; content below is not blocked. A 401 never reaches here
              (the coordinator owns it).
              W1: the same affordance now also covers 'unreachable' (a paused query,
              which reported `isPending` and rendered the email skeleton forever). It
              keeps this inline header markup rather than <QueryStateNotice> — the
              shared notice is a block-level alert for a screen's main content, and
              this one lives inside the header's flex row. */}
          {mePhase === 'error' || mePhase === 'unreachable' ? (
            <span className={styles.meError} role="alert">
              {mePhase === 'unreachable' ? NETWORK_MESSAGE : "Couldn't load your account."}
              <button
                type="button"
                className={styles.meRetry}
                onClick={() => me.refetch()}
              >
                Retry
              </button>
            </span>
          ) : mePhase === 'loading' ? (
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
