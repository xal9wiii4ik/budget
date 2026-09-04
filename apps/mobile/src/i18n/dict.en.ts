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
  'common.optional': '(optional)',
  'common.notSet': 'Not set',
  'common.remove': 'Remove',
  'common.tryAgain': 'Try again',
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
  // The account label names the DIRECTION, so the form reads correctly before
  // anything is filled in (the Type segment sits above it — features/
  // transactions/kindCopy.ts owns this whole family).
  'txForm.accountExpense': 'Paid from',
  'txForm.accountIncome': 'Received to',
  // The one amount of a single-currency operation, and its income twin.
  'txForm.amountLabel': 'Amount, {currency}',
  'txForm.amountLabelIncome': 'Received, {currency}',
  // Pair mode: what the price tag said, in the currency it was spent in.
  'txForm.spentLabel': 'Spent, {currency}',
  'txForm.receivedLabel': 'Received, {currency}',
  // Visible captions of the currency picker, not accessibility labels: an
  // unlabelled code next to the amount reads as "the currency is fixed".
  'txForm.spendCurrencyLabel': 'Currency spent',
  'txForm.spendCurrencyLabelIncome': 'Currency received',
  'txForm.spendCurrencyHint':
    'Spent in another currency? Pick it here — any 3-letter code works.',
  'txForm.spendCurrencyHintIncome':
    'Paid to you in another currency? Pick it here — any 3-letter code works.',
  // The escape hatch out of the suggested list — any well-formed code stays
  // reachable (D7); the list is only what this user usually deals in.
  'txForm.spendCurrencyOther': 'Other…',
  'txForm.spendCurrencyOtherLabel': 'Currency code, 3 letters',
  // Pair mode: the amount that actually hits the account.
  'txForm.chargedLabel': 'Charged to the account, {currency}',
  'txForm.creditedLabel': 'Credited to the account, {currency}',
  // FX_RATE_UNAVAILABLE, said BEFORE the save. Not a failure and not the user's
  // fault: only six currency pairs have stored rates, so a gap is the normal
  // answer for anything else and the way forward is the bank's own number.
  'txForm.chargeNoRateAhead':
    'We keep exchange rates for six currency pairs, and we have none for ' +
    '{from} → {to} on this date. Just write in what your bank actually took ' +
    'from the account.',
  'txForm.chargeNoRateAheadIncome':
    'We keep exchange rates for six currency pairs, and we have none for ' +
    '{from} → {to} on this date. Just write in what actually landed on the account.',
  'txForm.chargeManual':
    'We have no {from} → {to} rate for that date, so this amount is yours to fill ' +
    'in — write in what your bank actually took.',
  'txForm.chargeManualIncome':
    'We have no {from} → {to} rate for that date, so this amount is yours to fill ' +
    'in — write in what actually landed on the account.',
  'txForm.chargeRecalcDated':
    'Leave it as it is and it will be recalculated at the {date} rate.',
  'txForm.chargeRecalc': 'Leave it as it is and it will be recalculated when you save.',
  'txForm.chargeFetchFailed':
    "Couldn't fetch a rate right now. You can enter the {currency} amount yourself.",
  // `{rate}` is the SERVER's string, interpolated verbatim — never a number this
  // client computed.
  'txForm.chargeEstimate':
    '≈ {amount} at rate {rate} — the exact amount is computed when you save.',
  'txForm.chargeDefault':
    "Leave this empty and we'll use the day's rate. Fill it in if your bank charged " +
    'something else.',
  'txForm.chargeDefaultIncome':
    "Leave this empty and we'll use the day's rate. Fill it in if a different amount " +
    'actually landed on the account.',
  'txForm.converting': 'Converting…',
  'txForm.manualChargeRequired': 'Enter the amount your account was charged in {currency}.',
  'txForm.manualChargeRequiredIncome':
    'Enter the amount that actually landed on the account in {currency}.',
  // The two-amount model's own 422s (features/transactions/originalPairError.ts).
  'txForm.pairCurrencyMatchesAccount':
    'This account is already in that currency. Set the spent currency back to the ' +
    'account currency to keep just one amount.',
  'txForm.pairFieldsRequired': 'Enter both what you spent and the currency you spent it in.',
  'txForm.chargeRequired': 'Enter the amount your account was charged.',
  // The `merchant` column: what titles the row in the list.
  'txForm.merchantLabel': 'Name / place',
  'txForm.merchantLabelIncome': 'Source',
  'txForm.merchantHintIncome': 'Who paid — an employer, a client, a marketplace.',
  // The folded section: a detail of a minority of rows, so it does not crowd the
  // form.
  'txForm.moreOptions': 'More options',
  'txForm.country': 'Country',
  'txForm.countryFilter': 'Type to find a country',
  'txForm.countryMore': 'More countries are hidden — type above to find yours.',
  'txForm.category': 'Category',
  'txForm.deleteTitle': 'Delete transaction',
  'txForm.deleteMessage': "Delete this transaction? This can't be undone.",
  'txForm.isTransfer':
    'This operation is a transfer between accounts — it is edited on its own screen.',
  'txForm.openTransfer': 'Open transfer',

  // --- the photo attached to an operation -----------------------------------
  // Attaching a photo is NOT scanning it: this control uploads and links, and
  // never calls the parser, so it works with no AI key at all.
  'photo.label': 'Photo',
  'photo.alt': 'The photo you attached',
  'photo.attached': 'Photo attached',
  'photo.stays': 'It stays with this operation. Removing it here only unlinks it.',
  'photo.detailsFailed':
    "We couldn't load this photo's details, but it is still linked to this operation.",
  // The server hands out a view_url only once the upload is PROVEN, and the only
  // thing that proves it today is a scan on the web — so a photo attached here
  // is shown from the device until then, and this line must not promise more.
  'photo.unavailable':
    'The photo is attached; it can be shown here after it has been scanned on the web.',
  // The native confirm, same shape as the form's Delete (QA D-2: an inline one
  // grew under the pinned footer).
  'photo.removeTitle': 'Remove photo?',
  'photo.removeQuestion': 'Remove it from this operation?',
  'photo.gettingReady': 'Getting ready to upload…',
  'photo.uploading': 'Uploading…',
  'photo.replace': 'Replace the photo',
  'photo.takePhoto': 'Take a photo',
  'photo.choosePhoto': 'Choose a photo',
  'photo.uploadFailed': "The photo didn't upload.",
  'photo.tooLarge':
    'That photo is larger than 5 MB. Take a new one, or pick a smaller file.',
  // A denial is a state with a way out, not a dead end. iOS and Android both put
  // the switch in the system Settings app, and nothing in the app can flip it.
  'photo.cameraDenied':
    'Budget has no access to the camera. You can turn it on in Settings.',
  'photo.libraryDenied':
    'Budget has no access to your photos. You can turn it on in Settings.',
  'photo.openSettings': 'Open Settings',

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
