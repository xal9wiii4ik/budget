// A small status tag: soft fill + the matching soft foreground, the same pair
// web uses. It replaces the hand-rolled paused/ended/archived tags, which each
// carried their own literal colours.
//
// A badge is a LABEL, not a control: no press handling, no touch target.
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { themedStyles } from '../theme/themedStyles';

type Tone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning';

interface BadgeProps {
  label: string;
  tone?: Tone;
  style?: StyleProp<ViewStyle>;
}

export function Badge({ label, tone = 'neutral', style }: BadgeProps) {
  const styles = useStyles();
  return (
    <View style={[styles.badge, styles[`${tone}Box`], style]}>
      <Text style={[styles.label, styles[`${tone}Text`]]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const useStyles = themedStyles((t) => ({
  badge: {
    alignSelf: 'flex-start',
    borderRadius: t.radius.sm,
    paddingHorizontal: t.spacing.sm,
    paddingVertical: 2,
  },
  label: {
    fontSize: t.type.xs,
    fontWeight: '600',
  },
  neutralBox: { backgroundColor: t.colors.surfaceMuted },
  neutralText: { color: t.colors.textMuted },
  accentBox: { backgroundColor: t.colors.accentSoft },
  accentText: { color: t.colors.accentSoftFg },
  successBox: { backgroundColor: t.colors.successSoft },
  successText: { color: t.colors.successSoftFg },
  dangerBox: { backgroundColor: t.colors.dangerSoft },
  dangerText: { color: t.colors.dangerSoftFg },
  warningBox: { backgroundColor: t.colors.warningSoft },
  warningText: { color: t.colors.warningSoftFg },
}));
