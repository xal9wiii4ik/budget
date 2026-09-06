// The surface box every screen used to hand-roll (`borderRadius: 12,
// borderWidth: 1, backgroundColor: card`). Depth is border + surface tone, as on
// web — no shadows.
//
// THE LIST RULE: a list is ONE `<Card padding="none">` with hairline-separated
// rows, never a card per row. A card per row turns a scroll into a stack of
// floating boxes and doubles every border. The one deliberate exception is the
// goals list, where a goal genuinely IS a card (web too).
import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { themedStyles } from '../theme/themedStyles';

interface CardProps {
  children: ReactNode;
  /** `none` for a card that holds its own rows/list and pads them itself. */
  padding?: 'none' | 'sm' | 'md';
  style?: StyleProp<ViewStyle>;
}

export function Card({ children, padding = 'md', style }: CardProps) {
  const styles = useStyles();
  return (
    <View
      style={[
        styles.card,
        padding === 'sm' && styles.paddingSm,
        padding === 'md' && styles.paddingMd,
        style,
      ]}
    >
      {children}
    </View>
  );
}

const useStyles = themedStyles((t) => ({
  card: {
    backgroundColor: t.colors.surface,
    borderWidth: 1,
    borderColor: t.colors.border,
    borderRadius: t.radius.lg,
    overflow: 'hidden',
  },
  paddingSm: {
    padding: t.spacing.sm,
  },
  paddingMd: {
    padding: t.spacing.lg,
  },
}));
