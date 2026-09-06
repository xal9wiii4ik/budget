// One recurring template (memoized for the virtualized list).
//
// Every date on it is a SERVER field rendered verbatim: `next_due_on` for the
// active arm, `end_date` for the ended one, `start_date` for a template that has
// not begun yet. Nothing here computes a due date, clamps a day or decides that a
// template has ended — `templateStatus` reads the server's own answer, and PAUSED
// WINS there because a paused template also reports `next_due_on: null`.
//
// The amount is denominated in the template's OWN stored currency (which the
// server keeps equal to its account's), never the profile base, and its sign
// comes from `kind` — the row does no money arithmetic at all.
import { formatApiDate, formatMoney, todayApiDateUtc } from '@budget/shared';
import type { components } from '@budget/api-client';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { FormButton } from '../../components/FormButton';
import { colors, spacing, TOUCH_TARGET } from '../../components/theme';
import type { RecurringTemplateRead } from '../../data/recurring';
import { useLocale, useT } from '../../i18n/context';
import { periodicityLabel } from './periodicity';
import { templateStatus } from './templateStatus';

type CategoryRead = components['schemas']['CategoryRead'];

interface TemplateRowProps {
  template: RecurringTemplateRead;
  category: CategoryRead | undefined;
  /** True while THIS row's pause/resume PATCH is in flight. */
  isPausePending: boolean;
  onEdit: (template: RecurringTemplateRead) => void;
  onTogglePause: (template: RecurringTemplateRead) => void;
}

function TemplateRowImpl({
  template,
  category,
  isPausePending,
  onEdit,
  onTogglePause,
}: TemplateRowProps) {
  const t = useT();
  const locale = useLocale();
  const isExpense = template.kind === 'expense';
  const signedMinor = isExpense ? -template.amount_minor : template.amount_minor;
  const categoryName =
    template.category_id === null
      ? t('common.uncategorized')
      : (category?.name ?? t('common.unknownCategory'));
  const status = templateStatus(template);
  // Advisory about a STORED field, not a re-derivation of server state: a start
  // date still ahead is the one thing `next_due_on` alone does not explain ("why
  // is the next charge in October?"). UTC, because the server decides these dates
  // in UTC — a local compare disagrees with it for hours around midnight.
  const startsLater = template.start_date !== null && template.start_date > todayApiDateUtc();

  return (
    // The row opens the form; pause/resume is a real button INSIDE it, so the two
    // targets never fight over the same tap.
    <Pressable accessibilityRole="button" onPress={() => onEdit(template)} style={styles.row}>
      <View style={styles.main}>
        <Text style={styles.icon}>{category?.icon ?? '🔁'}</Text>
        <View style={styles.details}>
          <Text style={styles.name} numberOfLines={1}>
            {template.name}
          </Text>
          <Text style={styles.meta} numberOfLines={2}>
            {categoryName} · {periodicityLabel(template, t, locale)}
          </Text>
        </View>
        <Text style={[styles.amount, isExpense ? styles.expense : styles.income]}>
          {formatMoney(signedMinor, template.currency, { locale })}
        </Text>
      </View>

      <View style={styles.statusLine}>
        <View style={styles.statusText}>
          {status.status === 'active' ? (
            <Text style={styles.next}>
              {t('recurring.nextOn', {
                date: formatApiDate(status.nextDueOn, { locale }),
              })}
            </Text>
          ) : null}
          {status.status === 'paused' ? (
            <>
              <Text style={styles.badgePaused}>{t('recurring.paused')}</Text>
              {/* Said once, so resuming is never a surprise. */}
              <Text style={styles.note}>{t('recurring.pausedNote')}</Text>
            </>
          ) : null}
          {status.status === 'ended' ? (
            <>
              <Text style={styles.badgeEnded}>{t('recurring.ended')}</Text>
              {status.endDate !== null ? (
                <Text style={styles.note}>
                  {t('recurring.endedOn', {
                    date: formatApiDate(status.endDate, { locale }),
                  })}
                </Text>
              ) : null}
            </>
          ) : null}
          {startsLater && template.start_date !== null ? (
            <Text style={styles.note}>
              {t('recurring.startsOn', {
                date: formatApiDate(template.start_date, { locale }),
              })}
            </Text>
          ) : null}
        </View>

        {/* Pause/Resume is reversible and self-describing, so it takes no
            confirmation — and it is its own one-field PATCH, never part of a
            save. */}
        <FormButton
          label={t(template.paused ? 'recurring.resume' : 'recurring.pause')}
          variant="secondary"
          pending={isPausePending}
          onPress={() => onTogglePause(template)}
          style={styles.pauseButton}
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.card,
    gap: spacing.sm,
  },
  main: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  icon: {
    fontSize: 20,
    width: 24,
    textAlign: 'center',
  },
  details: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontSize: 15,
    fontWeight: '500',
    color: colors.text,
  },
  meta: {
    fontSize: 13,
    color: colors.textMuted,
  },
  amount: {
    fontSize: 15,
    fontWeight: '600',
  },
  expense: {
    color: colors.expense,
  },
  income: {
    color: colors.income,
  },
  statusLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  statusText: {
    flex: 1,
    gap: 2,
  },
  next: {
    fontSize: 13,
    color: colors.text,
  },
  note: {
    fontSize: 12,
    color: colors.textMuted,
  },
  // Text badges, not colour alone: "paused" has to read on a monochrome screen.
  badgePaused: {
    alignSelf: 'flex-start',
    fontSize: 12,
    fontWeight: '700',
    color: '#8A5A00',
    backgroundColor: '#FDF0D5',
    borderRadius: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  badgeEnded: {
    alignSelf: 'flex-start',
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted,
    backgroundColor: colors.bg,
    borderRadius: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  pauseButton: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: spacing.md,
  },
});

export const TemplateRow = memo(TemplateRowImpl);
