// UUID -> system-category key. The ids are the FROZEN literals from migration
// 0003_seed_and_backfill.py (conventions.md "Seed categories"): they are a
// contract across environments and clients, so they are copied here verbatim and
// never regenerated. Copying them is deliberate — the alternative (an endpoint
// that hands the client a key per row) would put a network round trip between the
// user and a static translation.
//
// If a future migration adds a seed row and this table is not updated, nothing
// breaks: the unknown id falls back to the server `name`, which is exactly what a
// user category does.
import { SYSTEM_CATEGORY_NAMES, type SystemCategoryKey } from './i18n/categories';
import type { Lang } from './i18n/lang';

export const SYSTEM_CATEGORY_KEYS: Record<string, SystemCategoryKey> = {
  'ce814749-2554-40be-8952-3a63d505694f': 'groceries',
  'f9a5b100-13a0-49c4-9da1-f23a07f70e81': 'diningOut',
  'fbee0e67-0fd3-49b2-851d-fff8bc390255': 'transport',
  'c861af3a-73f2-475e-af4f-0556d7d143c9': 'housing',
  '6c53a9ed-9fb0-4cf5-aba2-1c36e1296d23': 'health',
  '1ac8d199-db1d-487c-9080-6949a62aad66': 'clothing',
  '1b0f9d5f-df44-471b-b084-b9db75d42d50': 'entertainment',
  '2363f62a-b11c-42cc-8121-49286fb4f098': 'communications',
  'ebcb3fe0-e47b-4327-8248-b3d19e89c2c9': 'subscriptions',
  '0f69fdb2-ff62-4fd9-b59b-ad891d992035': 'giftsExpense',
  'a786fbc9-d36e-458a-842b-6d4d9ed29c58': 'travel',
  'f80ae2b9-38ea-4d08-a169-58b203e9ea10': 'education',
  '3363eedd-dde8-45e7-853b-f9fcef853229': 'otherExpense',
  '8fe4d517-33d6-437d-a2c0-4cd95e262676': 'salary',
  '00d81258-6d7e-4b83-ab44-f8ff62fddb7f': 'freelance',
  'f9c4adfa-2db5-4d6f-bdf8-d5c55c7de457': 'giftsIncome',
  'bd83bb2c-8561-4f06-8a8c-61a2b40fe6bb': 'interestAndCashback',
  'fd316f6c-fa04-456b-a0c2-46e781568d56': 'otherIncome',
};

/**
 * The name to DISPLAY for a category.
 *
 * A system category (frozen seed id) is translated; anything else — a user's own
 * category, or a seed row added after this table was written — renders the
 * server's `name` verbatim. There is deliberately no "Unknown" arm: a name the
 * user typed is never ours to replace, and an unmapped seed id is still a real,
 * meaningful Russian name rather than a hole in the UI.
 */
export function systemCategoryName(
  id: string,
  fallbackName: string,
  lang: Lang,
): string {
  const key = SYSTEM_CATEGORY_KEYS[id];
  return key === undefined ? fallbackName : SYSTEM_CATEGORY_NAMES[lang][key];
}
