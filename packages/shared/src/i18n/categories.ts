// Display names for the SYSTEM (seed) categories, per language.
//
// The server stores one name per seed row (Russian, migration 0003) and never
// localizes it — the row is shared by every user of the installation. Translating
// it is therefore a pure DISPLAY concern, keyed by the frozen UUID, and it lives
// here because both clients need the identical mapping (mobile at unfreeze).
//
// Keys are semantic, not names: "Подарки" and "Прочее" each exist twice (expense
// and income) with different UUIDs, so a name-keyed map would collapse them.
import type { Lang } from './lang';

export type SystemCategoryKey =
  | 'groceries'
  | 'diningOut'
  | 'transport'
  | 'housing'
  | 'health'
  | 'clothing'
  | 'entertainment'
  | 'communications'
  | 'subscriptions'
  | 'giftsExpense'
  | 'travel'
  | 'education'
  | 'otherExpense'
  | 'salary'
  | 'freelance'
  | 'giftsIncome'
  | 'interestAndCashback'
  | 'otherIncome';

// The `ru` column is byte-identical to the seed `name` in migration 0003: with
// language=ru the screen must show exactly what the database says, so a rename in
// the seed data can never silently disagree with the UI.
export const SYSTEM_CATEGORY_NAMES: Record<Lang, Record<SystemCategoryKey, string>> = {
  ru: {
    groceries: 'Продукты',
    diningOut: 'Кафе и рестораны',
    transport: 'Транспорт',
    housing: 'Жильё',
    health: 'Здоровье',
    clothing: 'Одежда',
    entertainment: 'Развлечения',
    communications: 'Связь и интернет',
    subscriptions: 'Подписки',
    giftsExpense: 'Подарки',
    travel: 'Путешествия',
    education: 'Образование',
    otherExpense: 'Прочее',
    salary: 'Зарплата',
    freelance: 'Фриланс',
    giftsIncome: 'Подарки',
    interestAndCashback: 'Проценты и кэшбэк',
    otherIncome: 'Прочее',
  },
  en: {
    groceries: 'Groceries',
    diningOut: 'Cafés and restaurants',
    transport: 'Transport',
    housing: 'Housing',
    health: 'Health',
    clothing: 'Clothing',
    entertainment: 'Entertainment',
    communications: 'Phone and internet',
    subscriptions: 'Subscriptions',
    giftsExpense: 'Gifts',
    travel: 'Travel',
    education: 'Education',
    otherExpense: 'Other',
    salary: 'Salary',
    freelance: 'Freelance',
    giftsIncome: 'Gifts',
    interestAndCashback: 'Interest and cashback',
    otherIncome: 'Other',
  },
};
