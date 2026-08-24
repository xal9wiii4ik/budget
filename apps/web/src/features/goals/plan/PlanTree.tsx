import { useState, type ReactElement } from 'react';

import type { GoalItemRead } from '../../../data/goalItems';
import { useT } from '../../../i18n/context';
import type { PlanNode } from './buildTree';
import { PlanNodeRow } from './PlanNodeRow';
import styles from './PlanTree.module.css';

/** What a row can ask the screen to do. The page owns every modal and mutation. */
export interface PlanActions {
  onAddChild: (parent: GoalItemRead) => void;
  onEdit: (item: GoalItemRead) => void;
  onMove: (item: GoalItemRead) => void;
  onDelete: (item: GoalItemRead) => void;
  onReorder: (item: GoalItemRead, direction: 'up' | 'down') => void;
}

interface PlanTreeProps {
  roots: PlanNode[];
  /** `goal_currency` from the tree response — the currency of every rolled-up sum. */
  goalCurrency: string;
  /** Archived goal: every write affordance is hidden, the numbers stay. */
  readOnly: boolean;
  /** A tree mutation is in flight — the row buttons stop taking clicks. */
  pending: boolean;
  actions: PlanActions;
}

/**
 * The plan, as nested lists.
 *
 * Semantic `<ul>/<li>` all the way down: a screen reader announces the nesting
 * and the item counts for free, which no `role="tree"` reimplementation would
 * have matched. Indentation is CSS on the nested list, capped so six levels
 * cannot push a row off a 375px screen.
 *
 * Collapsing a branch is the one piece of state that lives here: it is a VIEW
 * preference about rows on screen, not server data, and it deliberately does not
 * survive a reload.
 */
export function PlanTree({ roots, goalCurrency, readOnly, pending, actions }: PlanTreeProps) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const toggle = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderLevel = (nodes: PlanNode[]): ReactElement => (
    <ul className={styles.list}>
      {nodes.map((node, index) => {
        const isCollapsed = collapsed.has(node.item.id);
        return (
          <li key={node.item.id} className={styles.item}>
            <PlanNodeRow
              node={node}
              goalCurrency={goalCurrency}
              readOnly={readOnly}
              pending={pending}
              isFirst={index === 0}
              isLast={index === nodes.length - 1}
              collapsed={isCollapsed}
              onToggleCollapse={() => toggle(node.item.id)}
              actions={actions}
            />
            {node.children.length > 0 && !isCollapsed ? (
              <div className={styles.children}>{renderLevel(node.children)}</div>
            ) : null}
            {node.children.length > 0 && isCollapsed ? (
              <p className={styles.collapsedNote}>
                {t('goalPlan.hiddenChildren', { count: node.children.length })}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );

  return renderLevel(roots);
}
