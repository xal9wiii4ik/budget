import { useState } from 'react';

import { Modal } from '../../../components/Modal';
import { useUpdateGoalItem, type GoalItemRead } from '../../../data/goalItems';
import { useLang, useT } from '../../../i18n/context';
import { describeGoalItemError } from '../../../lib/errors';
import { moveTargets } from './moveTargets';
import styles from './ItemMoveDialog.module.css';

interface ItemMoveDialogProps {
  goalId: string;
  item: GoalItemRead;
  items: GoalItemRead[];
  onClose: () => void;
}

const ROOT_VALUE = '';

/**
 * Re-parent one node.
 *
 * The picker offers only targets that can succeed — `moveTargets` excludes the
 * node itself, its descendants (that is the cycle) and anything too deep to hold
 * the moved subtree. It is a pre-filter, NOT the guarantee: another tab can make
 * a listed target illegal between render and save, so 422 GOAL_ITEM_CYCLE /
 * GOAL_ITEM_DEPTH_EXCEEDED are routed back into this dialog.
 *
 * Position among siblings is NOT set here (PM Q3): the server appends the moved
 * node to its new siblings and the row's up/down buttons take it from there.
 */
export function ItemMoveDialog({ goalId, item, items, onClose }: ItemMoveDialogProps) {
  const t = useT();
  const lang = useLang();
  const updateItem = useUpdateGoalItem(goalId);
  const [parentId, setParentId] = useState<string>(item.parent_id ?? ROOT_VALUE);
  const [error, setError] = useState<string | undefined>(undefined);

  const targets = moveTargets(items, item.id);
  const nextParent = parentId === ROOT_VALUE ? null : parentId;
  const unchanged = nextParent === item.parent_id;

  const submit = async () => {
    setError(undefined);
    try {
      await updateItem.mutateAsync({ itemId: item.id, body: { parent_id: nextParent } });
      onClose();
    } catch (caught) {
      setError(describeGoalItemError(caught, lang).message);
    }
  };

  return (
    <Modal
      title={t('goalPlan.moveTitle', { name: item.name })}
      onClose={onClose}
      closeDisabled={updateItem.isPending}
    >
      <div className={styles.body}>
        <label className={styles.label} htmlFor="plan-move-parent">
          {t('goalPlan.moveParentLabel')}
        </label>
        <select
          id="plan-move-parent"
          className={styles.select}
          value={parentId}
          onChange={(event) => setParentId(event.target.value)}
          disabled={updateItem.isPending}
        >
          <option value={ROOT_VALUE}>{t('goalPlan.moveToRoot')}</option>
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {/* The level is spelled with dashes rather than nbsp padding: an
                  option's leading whitespace is trimmed by some browsers. */}
              {'— '.repeat(target.depth - 1)}
              {target.name}
            </option>
          ))}
        </select>
        <p className={styles.hint}>{t('goalPlan.moveHint')}</p>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.cancel}
            onClick={onClose}
            disabled={updateItem.isPending}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={styles.confirm}
            onClick={() => void submit()}
            disabled={updateItem.isPending || unchanged}
          >
            {t(updateItem.isPending ? 'common.saving' : 'goalPlan.moveConfirm')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
