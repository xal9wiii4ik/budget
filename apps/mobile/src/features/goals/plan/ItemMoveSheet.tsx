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
//
// SAFE AREA (defect D-1, the rule TxFiltersSheet already follows): a `Modal` is
// its OWN native window, and a `SafeAreaView` rendered inside one measures that
// window — it comes back with zero insets, so the header slides under the clock
// and the footer button under the home indicator. The insets are therefore read
// with `useSafeAreaInsets()` HERE, in the plan screen's tree where the provider's
// numbers are real, and applied as padding. This component is their only owner:
// the screen's own `SafeAreaView edges={['bottom']}` is outside the Modal and does
// not reach in, so nothing is padded twice.
//
// The TOP inset is Android-only in effect: `presentationStyle="pageSheet"` is an
// iOS card that already starts below the status bar, so adding the screen's top
// inset there would open a finger-wide gap above the title. On Android the
// presentation style is ignored and the window is full-screen, which is exactly
// the case the inset exists for.
import { moveTargets } from '@budget/api-client';
import { FlatList, Modal, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FormButton } from '../../../components/FormButton';
import { themedStyles } from '../../../theme/themedStyles';
import { spacing } from '../../../theme/tokens';
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
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const targets = moveTargets(items, item.id);

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      // Android's hardware back must close the sheet, not the screen under it.
      onRequestClose={onClose}
      // Android-only: make the modal's window edge-to-edge so the padding below is
      // the ONLY inset applied there (without these the window fits the system
      // bars itself and the same inset would count twice).
      statusBarTranslucent
      navigationBarTranslucent
    >
      <View
        style={[
          styles.safe,
          {
            paddingTop:
              Platform.OS === 'ios' ? spacing.sm : Math.max(insets.top, spacing.sm),
            paddingBottom: insets.bottom,
          },
        ]}
      >
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
      </View>
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
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.option,
        selected && styles.optionRowSelected,
        { paddingLeft: spacing.lg + (depth - 1) * 16 },
      ]}
    >
      <Text style={[styles.optionText, selected && styles.optionSelected]} numberOfLines={1}>
        {label}
      </Text>
      {selected ? <Text style={styles.currentTag}>✓</Text> : null}
    </Pressable>
  );
}

const useStyles = themedStyles((t) => ({
  safe: {
    flex: 1,
    backgroundColor: t.colors.surfaceRaised,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
    backgroundColor: t.colors.surfaceRaised,
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: t.type.lg,
    fontWeight: '700',
    color: t.colors.text,
  },
  cancel: {
    fontSize: t.type.md,
    color: t.colors.accent,
    minWidth: 60,
  },
  headerSpacer: {
    minWidth: 60,
  },
  hint: {
    fontSize: t.type.sm,
    color: t.colors.textMuted,
    paddingHorizontal: t.spacing.lg,
    paddingTop: t.spacing.sm,
  },
  error: {
    fontSize: t.type.sm,
    color: t.colors.danger,
    paddingHorizontal: t.spacing.lg,
    paddingTop: t.spacing.sm,
  },
  listContent: {
    paddingVertical: t.spacing.sm,
  },
  option: {
    minHeight: t.TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: t.spacing.lg,
    paddingVertical: t.spacing.sm,
  },
  // The current parent, marked the way every selected chip and segment in this
  // app is: an accent BORDER over the soft fill. The fill alone is 1.04 against a
  // raised surface in dark — i.e. invisible — and a phone has no hover or focus
  // ring to make up for it.
  optionRowSelected: {
    ...t.selected.chip,
    borderWidth: 1,
    borderRadius: t.radius.md,
    marginHorizontal: t.spacing.sm,
  },
  optionText: {
    flex: 1,
    fontSize: t.type.md,
    color: t.colors.text,
  },
  optionSelected: {
    color: t.selected.text.color,
    fontWeight: '700',
  },
  currentTag: {
    fontSize: t.type.md,
    color: t.colors.accent,
  },
  footer: {
    padding: t.spacing.lg,
    borderTopWidth: 1,
    borderTopColor: t.colors.border,
    backgroundColor: t.colors.surfaceRaised,
  },
}));
