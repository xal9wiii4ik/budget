type NavIconName =
  | 'transactions'
  | 'accounts'
  | 'deposits'
  | 'stats'
  | 'categories'
  | 'recurring'
  | 'goals'
  | 'advisor'
  | 'settings'
  | 'menu'
  | 'close';

const PATHS: Record<NavIconName, string> = {
  transactions: 'M4 8h13m0 0-3-3m3 3-3 3M20 16H7m0 0 3-3m-3 3 3 3',
  accounts: 'M3 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Zm13 4.5h3',
  deposits:
    'M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm8 3.5v5m-2.5-2.5h5',
  stats: 'M3 20h18M6.5 20v-6M11.5 20V6M16.5 20v-9',
  categories:
    'M11.5 4H5a1 1 0 0 0-1 1v6.5l8.3 8.3a1.5 1.5 0 0 0 2.1 0l5.4-5.4a1.5 1.5 0 0 0 0-2.1ZM8 8h.01',
  recurring:
    'M17 3.5l3.5 3.5L17 10.5M20.5 7H7a3.5 3.5 0 0 0-3.5 3.5v1M7 20.5 3.5 17 7 13.5M3.5 17H17a3.5 3.5 0 0 0 3.5-3.5v-1',
  goals: 'M12 3a9 9 0 1 0 9 9M12 8a4 4 0 1 0 4 4M12 12l4.5-4.5M16.5 7.5V4l3.5 3.5Z',
  advisor:
    'M12 3.5l1.7 4.3 4.3 1.7-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7ZM18 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9Z',
  settings: 'M4 7h9m4 0h3M4 17h3m4 0h9M15 4.5v5M9 14.5v5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
};

/**
 * The shell's icon set — inline SVG, no icon package. 18px, stroked in
 * currentColor so a link's active/hover colour carries the icon with it.
 * Always aria-hidden: every icon here sits next to its own text label.
 */
export function NavIcon({ name }: { name: NavIconName }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
