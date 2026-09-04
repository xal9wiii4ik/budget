import { currentMonth, todayApiDate } from '@budget/shared';
import { useMemo, useState } from 'react';

import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { PageHeader } from '../components/PageHeader';
import { QueryStateNotice } from '../components/QueryStateNotice';
import { useCategories } from '../data/categories';
import { buildCategoryIndex } from '../data/categoryLookup';
import {
  useDeleteTemplate,
  useRecurringTemplates,
  useUpdateTemplate,
  type RecurringTemplateRead,
} from '../data/recurring';
import { TemplateFormModal } from '../features/recurring/TemplateFormModal';
import { TemplateList } from '../features/recurring/TemplateList';
import { TransactionFormModal } from '../features/transactions/TransactionFormModal';
import { useLang, useT } from '../i18n/context';
import { describeRecurringError } from '../lib/errors';
import { queryPhase } from '../lib/queryPhase';
import styles from './RecurringPage.module.css';

type ModalState =
  | { type: 'closed' }
  | { type: 'create' }
  | { type: 'edit'; template: RecurringTemplateRead }
  | { type: 'delete'; template: RecurringTemplateRead }
  // recurring-book-now W1: the "+" shortcut — the ordinary transaction form,
  // prefilled from this template. `occurredAt` is LOCAL today (R4: no due date is
  // in focus on this screen, and this is the user's own calendar, not a date the
  // server decided), captured at click time so a re-render cannot move it.
  | { type: 'addTransaction'; template: RecurringTemplateRead; occurredAt: string };

// SL-C, load-bearing: the delete drops the ATTRIBUTION and keeps the money. That
// asymmetry is exactly what a user cannot guess, so the dialog says it outright
// (copy: `recurring.deleteMessage`).

/**
 * The recurring-templates management screen.
 *
 * It is a top-level route on purpose (WR-1): materialization is silent (D9), so
 * this is the screen that answers "where did this money row come from" — burying
 * it inside another screen would contradict the reason the attribution exists.
 */
export function RecurringPage() {
  const lang = useLang();
  const t = useT();
  const templatesQuery = useRecurringTemplates();
  const categoriesQuery = useCategories();
  const phase = queryPhase(templatesQuery);

  const updateTemplate = useUpdateTemplate();
  const deleteTemplate = useDeleteTemplate();
  const [modal, setModal] = useState<ModalState>({ type: 'closed' });
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);
  // Which row's pause toggle is in flight — one mutation object serves every row,
  // so the id is what disables the right button.
  const [pausingId, setPausingId] = useState<string | null>(null);

  const categoryIndex = useMemo(
    () => buildCategoryIndex(categoriesQuery.data ?? []),
    [categoriesQuery.data],
  );

  const togglePause = async (template: RecurringTemplateRead) => {
    setPauseError(null);
    setPausingId(template.id);
    try {
      await updateTemplate.mutateAsync({
        id: template.id,
        body: { paused: !template.paused },
      });
    } catch (error) {
      setPauseError(describeRecurringError(error, lang).message);
    } finally {
      setPausingId(null);
    }
  };

  const confirmDelete = async (template: RecurringTemplateRead) => {
    setDeleteError(undefined);
    try {
      await deleteTemplate.mutateAsync({ id: template.id });
      setModal({ type: 'closed' });
    } catch (error) {
      setDeleteError(describeRecurringError(error, lang).message);
    }
  };

  return (
    <section className={styles.page}>
      <PageHeader
        className={styles.header}
        title={t('recurring.title')}
        actions={
          <Button variant="primary" onClick={() => setModal({ type: 'create' })}>
            {t('recurring.newTemplate')}
          </Button>
        }
      />

      <p className={styles.lede}>{t('recurring.lede')}</p>

      {pauseError !== null ? (
        <p className={styles.error} role="alert">
          {pauseError}
        </p>
      ) : null}

      {phase === 'loading' ? (
        <div className={styles.skeletons} aria-hidden="true">
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
        </div>
      ) : phase === 'error' || phase === 'unreachable' ? (
        <QueryStateNotice
          phase={phase}
          message={t('recurring.loadFailed')}
          onRetry={() => {
            void templatesQuery.refetch();
          }}
        />
      ) : (
        <TemplateList
          templates={templatesQuery.data?.items ?? []}
          categoryIndex={categoryIndex}
          pausePendingId={pausingId}
          onAddTransaction={(template) =>
            setModal({ type: 'addTransaction', template, occurredAt: todayApiDate() })
          }
          onEdit={(template) => setModal({ type: 'edit', template })}
          onTogglePause={(template) => {
            void togglePause(template);
          }}
          onDelete={(template) => {
            setDeleteError(undefined);
            setModal({ type: 'delete', template });
          }}
          onCreate={() => setModal({ type: 'create' })}
        />
      )}

      {modal.type === 'create' ? (
        <TemplateFormModal
          categories={categoriesQuery.data ?? []}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}
      {modal.type === 'edit' ? (
        <TemplateFormModal
          key={modal.template.id}
          template={modal.template}
          categories={categoriesQuery.data ?? []}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}
      {modal.type === 'addTransaction' ? (
        // `month` is only how the form resolves the PROFILE BASE currency (via
        // the month summary); this screen has no month of its own, so the current
        // one stands — the same query /transactions has already cached in a normal
        // session, and the form renders its own loading/error arm otherwise.
        <TransactionFormModal
          key={modal.template.id}
          month={currentMonth()}
          categories={categoriesQuery.data ?? []}
          templatePrefill={{ source: modal.template, occurredAt: modal.occurredAt }}
          onClose={() => setModal({ type: 'closed' })}
        />
      ) : null}
      {modal.type === 'delete' ? (
        <ConfirmDialog
          title={t('recurring.deleteTitle')}
          message={t('recurring.deleteMessage')}
          confirmLabel={t('common.delete')}
          pendingLabel={t('common.deleting')}
          destructive
          isPending={deleteTemplate.isPending}
          errorMessage={deleteError}
          onConfirm={() => {
            void confirmDelete(modal.template);
          }}
          onCancel={() => setModal({ type: 'closed' })}
        />
      ) : null}
    </section>
  );
}
