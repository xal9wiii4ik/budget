import { useT } from '../i18n/context';
import { THEME_PREFERENCES, type ThemePreference } from './theme';
import { useTheme } from './useTheme';
import styles from './ThemeToggle.module.css';

const LABEL_KEY = {
  light: 'theme.light',
  system: 'theme.system',
  dark: 'theme.dark',
} as const;

function ThemeIcon({ preference }: { preference: ThemePreference }) {
  // 18px inline SVG — no icon library, no runtime download.
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (preference === 'light') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  if (preference === 'dark') {
    return (
      <svg {...common}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

interface ThemeToggleProps {
  className?: string;
}

/**
 * Light / system / dark as a segmented control rather than a cycling button: the
 * three states are not orderable in the user's head ("what comes after system?"),
 * and `system` — the default — has to be reachable in one click after a manual pick.
 */
export function ThemeToggle({ className }: ThemeToggleProps) {
  const t = useT();
  const { theme, setTheme } = useTheme();

  return (
    <div
      className={className ? `${styles.group} ${className}` : styles.group}
      role="group"
      aria-label={t('theme.label')}
    >
      {THEME_PREFERENCES.map((preference) => (
        <button
          key={preference}
          type="button"
          className={styles.option}
          aria-pressed={theme === preference}
          aria-label={t(LABEL_KEY[preference])}
          title={t(LABEL_KEY[preference])}
          onClick={() => setTheme(preference)}
        >
          <ThemeIcon preference={preference} />
        </button>
      ))}
    </div>
  );
}
