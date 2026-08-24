import { formatApiDate, formatMoney } from '@budget/shared';
import { useState } from 'react';

import { useLocale, useT } from '../../../i18n/context';
import type { PlanNode } from './buildTree';
import { MAX_PLAN_DEPTH } from './moveTargets';
import { PlanNodeDetails } from './PlanNodeDetails';
import type { PlanActions } from './PlanTree';
import styles from './PlanNodeRow.module.css';

interface PlanNodeRowProps {
  node: PlanNode;
  goalCurrency: string;
  readOnly: boolean;
  pending: boolean;
  isFirst: boolean;
  isLast: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  actions: PlanActions;
}

/**
 * One node.
 *
 * THREE currencies can meet on this row and each number is formatted with ITS
 * OWN, never a fallback (AM-5):
 *   `amount_minor`        — the item's own currency (`item.currency`);
 *   `converted_minor`     — its paired `converted_currency`;
 *   `children_sum_minor` / `paid_minor` — the GOAL's currency, echoed by the tree
 *                           response.
 *
 * `ceiling_exceeded` is a server FIELD, not an error: the row warns, naming both
 * figures, and nothing is ever blocked because of it (task.md: the own amount is
 * a guideline and a ceiling, the working number comes from below).
 */
export function PlanNodeRow({
  node,
  goalCurrency,
  readOnly,
  pending,
  isFirst,
  isLast,
  collapsed,
  onToggleCollapse,
  actions,
}: PlanNodeRowProps) {
  const t = useT();
  const locale = useLocale();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const item = node.item;
  const hasChildren = node.children.length > 0;

  const ownAmount =
    item.amount_minor === null
      ? null
      : formatMoney(item.amount_minor, item.currency, { locale });
  const converted =
    item.converted_minor !== null && item.converted_currency !== null
      ? formatMoney(item.converted_minor, item.converted_currency, { locale })
      : null;
  // A foreign-currency amount with no goal-currency pair: no rate exists for it,
  // so it is missing from every rolled-up sum above. Said on the row, and counted
  // again in the goal's own counter — never silently folded in.
  const unconverted =
    item.amount_minor !== null && item.currency !== goalCurrency && converted === null;

  return (
    <div className={styles.row}>
      <div className={styles.head}>
        {hasChildren ? (
          <button
            type="button"
            className={styles.collapse}
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-label={t(collapsed ? 'goalPlan.expandNode' : 'goalPlan.collapseNode', {
              name: item.name,
            })}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        ) : (
          <span className={styles.collapsePlaceholder} aria-hidden="true" />
        )}
        {/* User-typed text: never translated. */}
        <h3 className={styles.name}>{item.name}</h3>
        {item.files_count > 0 ? (
          <span className={styles.badge}>
            {t('goalPlan.filesCount', { count: item.files_count })}
          </span>
        ) : null}
      </div>

      <div className={styles.amounts}>
        {ownAmount === null ? (
          <span className={styles.muted}>{t('goalPlan.noOwnAmount')}</span>
        ) : (
          <span className={styles.own}>
            {ownAmount}
            {converted !== null ? (
              <span className={styles.converted}>
                {t('goalPlan.convertedSuffix', { amount: converted })}
              </span>
            ) : null}
          </span>
        )}
        {hasChildren ? (
          <span className={styles.childrenSum}>
            {t('goalPlan.childrenSum', {
              amount: formatMoney(item.children_sum_minor, goalCurrency, { locale }),
            })}
          </span>
        ) : null}
        {item.paid_minor > 0 ? (
          <span className={styles.paid}>
            {t('goalPlan.paidOnNode', {
              amount: formatMoney(item.paid_minor, goalCurrency, { locale }),
            })}
          </span>
        ) : null}
      </div>

      {item.ceiling_exceeded && item.amount_minor !== null ? (
        <p className={styles.warn} role="status">
          {t('goalPlan.ceilingExceeded', {
            own: formatMoney(item.amount_minor, item.currency, { locale }),
            children: formatMoney(item.children_sum_minor, goalCurrency, { locale }),
          })}
        </p>
      ) : null}

      {unconverted ? (
        <p className={styles.warn} role="status">
          {t('goalPlan.nodeUnconverted', { from: item.currency, to: goalCurrency })}
        </p>
      ) : null}
      {item.paid_unconverted_count > 0 ? (
        <p className={styles.warn} role="status">
          {t('goalPlan.nodePaidUnconverted', { count: item.paid_unconverted_count })}
        </p>
      ) : null}

      <p className={styles.deadline}>
        {item.effective_deadline === null
          ? t('goalPlan.noDeadline')
          : item.deadline_inherited
            ? t('goalPlan.deadlineInherited', {
                date: formatApiDate(item.effective_deadline, { locale }),
              })
            : t('goalPlan.deadlineOwn', {
                date: formatApiDate(item.effective_deadline, { locale }),
              })}
      </p>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          onClick={() => setDetailsOpen((open) => !open)}
          aria-expanded={detailsOpen}
          aria-controls={`plan-item-details-${item.id}`}
        >
          {t(detailsOpen ? 'goalPlan.hideDetails' : 'goalPlan.showDetails')}
        </button>
        {readOnly ? null : (
          <>
            <button
              type="button"
              className={styles.action}
              onClick={() => actions.onReorder(item, 'up')}
              disabled={pending || isFirst}
              aria-label={t('goalPlan.moveUpAria', { name: item.name })}
            >
              ↑
            </button>
            <button
              type="button"
              className={styles.action}
              onClick={() => actions.onReorder(item, 'down')}
              disabled={pending || isLast}
              aria-label={t('goalPlan.moveDownAria', { name: item.name })}
            >
              ↓
            </button>
            {/* The server refuses a seventh level (422 GOAL_ITEM_DEPTH_EXCEEDED);
                offering the button there would be an affordance for a failure. */}
            {item.depth < MAX_PLAN_DEPTH ? (
              <button
                type="button"
                className={styles.action}
                onClick={() => actions.onAddChild(item)}
                disabled={pending}
              >
                {t('goalPlan.addChild')}
              </button>
            ) : null}
            <button
              type="button"
              className={styles.action}
              onClick={() => actions.onEdit(item)}
              disabled={pending}
            >
              {t('common.edit')}
            </button>
            <button
              type="button"
              className={styles.action}
              onClick={() => actions.onMove(item)}
              disabled={pending}
            >
              {t('goalPlan.moveTo')}
            </button>
            <button
              type="button"
              className={styles.danger}
              onClick={() => actions.onDelete(item)}
              disabled={pending}
            >
              {t('common.delete')}
            </button>
          </>
        )}
      </div>

      {detailsOpen ? (
        <PlanNodeDetails id={`plan-item-details-${item.id}`} item={item} />
      ) : null}
    </div>
  );
}
