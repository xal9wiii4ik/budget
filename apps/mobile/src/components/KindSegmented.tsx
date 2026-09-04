// Segmented control for the expense | income kind choice (AM-1.6-c). RN-primitive
// only. Used by both form modals AND as the category picker's kind segment. Touch
// targets are full-height (>= 44pt).
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, TOUCH_TARGET } from './theme';
import { useT } from '../i18n/context';
import type { SimpleKey } from '../i18n/t';

type Kind = 'expense' | 'income';

interface KindSegmentedProps {
  value: Kind;
  onChange: (kind: Kind) => void;
  disabled?: boolean;
}

const SEGMENTS: { value: Kind; labelKey: SimpleKey }[] = [
  { value: 'expense', labelKey: 'common.expense' },
  { value: 'income', labelKey: 'common.income' },
];

function KindSegmentedImpl({ value, onChange, disabled }: KindSegmentedProps) {
  const t = useT();

  return (
    <View style={styles.group} accessibilityRole="tablist">
      {SEGMENTS.map((segment) => {
        const selected = segment.value === value;
        return (
          <Pressable
            key={segment.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            disabled={disabled}
            onPress={() => onChange(segment.value)}
            style={[styles.segment, selected && styles.segmentSelected]}
          >
            <Text style={[styles.label, selected && styles.labelSelected]}>
              {t(segment.labelKey)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: colors.card,
  },
  segment: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
  },
  segmentSelected: {
    backgroundColor: colors.primary,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  labelSelected: {
    color: '#FFFFFF',
  },
});

export const KindSegmented = memo(KindSegmentedImpl);
