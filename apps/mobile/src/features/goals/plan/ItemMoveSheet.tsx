// Re-parent one node (mobile-catchup-3, line C) — web's ItemMoveDialog as a
// bottom sheet.
//
// The picker offers only targets that CAN succeed: `moveTargets`
// (@budget/api-client, shared with web) excludes the node itself, its descendants
// (that is the cycle) and anything too deep to hold the moved subtree. It is a
// pre-filter, NOT the guarantee — another device can make a listed target illegal
// between render and save, so 422 GOAL_ITEM_CYCLE / GOAL_ITEM_DEPTH_EXCEEDED are
// routed back into this sheet.
//
// Position among siblings is NOT set here: the server appends the moved node to
// its new siblings, and the row's up/down actions take it from there.
//
// A native `Modal` rather than a route: the sheet is a choice ABOUT the row
// behind it, it holds no text input (so no keyboard to avoid), and a route would
// have to re-fetch the tree it is filtering.
import { moveTargets } from '@budget/api-client';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FormButton } from '../../../components/FormButton';
import { colors, spacing, TOUCH_TARGET } from '../../../components/theme';
import type { GoalItemRead } from '../../../data/goalItems';
import { useT } from '../../../i18n/context';

interface ItemMoveSheetProps {
  item: GoalItemRead;
  items: readonly GoalItemRead[];
  /** Already-translated message of a failed move, shown in place. */
  error?: string;
  pending: boolean;
  onPick: (parentId: string | null) => void;
  onClose: () => void;
}

export function ItemMoveSheet({
  item,
  items,
  error,
  pending,
  onPick,
  onClose,
}: ItemMoveSheetProps) {
  const t = useT();
  const targets = moveTargets(items, item.id);

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      // Android's hardware back must close the sheet, not the screen under it.
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={8}>
            <Text style={styles.cancel}>{t('common.cancel')}</Text>
          </Pressable>
          {/* The node's NAME is user text, interpolated and never translated. */}
          <Text style={styles.title} numberOfLines={1}>
            {t('goalPlan.moveTitle', { name: item.name })}
          </Text>
          <View style={styles.headerSpacer} />
        </View>

        <Text style={styles.hint}>{t('goalPlan.moveHint')}</Text>
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}

        <FlatList
          data={targets}
          keyExtractor={(target) => target.id}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            // Becoming a ROOT is always legal — a subtree can never be taller
            // than the limit to begin with — so it is offered unconditionally and
            // `moveTargets` carries real parents only.
            <Option
              label={t('goalPlan.moveToRoot')}
              depth={1}
              selected={item.parent_id === null}
              disabled={pending}
              onPress={() => onPick(null)}
            />
          }
          renderItem={({ item: target }) => (
            <Option
              label={target.name}
              depth={target.depth}
              selected={item.parent_id === target.id}
              disabled={pending}
              onPress={() => onPick(target.id)}
            />
          )}
          ListEmptyComponent={<Text style={styles.hint}>{t('goalPlan.moveNoTargets')}</Text>}
        />

        <View style={styles.footer}>
          <FormButton label={t('common.cancel')} variant="secondary" onPress={onClose} />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function Option({
  label,
  depth,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  depth: number;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.option, { paddingLeft: spacing.lg + (depth - 1) * 16 }]}
    >
      <Text style={[styles.optionText, selected && styles.optionSelected]} numberOfLines={1}>
        {label}
      </Text>
      {selected ? <Text style={styles.currentTag}>✓</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '700',
    color: colors.text,
  },
  cancel: {
    fontSize: 16,
    color: colors.primary,
    minWidth: 60,
  },
  headerSpacer: {
    minWidth: 60,
  },
  hint: {
    fontSize: 13,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  error: {
    fontSize: 14,
    color: colors.danger,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  listContent: {
    paddingVertical: spacing.sm,
  },
  option: {
    minHeight: TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: spacing.lg,
    paddingVertical: spacing.sm,
  },
  optionText: {
    flex: 1,
    fontSize: 15,
    color: colors.text,
  },
  optionSelected: {
    fontWeight: '700',
  },
  currentTag: {
    fontSize: 15,
    color: colors.primary,
  },
  footer: {
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
});
