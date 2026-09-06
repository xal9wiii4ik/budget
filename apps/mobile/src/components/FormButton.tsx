// Primary/secondary/danger/ghost button with a built-in pending state and a
// >= 44pt touch target. RN-primitive only.
//
// `ghost` is the row-level / toolbar text action (a header "+", "Remove",
// "Replace photo") that screens used to write as a bare accent-coloured Text
// inside a Pressable — same look, one implementation, and it keeps the button
// a11y role and the disabled/pending states those ad-hoc texts never had.
import { ActivityIndicator, Pressable, Text, type StyleProp, type ViewStyle } from 'react-native';

import { themedStyles } from '../theme/themedStyles';
import { TOUCH_TARGET } from '../theme/tokens';
import { useTheme } from '../theme/useTheme';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

interface FormButtonProps {
  label: string;
  onPress: () => void;
  variant?: Variant;
  /** `sm` is 36pt tall for a row/toolbar action; hitSlop keeps it >= 44pt. */
  size?: Size;
  disabled?: boolean;
  pending?: boolean;
  style?: StyleProp<ViewStyle>;
}

const SM_HEIGHT = 36;
// Half the shortfall on each edge: a 36pt control still answers to a 44pt finger.
const SM_HIT_SLOP = (TOUCH_TARGET - SM_HEIGHT) / 2;

export function FormButton({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled,
  pending,
  style,
}: FormButtonProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const isDisabled = disabled || pending;
  // The spinner replaces the LABEL, so it takes the label's colour.
  const indicatorColor =
    variant === 'primary'
      ? colors.accentFg
      : variant === 'danger'
        ? colors.dangerFg
        : colors.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: pending }}
      disabled={isDisabled}
      hitSlop={size === 'sm' ? SM_HIT_SLOP : undefined}
      onPress={onPress}
      style={[
        styles.button,
        size === 'sm' ? styles.sizeSm : styles.sizeMd,
        variant === 'primary' && styles.primary,
        variant === 'secondary' && styles.secondary,
        variant === 'danger' && styles.danger,
        // A ghost has no box, so the disabled fill would invent one; its
        // disabled state is the label colour below.
        isDisabled && variant !== 'ghost' && styles.disabled,
        style,
      ]}
    >
      {pending ? (
        <ActivityIndicator color={indicatorColor} />
      ) : (
        <Text
          style={[
            styles.label,
            size === 'sm' && styles.labelSm,
            (variant === 'secondary' || variant === 'ghost') && styles.accentLabel,
            variant === 'danger' && styles.dangerLabel,
            isDisabled && styles.disabledLabel,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const useStyles = themedStyles((t) => ({
  button: {
    borderRadius: t.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: t.spacing.lg,
  },
  sizeMd: {
    minHeight: t.TOUCH_TARGET,
  },
  sizeSm: {
    minHeight: SM_HEIGHT,
    paddingHorizontal: t.spacing.sm,
  },
  primary: {
    backgroundColor: t.colors.accent,
  },
  secondary: {
    backgroundColor: t.colors.surface,
    borderWidth: 1,
    borderColor: t.colors.accent,
  },
  danger: {
    backgroundColor: t.colors.danger,
  },
  disabled: {
    backgroundColor: t.colors.surfaceMuted,
    borderColor: t.colors.surfaceMuted,
  },
  label: {
    color: t.colors.accentFg,
    fontSize: t.type.md,
    fontWeight: '600',
  },
  labelSm: {
    fontSize: t.type.sm,
    // Repeats the base weight on purpose: applyTypeface turns every TEXT entry
    // into a static Inter face, and a size-only override would resolve to
    // Regular and silently un-bold the label it is layered on — see the
    // authoring rule in applyTypeface.ts.
    fontWeight: '600',
  },
  accentLabel: {
    color: t.colors.accent,
  },
  dangerLabel: {
    color: t.colors.dangerFg,
  },
  disabledLabel: {
    color: t.colors.textSubtle,
  },
}));
