import type { components } from '@budget/api-client';

import { useLocale, useT } from '../../i18n/context';
import { formatItemAmount } from './confirmDefaults';
import styles from './ReceiptItemsList.module.css';

type ParsedReceiptRead = components['schemas']['ParsedReceiptRead'];

interface ReceiptItemsListProps {
  parsed: ParsedReceiptRead;
}

/**
 * The line items the model read off the receipt — display only (D10). There is no
 * split-by-item flow and nothing here is editable: it exists so the user can
 * sanity-check the total they are about to confirm.
 *
 * A receipt with no items renders nothing rather than an empty-state: the confirm
 * form is the screen, this block is supporting evidence, and "no items" is not
 * something the user can act on.
 */
export function ReceiptItemsList({ parsed }: ReceiptItemsListProps) {
  const locale = useLocale();
  const t = useT();
  if (parsed.items.length === 0) return null;

  return (
    <section className={styles.wrap} aria-labelledby="receipt-items-heading">
      <h3 className={styles.heading} id="receipt-items-heading">
        {t('receipt.itemsHeading')}
      </h3>
      <ul className={styles.list}>
        {parsed.items.map((item, index) => (
          // Index key: this list is IMMUTABLE — rendered once from a parsed
          // payload, never reordered, filtered or edited, and the items carry no
          // id to key on. If a split flow ever makes it mutable, key on a real id.
          <li key={index} className={styles.item}>
            <span className={styles.name}>{item.name}</span>
            {item.amount === null || item.amount === undefined ? null : (
              <span className={`${styles.amount} tnum`}>
                {formatItemAmount(item.amount, parsed.currency, locale)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
