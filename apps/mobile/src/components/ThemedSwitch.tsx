import { Switch, type SwitchProps } from 'react-native';

import { useTheme } from '../theme/useTheme';

/**
 * A `Switch` that takes its colours from the theme. The bare RN control paints
 * its OFF track white on iOS whatever the app around it looks like — the two
 * white pills the dark-theme pass found were exactly that. Track and thumb now
 * follow the palette, so the control is ours in both schemes.
 */
export function ThemedSwitch(props: SwitchProps) {
  const { colors } = useTheme();
  return (
    <Switch
      trackColor={{ false: colors.borderStrong, true: colors.accent }}
      thumbColor={colors.surface}
      ios_backgroundColor={colors.borderStrong}
      {...props}
    />
  );
}
