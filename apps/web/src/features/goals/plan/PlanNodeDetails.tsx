import type { GoalItemRead } from '../../../data/goalItems';
import { useT } from '../../../i18n/context';
import { ItemPhotos } from './ItemPhotos';
import styles from './PlanNodeDetails.module.css';

interface PlanNodeDetailsProps {
  id: string;
  item: GoalItemRead;
  /** Archived goal: the panel is readable, nothing on it can be written. */
  readOnly: boolean;
}

/**
 * A node's own material: what the user wrote about it, and what it links to.
 *
 * Links are rendered as anchors ONLY for `http(s)` — the server stores whatever
 * was pasted (a deep link, an intranet address), and turning `javascript:` into a
 * clickable anchor would be a script-injection affordance. Everything else is
 * shown as text so nothing is lost. Every anchor is `rel="noreferrer noopener"`
 * and opens in a new tab: the plan screen must not be navigated away from.
 *
 * Descriptions, names and links are user-typed and therefore NEVER translated.
 *
 * Photos are their own block (`ItemPhotos`), mounted with this panel: the list —
 * and with it the only `view_url` the server ever mints — is fetched when a node
 * is OPENED, never with the tree, which carries counters instead.
 */
export function PlanNodeDetails({ id, item, readOnly }: PlanNodeDetailsProps) {
  const t = useT();
  // On an archived goal an empty photo block would be a heading over nothing;
  // while the plan is writable it is the affordance itself, so it always shows.
  const showPhotos = !readOnly || item.files_count > 0;
  const hasNothing =
    item.description === null && item.links.length === 0 && item.files_count === 0;

  return (
    <div className={styles.details} id={id}>
      {item.description !== null ? (
        <p className={styles.description}>{item.description}</p>
      ) : null}

      {item.links.length > 0 ? (
        <ul className={styles.links}>
          {item.links.map((link) => (
            <li key={link}>
              {/^https?:\/\//i.test(link) ? (
                <a
                  className={styles.link}
                  href={link}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {link}
                </a>
              ) : (
                <span className={styles.plainLink}>{link}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {showPhotos ? (
        <ItemPhotos goalId={item.goal_id} itemId={item.id} readOnly={readOnly} />
      ) : null}

      {hasNothing && !showPhotos ? (
        <p className={styles.empty}>{t('goalPlan.detailsEmpty')}</p>
      ) : null}
    </div>
  );
}
