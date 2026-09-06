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
import { Pressable, Text, View } from 'react-native';

import { Badge } from '../../components/Badge';
import { FormButton } from '../../components/FormButton';
import { themedStyles } from '../../theme/themedStyles';
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
  const styles = useStyles();
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
              <Badge label={t('recurring.paused')} tone="warning" />
              {/* Said once, so resuming is never a surprise. */}
              <Text style={styles.note}>{t('recurring.pausedNote')}</Text>
            </>
          ) : null}
          {status.status === 'ended' ? (
            <>
              <Badge label={t('recurring.ended')} tone="neutral" />
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

const useStyles = themedStyles((t) => ({
  row: {
    paddingVertical: t.spacing.md,
    paddingHorizontal: t.spacing.lg,
    backgroundColor: t.colors.surface,
    gap: t.spacing.sm,
  },
  main: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
  },
  icon: {
    fontSize: t.type.xl,
    width: 24,
    textAlign: 'center',
  },
  details: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontSize: t.type.md,
    fontWeight: '500',
    color: t.colors.text,
  },
  meta: {
    fontSize: t.type.sm,
    color: t.colors.textMuted,
  },
  amount: {
    fontSize: t.type.md,
    fontWeight: '600',
    ...t.tnum,
  },
  expense: {
    color: t.colors.expense,
  },
  income: {
    color: t.colors.income,
  },
  statusLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
  },
  statusText: {
    flex: 1,
    gap: 2,
    // The badges below are Views now, so the column states its own alignment
    // instead of relying on a text style's `alignSelf`.
    alignItems: 'flex-start',
  },
  next: {
    fontSize: t.type.sm,
    color: t.colors.text,
  },
  note: {
    fontSize: t.type.xs,
    color: t.colors.textMuted,
  },
  pauseButton: {
    minHeight: t.TOUCH_TARGET,
    paddingHorizontal: t.spacing.md,
  },
}));

export const TemplateRow = memo(TemplateRowImpl);
