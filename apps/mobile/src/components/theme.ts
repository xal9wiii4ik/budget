// Minimal shared design tokens for the RN-primitives-only UI (plan §G). No UI
// framework; a handful of colors/spacing constants keep the screens consistent.
export const colors = {
  bg: '#F5F6F8',
  card: '#FFFFFF',
  border: '#E2E5EA',
  text: '#1A1D21',
  textMuted: '#6B7280',
  primary: '#208AEF',
  danger: '#D14343',
  income: '#1F8A4C',
  expense: '#C43E3E',
  swatchEmpty: '#D1D5DB',
  disabled: '#A9BCD0',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

// Minimum interactive height for touch targets (>= 44pt, agent UX baseline).
export const TOUCH_TARGET = 44;
