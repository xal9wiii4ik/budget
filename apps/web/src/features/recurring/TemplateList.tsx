import type { components } from '@budget/api-client';

import { useT } from '../../i18n/context';
import { TemplateRow } from './TemplateRow';
import type { RecurringTemplateRead } from '../../data/recurring';
import styles from './TemplateList.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

interface TemplateListProps {
  templates: RecurringTemplateRead[];
  // Archived-INCLUSIVE index (T3): a template can point at a category that was
  // archived after it was created, and hiding that name would be a lie.
  categoryIndex: Map<string, CategoryRead>;
  pausePendingId: string | null;
  onAddTransaction: (template: RecurringTemplateRead) => void;
  onEdit: (template: RecurringTemplateRead) => void;
  onTogglePause: (template: RecurringTemplateRead) => void;
  onDelete: (template: RecurringTemplateRead) => void;
  onCreate: () => void;
}

/**
 * Flat list in the server's order (`created_at, id`) — no grouping and no
 * client-side sort. It deliberately includes paused and ended templates: D10
 * makes this the management screen, and a paused template is exactly what the
 * user came here to resume.
 */
export function TemplateList({
  templates,
  categoryIndex,
  pausePendingId,
  onAddTransaction,
  onEdit,
  onTogglePause,
  onDelete,
  onCreate,
}: TemplateListProps) {
  const t = useT();
  if (templates.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>{t('recurring.emptyTitle')}</p>
        <p className={styles.emptyBody}>{t('recurring.emptyBody')}</p>
        <button type="button" className={styles.emptyAdd} onClick={onCreate}>
          {t('recurring.newTemplate')}
        </button>
      </div>
    );
  }

  return (
    <ul className={styles.list}>
      {templates.map((template) => (
        <TemplateRow
          key={template.id}
          template={template}
          category={
            template.category_id ? categoryIndex.get(template.category_id) : undefined
          }
          isPausePending={pausePendingId === template.id}
          onAddTransaction={onAddTransaction}
          onEdit={onEdit}
          onTogglePause={onTogglePause}
          onDelete={onDelete}
        />
      ))}
    </ul>
  );
}
