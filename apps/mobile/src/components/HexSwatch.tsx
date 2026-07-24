// Live color-swatch preview guarded by the SHARED HEX_COLOR_PATTERN (AM-hex): the
// pattern is exported from @budget/shared and this is mobile's second consumer. An
// invalid/partial hex string renders the neutral empty swatch rather than passing
// junk to the native color parser.
import { HEX_COLOR_PATTERN } from '@budget/shared';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { colors } from './theme';

interface HexSwatchProps {
  color: string;
  size?: number;
}

function HexSwatchImpl({ color, size = 28 }: HexSwatchProps) {
  const valid = HEX_COLOR_PATTERN.test(color);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.swatch,
        { width: size, height: size, backgroundColor: valid ? color : colors.swatchEmpty },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  swatch: {
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
});

export const HexSwatch = memo(HexSwatchImpl);
