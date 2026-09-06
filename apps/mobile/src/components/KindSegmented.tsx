// Segmented control for the expense | income kind choice (AM-1.6-c). RN-primitive
// only. Used by both form modals AND as the category picker's kind segment. Touch
// targets are full-height (>= 44pt).
import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { themedStyles } from '../theme/themedStyles';
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
  const styles = useStyles();

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

// The one selected style that is NOT `t.selected`: a kind is the difference
// between an expense and an income row, so it keeps a FILLED accent (task.md
// ruling 4) — a soft chip that reads as "maybe selected" here costs a wrong row.
const useStyles = themedStyles((t) => ({
  group: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: t.colors.border,
    borderRadius: t.radius.md,
    overflow: 'hidden',
    backgroundColor: t.colors.surface,
  },
  segment: {
    flex: 1,
    minHeight: t.TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: t.spacing.sm,
  },
  segmentSelected: {
    backgroundColor: t.colors.accent,
  },
  label: {
    fontSize: t.type.md,
    fontWeight: '600',
    color: t.colors.text,
  },
  labelSelected: {
    color: t.colors.accentFg,
  },
}));

export const KindSegmented = memo(KindSegmentedImpl);
