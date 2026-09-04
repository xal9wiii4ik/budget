// The ENGLISH dictionary — the source of truth for the key set.
//
// `keyof typeof en` is the `MessageKey` type (t.ts), and dict.ru.ts is annotated
// with a mapped type over this object: a key added here and forgotten in ru, or a
// plural entry written as a plain string, fails `pnpm typecheck` rather than
// silently rendering a raw key on a user's phone.
//
// This is MOBILE's own key set, not a copy of web's: the two apps show different
// screens, and half of web's ~700 keys name features this client does not have.
// Where a sentence exists on both, the wording is taken from web's dictionary so
// the same failure reads the same way in both places.
//
// NOT in here, on purpose:
//   * user-typed text (account, category and transaction names, notes);
//   * copy for error CODES — that is shared with web (`ERROR_MESSAGES` in
//     @budget/shared) and reached through data/errors.ts;
//   * anything the SERVER wrote, `transfer_rate` above all.
import type { PluralForms } from './types';

export const en = {
  // --- shared vocabulary -----------------------------------------------------
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.archive': 'Archive',
  'common.unarchive': 'Unarchive',
  'common.retry': 'Retry',
  'common.done': 'Done',
  'common.loading': 'Loading…',
  'common.goBack': 'Go back',
  'common.name': 'Name',
  'common.type': 'Type',
  'common.currency': 'Currency',
  'common.amount': 'Amount',
  'common.date': 'Date',
  'common.noteOptional': 'Note (optional)',
  'common.expense': 'Expense',
  'common.income': 'Income',
  'common.net': 'Net',
  'common.uncategorized': 'Uncategorized',
  'common.unknownCategory': 'Unknown category',
  'common.archivedTag': 'Archived',
  'common.archivedParens': '(archived)',

  // --- tab bar ---------------------------------------------------------------
  'tabs.transactions': 'Transactions',
  'tabs.categories': 'Categories',
  'tabs.accounts': 'Accounts',

  // --- app shell -------------------------------------------------------------
  'shell.logout': 'Log out',
  'shell.retryAccount': 'Retry account',

  // --- auth screens ----------------------------------------------------------
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.signIn': 'Sign in',
  'auth.signInSubtitle': 'Welcome back to Budget.',
  'auth.noAccount': 'No account?',
  'auth.createOne': 'Create one',
  'auth.sessionExpired': 'Your session expired — please sign in again.',
  'auth.accountCreated': 'Account created — please sign in.',
  'auth.createAccount': 'Create account',
  'auth.createSubtitle': 'Start tracking your budget.',
  'auth.haveAccount': 'Already have an account?',
  'auth.passwordHint': 'At least 8 characters.',

  // Auth failures. These are the ONE family of error copy that is not shared with
  // web through @budget/shared: the auth screens are each client's own, and
  // auth/errors.ts routes a code to one of these keys without knowing a language.
  'authError.network': "Can't reach the server. Check your connection and try again.",
  'authError.badCredentials': 'Incorrect email or password.',
  'authError.emailExists': 'An account with this email already exists.',
  'authError.invalidPassword': 'Password must be at least 8 characters.',
  'authError.rateLimited': 'Too many attempts. Please wait a minute and try again.',
  'authError.invalidEmail': 'Enter a valid email address.',
  'authError.generic': 'Something went wrong. Please try again.',

  // --- accounts tab ----------------------------------------------------------
  accountCount: {
    one: '{count} account',
    other: '{count} accounts',
  } satisfies PluralForms,
  'accounts.add': 'Add account',
  'accounts.loadFailed': "Couldn't load your accounts.",
  'accounts.empty': 'Add your first account — every transaction is recorded on one.',
  'accounts.group': 'Accounts',
  'accounts.archivedGroup': 'Archived',
  'accounts.typeCard': 'Card',
  'accounts.typeCash': 'Cash',
  'accounts.all': 'All accounts',
  'accounts.noneToRecordOn':
    'You have no account to record this on — add one on the Accounts tab first.',

  // --- the account form ------------------------------------------------------
  'accountForm.newTitle': 'New account',
  'accountForm.editTitle': 'Edit account',
  'accountForm.unavailable': 'This account is unavailable.',
  'accountForm.archiveTitle': 'Archive account',
  'accountForm.unarchiveTitle': 'Unarchive account',
  'accountForm.archiveMessage':
    'Archive "{name}"? Its past operations stay exactly as they are — it just ' +
    'stops being offered for new ones.',
  'accountForm.unarchiveMessage': 'Restore "{name}" so it can be used again?',
  'accountForm.currencyImmutableHint':
    "An account's currency can't change. Archive this one and create a new " +
    'account in the currency you need.',
  'accountForm.startingBalance': 'Starting balance ({currency})',
  'accountForm.startingBalanceHint':
    'What is on the account right now. Use a minus for a card in the red; leave ' +
    'empty for zero.',

  // --- categories tab --------------------------------------------------------
  categoryCount: {
    one: '{count} category',
    other: '{count} categories',
  } satisfies PluralForms,
  'categories.add': 'Add category',
  'categories.loadFailed': "Couldn't load your categories.",
  'categories.empty': 'No categories yet.',
  'categories.systemTag': 'System',

  // --- the category form -----------------------------------------------------
  'categoryForm.newTitle': 'New category',
  'categoryForm.editTitle': 'Edit category',
  'categoryForm.unavailable': 'This category is unavailable.',
  'categoryForm.archiveTitle': 'Archive category',
  'categoryForm.unarchiveTitle': 'Unarchive category',
  'categoryForm.archiveMessage':
    'Archive "{name}"? It stays on past transactions but won’t be selectable ' +
    'for new ones.',
  'categoryForm.unarchiveMessage': 'Restore "{name}" so it can be used again?',
  'categoryForm.iconOptional': 'Icon (optional)',
  'categoryForm.colorOptional': 'Color (optional, e.g. #3366FF)',

  // --- transactions tab ------------------------------------------------------
  'tx.add': 'Add transaction',
  'tx.addTransfer': 'Add transfer',
  'tx.previousMonth': 'Previous month',
  'tx.nextMonth': 'Next month',
  'tx.loadFailed': "Couldn't load transactions.",
  'tx.emptyMonth': 'No transactions in {month}',
  'tx.emptyMonthCta': 'Add your first one.',
  'tx.showing': 'Showing {shown} of {total}',
  // The summary is account-agnostic (GET /transactions/summary takes no account),
  // so the caveat is part of the sentence rather than a separate line.
  'tx.filterNotice':
    'Showing {account} only — the totals above cover every account.',
  'tx.filterOneAccount': 'one account',
  'tx.transfer': 'Transfer',
  'tx.transferRoute': 'Transfer: {route}',

  // --- month summary ---------------------------------------------------------
  'summary.loadFailed': "Couldn't load this month's summary.",
  'summary.noSpend': 'No spend yet this month.',

  // --- the transaction form --------------------------------------------------
  'txForm.newTitle': 'New transaction',
  'txForm.editTitle': 'Edit transaction',
  'txForm.unavailable': 'This transaction is unavailable.',
  'txForm.account': 'Account',
  'txForm.amountIn': 'Amount ({currency})',
  'txForm.category': 'Category',
  'txForm.deleteTitle': 'Delete transaction',
  'txForm.deleteMessage': "Delete this transaction? This can't be undone.",
  'txForm.isTransfer':
    'This operation is a transfer between accounts — it is edited on its own screen.',
  'txForm.openTransfer': 'Open transfer',

  // --- the transfer form -----------------------------------------------------
  'transfer.newTitle': 'New transfer',
  'transfer.editTitle': 'Edit transfer',
  'transfer.unavailable': 'This transfer is unavailable.',
  'transfer.deleteTitle': 'Delete transfer',
  'transfer.deleteMessage':
    'Delete this transfer? Both sides of it go, and both account balances go back.',
  'transfer.needTwoAccounts':
    'A transfer moves money between two accounts — create a second one on the ' +
    'Accounts tab first.',
  'transfer.from': 'From',
  'transfer.to': 'To',
  'transfer.amountSent': 'Amount sent',
  'transfer.amountSentIn': 'Amount sent ({currency})',
  'transfer.amountReceived': 'Amount received',
  'transfer.amountReceivedIn': 'Amount received ({currency})',
  'transfer.receivedHint':
    "What actually landed on the other account — your bank's real rate, fees included.",
  // `{rate}` is the SERVER's string (A2), interpolated verbatim — never a number
  // this client computed.
  'transfer.rateAtTime': 'Rate at the time: {rate} {counterCurrency} per 1 {currency}',
};
