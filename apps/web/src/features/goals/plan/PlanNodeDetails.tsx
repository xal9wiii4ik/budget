import type { GoalItemRead } from '../../../data/goalItems';
import { useT } from '../../../i18n/context';
import styles from './PlanNodeDetails.module.css';

interface PlanNodeDetailsProps {
  id: string;
  item: GoalItemRead;
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
 * W1 shows the file COUNT only; the attachments themselves (presign → PUT →
 * confirm → `view_url`) arrive with the files endpoints.
 */
export function PlanNodeDetails({ id, item }: PlanNodeDetailsProps) {
  const t = useT();
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

      {item.files_count > 0 ? (
        <p className={styles.files}>{t('goalPlan.filesCount', { count: item.files_count })}</p>
      ) : null}

      {hasNothing ? <p className={styles.empty}>{t('goalPlan.detailsEmpty')}</p> : null}
    </div>
  );
}
