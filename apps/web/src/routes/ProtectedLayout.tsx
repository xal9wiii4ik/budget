import { useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Outlet, useLocation } from 'react-router';

import { Button } from '../components/Button';
import { coordinator } from '../lib/api';
import { useLang, useT } from '../i18n/context';
import { networkMessage } from '../lib/errors';
import { queryPhase } from '../lib/queryPhase';
import { LanguageToggle } from '../i18n/LanguageToggle';
import { ThemeToggle } from '../theme/ThemeToggle';
import { useIsAuthenticated } from '../auth/useAuth';
import { useLogout } from '../auth/useAuth';
import { useMe } from '../auth/useMe';
import { NavIcon } from './NavIcon';
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

/**
 * Navigation, in two groups. Same destinations and same labels as the flat bar
 * this replaced; the grouping is what makes nine items readable.
 *
 * Money — what actually happened to the money. Accounts sits before Deposits
 * because an account is what a transaction cannot be recorded without (W1), and
 * Deposits answers the question Accounts raises: where the money that is on no
 * account went (deposits W1).
 *
 * Planning — the setup/management screens: what money is FOR. Recurring is here
 * as the screen that explains machine-created money (WR-1, D9); the advisor is
 * an aid to planning, not a ledger.
 */
const NAV_GROUPS = [
  {
    labelKey: 'nav.group.money',
    items: [
      { to: '/transactions', labelKey: 'nav.transactions', icon: 'transactions' },
      { to: '/accounts', labelKey: 'nav.accounts', icon: 'accounts' },
      { to: '/deposits', labelKey: 'nav.deposits', icon: 'deposits' },
      { to: '/stats', labelKey: 'nav.stats', icon: 'stats' },
    ],
  },
  {
    labelKey: 'nav.group.planning',
    items: [
      { to: '/categories', labelKey: 'nav.categories', icon: 'categories' },
      { to: '/recurring', labelKey: 'nav.recurring', icon: 'recurring' },
      { to: '/goals', labelKey: 'nav.goals', icon: 'goals' },
      { to: '/advisor', labelKey: 'nav.advisor', icon: 'advisor' },
    ],
  },
] as const;

/**
 * Settings — deliberately apart: access tokens and preferences are account-level,
 * not one of the money screens above. It gets no group heading of its own, because
 * the only honest heading for it ("Account") reads as a second name for the
 * Accounts item in the same panel. A hairline separator says the same thing
 * without the collision.
 */
const SETTINGS_ITEM = { to: '/settings', labelKey: 'nav.settings', icon: 'settings' } as const;

function ProtectedShell() {
  const lang = useLang();
  const t = useT();
  const me = useMe();
  const mePhase = queryPhase(me);
  const logout = useLogout();
  const location = useLocation();
  const navRef = useRef<HTMLElement>(null);

  // Under 900px the panel is a drawer, and a drawer that survives the navigation
  // it just caused hides the screen the user asked for. So "open" is stored as
  // THE ROUTE IT WAS OPENED ON and the closed-on-navigation state is DERIVED
  // during render — no effect, no cascading re-render of the whole shell.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const menuOpen = openedAt !== null && openedAt === location.key;
  const setMenuOpen = (open: boolean) => setOpenedAt(open ? location.key : null);

  // Real DOM effects of an open drawer: Esc closes it, the page behind it does
  // not scroll, and focus moves into it (otherwise a keyboard user's next Tab
  // lands somewhere behind the overlay).
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // setOpenedAt, not setMenuOpen: the raw setter is stable, so this
      // subscription does not re-bind on every navigation.
      if (event.key === 'Escape') setOpenedAt(null);
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    navRef.current?.querySelector<HTMLAnchorElement>('a')?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [menuOpen]);

  // Growing past 900px turns the drawer back into the static column; the open
  // flag must not outlive it, or the body stays scroll-locked with no way back.
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 900px)');
    const onChange = () => {
      if (wide.matches) setOpenedAt(null);
    };
    wide.addEventListener('change', onChange);
    return () => wide.removeEventListener('change', onChange);
  }, []);

  const navClass = ({ isActive }: { isActive: boolean }) =>
    isActive ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink;

  return (
    <div className={styles.shell}>
      <div className={styles.topbar}>
        <span className={styles.brand}>Budget</span>
        <div className={styles.topbarActions}>
          <button
            type="button"
            className={styles.burger}
            aria-expanded={menuOpen}
            aria-controls="app-sidebar"
            aria-label={t(menuOpen ? 'nav.closeMenu' : 'nav.openMenu')}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <NavIcon name={menuOpen ? 'close' : 'menu'} />
          </button>
        </div>
      </div>

      {menuOpen ? (
        <div className={styles.backdrop} role="presentation" onClick={() => setMenuOpen(false)} />
      ) : null}

      <aside
        id="app-sidebar"
        className={menuOpen ? `${styles.sidebar} ${styles.sidebarOpen}` : styles.sidebar}
      >
        <div className={styles.sidebarHead}>
          <span className={styles.brand}>Budget</span>
        </div>

        <nav className={styles.nav} aria-label={t('nav.primary')} ref={navRef}>
          {NAV_GROUPS.map((group) => (
            <div key={group.labelKey}>
              <p className={styles.groupLabel} id={`nav-group-${group.labelKey}`}>
                {t(group.labelKey)}
              </p>
              <ul className={styles.groupList} aria-labelledby={`nav-group-${group.labelKey}`}>
                {group.items.map((item) => (
                  <li key={item.to}>
                    <NavLink to={item.to} className={navClass}>
                      <NavIcon name={item.icon} />
                      {t(item.labelKey)}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div className={styles.navFooterItem}>
            <NavLink to={SETTINGS_ITEM.to} className={navClass}>
              <NavIcon name={SETTINGS_ITEM.icon} />
              {t(SETTINGS_ITEM.labelKey)}
            </NavLink>
          </div>
        </nav>

        <div className={styles.footer}>
          {/* A1: a terminally-errored me-query (retries exhausted, non-401) surfaces
              an inline, actionable affordance instead of a silent blank. The shell and
              nav still render; content below is not blocked. A 401 never reaches here
              (the coordinator owns it).
              W1: the same affordance also covers 'unreachable' (a paused query, which
              reported `isPending` and rendered the email skeleton forever). It keeps
              this inline markup rather than <QueryStateNotice> — the shared notice is a
              block-level alert for a screen's main content, and this one lives in the
              panel's footer. */}
          {mePhase === 'error' || mePhase === 'unreachable' ? (
            <span className={styles.meError} role="alert">
              {mePhase === 'unreachable' ? networkMessage(lang) : t('shell.meLoadFailed')}
              <Button variant="ghost" size="sm" onClick={() => me.refetch()}>
                {t('common.retry')}
              </Button>
            </span>
          ) : mePhase === 'loading' ? (
            <span className={styles.emailSkeleton} aria-hidden="true" />
          ) : me.data ? (
            <span className={styles.email}>{me.data.email}</span>
          ) : null}
          <div className={styles.footerRow}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              {t(logout.isPending ? 'shell.loggingOut' : 'shell.logout')}
            </Button>
            {/* Wrapper, not a class on the toggle: which module's rule wins would
                otherwise depend on stylesheet order. */}
            <span className={styles.sidebarTheme}>
              <LanguageToggle />
              <ThemeToggle />
            </span>
          </div>
        </div>
      </aside>

      <main className={styles.content}>
        <Outlet />
      </main>
    </div>
  );
}
