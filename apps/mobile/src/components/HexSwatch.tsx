// Live color-swatch preview guarded by the SHARED HEX_COLOR_PATTERN (AM-hex): the
// pattern is exported from @budget/shared and this is mobile's second consumer. An
// invalid/partial hex string renders the neutral empty swatch rather than passing
// junk to the native color parser.
import { HEX_COLOR_PATTERN } from '@budget/shared';
import { memo } from 'react';
import { View } from 'react-native';

import { themedStyles } from '../theme/themedStyles';
import { useTheme } from '../theme/useTheme';

interface HexSwatchProps {
  color: string;
  size?: number;
}

function HexSwatchImpl({ color, size = 28 }: HexSwatchProps) {
  const styles = useStyles();
  // The ONE variable colour in the app: it is the user's own hex, read from the
  // form field, so it cannot come out of the palette. The FALLBACK does.
  const { colors } = useTheme();
  const valid = HEX_COLOR_PATTERN.test(color);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.swatch,
        { width: size, height: size, backgroundColor: valid ? color : colors.surfaceMuted },
      ]}
    />
  );
}

const useStyles = themedStyles((t) => ({
  swatch: {
    borderRadius: t.radius.sm,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
}));

export const HexSwatch = memo(HexSwatchImpl);
