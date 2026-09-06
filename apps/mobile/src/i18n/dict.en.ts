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
  // catch-up 3 line A: the one-sentence `tx.filterNotice` is gone. It said the
  // totals "cover every account" and nothing else, which stopped being true once
  // the list grew a category and a country filter — and it claimed something about
  // a summary that is no longer always on screen. Web's split replaces it:
  // `tx.filterChip` (which account) plus `tx.filterSummaryNote` (the caveat, shown
  // only when the summary is actually above the list).
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

  // --- transactions filters (catch-up 3, line A) -----------------------------
  // Search box, filter sheet, sort order and the chips that say what is applied.
  // Every sentence here is web's, verbatim, so the same slice reads the same way
  // in both clients.
  'tx.searchLabel': 'Search transactions',
  'tx.searchPlaceholder': 'Merchant or note',
  'tx.searchClear': 'Clear the search',
  'tx.filters': 'Filters',
  'tx.filtersActive': {
    one: '{count} filter applied',
    other: '{count} filters applied',
  } satisfies PluralForms,
  'tx.filtersReset': 'Reset these filters',
  'tx.filterCategoryLabel': 'Category',
  'tx.allCategories': 'All categories',
  'tx.filterCountryLabel': 'Country',
  'tx.allCountries': 'All countries',
  'tx.filterCountrySearch': 'Type to find a country',
  'tx.filterMoreHidden': 'Some options are hidden — type above to narrow the list.',
  'tx.filterCategoryChip': 'Category: {category}',
  'tx.filterOneCategory': 'the selected category',
  'tx.clearCategoryFilter': 'Clear the category filter',
  'tx.filterCountryChip': 'Country: {country}',
  'tx.clearCountryFilter': 'Clear the country filter',
  'tx.sortLabel': 'Sort by',
  'tx.sortDateDesc': 'Newest first',
  'tx.sortDateAsc': 'Oldest first',
  'tx.sortAmountDesc': 'Largest amount first',
  'tx.sortAmountAsc': 'Smallest amount first',
  // The three range modes. The month stepper keeps the toolbar; the other two
  // replace it with their own label, so only one window is ever claimed at a time.
  'tx.rangeAllTime': 'All time',
  'tx.rangeCustom': 'Custom period',
  'tx.rangeBackToMonth': 'Back to this month',
  'tx.rangeApply': 'Apply',
  'tx.rangeLabel': '{from} – {to}',
  'tx.rangeInverted': 'The end date is before the start date.',
  'tx.rangeIncomplete': 'Enter both dates.',
  // The empty list, told apart by WHY it is empty: a period with nothing in it, a
  // filter that matches nothing, or an account with no history at all.
  'tx.emptyFilteredMonth': 'Nothing matches these filters in {month}',
  'tx.emptyFiltered': 'Nothing matches these filters.',
  'tx.emptyAll': 'You have no transactions yet.',
  'tx.emptyClearFilters': 'Clear search and filters',
  // Two sentences, not one: the first names the filtered account, the second is a
  // caveat about the SUMMARY, and the summary is only on screen in month mode.
  'tx.filterChip': 'Showing {account} only.',
  'tx.filterSummaryNote': 'The totals above still cover every account and category.',
  // The range-mode section of the filter sheet reuses web's period vocabulary.
  'period.unitGroup': 'Period unit',
  'period.month': 'Month',
  'period.from': 'From',
  'period.to': 'To',

  // --- searching the categories tab (catch-up 3, line A) ---------------------
  'categories.searchLabel': 'Search categories',
  'categories.searchPlaceholder': 'Search by name',
  'categories.searchEmpty': 'No category matches “{query}”.',
  'categories.searchClearAction': 'Clear the search',

  // --- one category's operations (catch-up 3, line A) ------------------------
  // A pushed SCREEN on the phone, where web opens a window over /categories.
  'categories.viewTransactionsFor': 'Transactions in “{name}”',
  'categoryTx.total': 'Total for this period',
  'categoryTx.totalFailed': "Couldn't load the total for this period.",
  'categoryTx.empty': 'No operations in this category for the chosen period.',
  'categoryTx.unavailable': 'This category is unavailable.',
  // The disclosure that rate-less rows are left out of a SERVER total. The
  // sentence names what they are missing from, and English and Russian put that
  // phrase in different places, so it is one whole entry rather than a template.
  'unconverted.month': {
    one: '{count} transaction with no exchange rate is left out of this month.',
    other: '{count} transactions with no exchange rate are left out of this month.',
  } satisfies PluralForms,
  'unconverted.totals': {
    one: '{count} transaction has no exchange rate and is not included in these totals.',
    other:
      '{count} transactions have no exchange rate and are not included in these totals.',
  } satisfies PluralForms,
  // --- end transactions filters / categories (catch-up 3, line A) ------------

  // --- recurring / settings (catch-up 3, line B) -----------------------------
  // Every sentence that also exists on web is web's, verbatim; the ones that do
  // not (a start date on the ROW, the "More" tab, the pause switch) are new here.
  'tabs.more': 'More',
  'more.recurring': 'Recurring operations',
  'more.recurringHint': 'Rent, salary, subscriptions — created for you on schedule.',

  // --- recurring templates ---------------------------------------------------
  'recurring.title': 'Recurring',
  'recurring.newTemplate': 'New template',
  'recurring.lede':
    'Templates create transactions for you on schedule — they show up in your ' +
    'transactions with a Recurring label.',
  'recurring.loadFailed': "Couldn't load your recurring templates.",
  'recurring.emptyTitle': 'No recurring templates yet.',
  'recurring.emptyBody':
    'Add rent, a salary or a subscription and it will be created automatically on ' +
    "schedule — you'll see it in your transactions with a Recurring label.",
  'recurring.deleteTitle': 'Delete template',
  'recurring.deleteMessage':
    "Delete this template? The schedule stops and the 'Recurring' label is removed " +
    'from the transactions it already created. Those transactions and their amounts stay.',
  'recurring.nextOn': 'Next on {date}',
  // Mobile-only: the list shows `start_date` too, and a template that has not
  // started yet is exactly the case `next_due_on` alone does not explain.
  'recurring.startsOn': 'Starts {date}',
  'recurring.paused': 'Paused',
  'recurring.pausedNote':
    'Nothing is created while paused, and skipped dates are not backfilled when you resume.',
  'recurring.ended': 'Ended',
  'recurring.endedOn': 'Ended {date}',
  'recurring.pause': 'Pause',
  'recurring.resume': 'Resume',
  'periodicity.monthly': 'Monthly',
  'periodicity.monthlyOnDay': 'Monthly on day {day}',
  'periodicity.weekly': 'Weekly',
  'periodicity.weeklyOn': 'Weekly on {weekday}',

  // --- the recurring-template form -------------------------------------------
  'templateForm.newTitle': 'New template',
  'templateForm.editTitle': 'Edit template',
  'templateForm.unavailable': 'This template is unavailable.',
  'templateForm.nameHint': 'What this is — "Rent", "Salary", "Spotify".',
  'templateForm.account': 'Account',
  'templateForm.accountUnknown': "This template's account",
  'templateForm.accountReadOnlyHint':
    'Every transaction this template creates is recorded on this account. It ' +
    "can't be changed after the template is created.",
  'templateForm.accountHint':
    'Every transaction this template creates is recorded on this account, in its currency.',
  // Mobile-only: the currency is the account's (the server refuses any other), so
  // it is stated in the amount label instead of offered as a control.
  'templateForm.amountIn': 'Amount, {currency}',
  'templateForm.repeats': 'Repeats',
  'templateForm.dayOfMonth': 'Day of the month',
  'templateForm.clampHint': 'Months shorter than this use their last day (31 → Feb 28).',
  'templateForm.weekday': 'Weekday',
  'templateForm.startDate': 'Start date',
  'templateForm.startDateHint':
    'The repeat day above follows the date you pick here. Leave it empty to start ' +
    'on the next date that matches the schedule.',
  'templateForm.startDateConflict':
    'This template starts {startDate}, but the repeat is set to "{schedule}": the ' +
    'first transaction will be created on {firstCharge}.',
  'templateForm.endDate': 'End date',
  'templateForm.endDateHint': 'Leave empty to keep it running until you pause or delete it.',
  'templateForm.endDatePassed': 'This end date has passed — nothing will be created.',
  'templateForm.merchant': 'Merchant',
  'templateForm.noteHint': 'Copied onto every transaction this template creates.',
  'templateForm.paused': 'Paused',

  // --- upcoming charges widget (transactions tab) ----------------------------
  'upcoming.title': 'Next 30 days',
  'upcoming.today': 'today',
  'upcoming.loadFailed': "Couldn't load your upcoming charges.",
  'upcoming.emptyTitle': 'Nothing scheduled in the next 30 days.',
  'upcoming.emptyBody':
    'Rent, a salary or a subscription saved as a recurring template shows up here ' +
    'before it is charged.',
  'upcoming.manage': 'Manage recurring',
  'upcoming.more': {
    one: '{count} more charge.',
    other: '{count} more charges.',
  } satisfies PluralForms,

  // --- settings / language ---------------------------------------------------
  'settings.language.title': 'Language',
  'settings.language.lede':
    'Sets the language of the interface, and the way dates and numbers are ' +
    'written. It is saved to your profile, so the web app follows the same choice.',
  'settings.language.saving': 'Saving…',
  'settings.language.saveFailed':
    "Couldn't save your language — nothing was changed. Try again.",

  // --- settings / base currency ----------------------------------------------
  'settings.baseCurrency.title': 'Base currency',
  'settings.baseCurrency.lede':
    'The currency your totals, budgets and goals are shown in. It is saved to your ' +
    'profile, so the web app follows the same choice.',
  'settings.baseCurrency.saving': 'Saving…',
  'settings.baseCurrency.saveFailed':
    "Couldn't save your base currency — nothing was changed. Try again.",
  'settings.baseCurrency.loadFailed': "Couldn't load your profile.",
  // Three facts, stated before the control is touched.
  'settings.baseCurrency.warning':
    'Changing it changes what you see, not what is stored: every transaction keeps the ' +
    'amount and the rate it was recorded with. Transactions we have no rate for are ' +
    'shown as unconverted instead of being quietly folded into your totals. Your ' +
    'declared monthly income is cleared — enter it again in the new currency.',
  'settings.baseCurrency.confirmTitle': 'Change base currency?',
  'settings.baseCurrency.confirmMessage':
    'Your totals move from {from} to {to}. Stored amounts and rates are untouched; ' +
    'this changes only what you are shown.',
  'settings.baseCurrency.confirmMessageIncome':
    'You declared a monthly income of {amount} {from}. That number is stored without ' +
    'a currency, so it cannot be carried over to {to}: it is cleared, and the field ' +
    'below gets a converted suggestion you can accept or retype.',
  'settings.baseCurrency.confirmSubmit': 'Change to {to}',

  // --- settings / declared monthly income ------------------------------------
  'settings.income.title': 'Monthly income',
  'settings.income.lede':
    'Goals use it while there is not enough history to work out what you actually have ' +
    'left over each month.',
  'settings.income.label': 'Monthly income',
  'settings.income.baseNote':
    'Read as an amount in {currency}, your base currency. It is never re-denominated ' +
    'on its own: change the base currency and this field is cleared, so the number is ' +
    'always the one you typed in the currency you meant.',
  'settings.income.clearHint':
    'Leave it empty to remove the declared income — goals then wait for real history.',
  'settings.income.save': 'Save',
  'settings.income.saving': 'Saving…',
  'settings.income.saved': 'Saved.',
  'settings.income.saveFailed': "Couldn't save your monthly income — nothing was changed.",
  'settings.income.suggestion':
    'Suggestion: {amount}, your previous income converted from {from} at today’s ' +
    'rate. Nothing is saved until you press Save.',
  'settings.income.suggestionUnavailable':
    'There was no rate to convert your previous income, so the field is empty — enter ' +
    'the amount in {currency}.',
  'settings.income.error.malformed': 'Enter an amount like 1200 or 1200.50.',
  'settings.income.error.negative': 'Enter a positive amount.',
  'settings.income.error.tooManyDecimals': 'Too many decimal places for {currency}.',
  'settings.income.error.overflow': 'That amount is too large.',
  // --- end recurring / settings (catch-up 3, line B) -------------------------

  // --- goals (catch-up 3, line C) --------------------------------------------
  // Wording taken from web's dict.en.ts wherever the same sentence exists there,
  // so the same fact reads the same way on both clients. Keys that name a control
  // this client alone has (a segment, a tab, a chip row) are new.
  'tabs.goals': 'Goals',
  'common.edit': 'Edit',

  'goals.showArchived': 'Show archived',
  'goals.newGoal': 'New goal',
  'goals.loadFailed': "Couldn't load your goals.",
  'goals.openPlanHint': 'Opens the plan of this goal',
  'goals.editAria': 'Edit {name}',
  'goals.emptyTitle': 'No goals yet.',
  'goals.emptyBody':
    'Create one to see how much of your monthly surplus it would take and whether your ' +
    'deadline is realistic.',
  'goals.realismUnavailable':
    'Some transactions in that window had no exchange rate and were left out, so this ' +
    'figure — and the pace estimates below — are incomplete.',
  // Split around the amount so it can carry its own weight in the sentence.
  'goals.freeBalancePrefix': 'Over the last 3 full months you had about',
  'goals.freeBalanceSuffix':
    "a month left over. That's what gets shared out below, top priority first.",
  'goals.freeBalanceNone':
    'Over the last 3 full months you spent at least as much as you earned ({amount} a ' +
    "month left over), so there's nothing to share out between goals yet.",
  // The average is divided by the months that actually HAD activity, so "the last
  // 3 full months" is only true when all three did.
  'goals.freeBalancePrefixPartial':
    'Counting the {count} of the last 3 months that had any activity, you had about',
  'goals.freeBalanceNonePartial':
    'In the {count} of the last 3 months that had any activity you spent at least as ' +
    "much as you earned ({amount} a month left over), so there's nothing to share out " +
    'between goals yet.',
  // Answers "why doesn't this month's income count?" — the window is three FULL
  // months, so the current one joins it when it closes.
  'goals.freeBalanceBasis': 'Counted over the months {from} – {to}',
  'goals.freeBalanceCurrentMonthNote':
    'This month is still running, so what you earn and spend now starts counting ' +
    'once the month is over.',
  'goals.freeBalanceDeclaredPrefix':
    'You have no full months of activity yet, so goals are planned from the income you ' +
    'declared:',
  'goals.freeBalanceDeclaredSuffix':
    "a month. That's what gets shared out below, top priority first.",
  'goals.freeBalanceDeclaredBasis':
    'Once a full month with transactions is behind you, this switches to what you ' +
    'actually had left over.',
  'goals.freeBalanceDeclaredZero':
    'You declared a monthly income of zero and there is no history yet, so there is ' +
    'nothing to share out between goals.',
  'goals.freeBalanceNoBasisTitle': 'Nothing to plan from yet.',
  'goals.freeBalanceNoBasisBody':
    'There are no full months of transactions behind you and no declared monthly ' +
    'income, so goals cannot be given a share of anything yet. Tell us what you earn ' +
    'in a month and planning starts right away.',
  // Mobile sends the user to the More tab, which is where the income lives here.
  'goals.freeBalanceNoBasisLink': 'Set your monthly income in More',

  // --- the goal card ---------------------------------------------------------
  'goalCard.reached': 'Reached',
  'goalCard.priority': 'Priority {value}',
  'goalCard.ofTarget': 'of {target}',
  'goalCard.deadline': 'Deadline {date}',
  'goalCard.noDeadline': 'No deadline',
  'goalCard.completed': "You've reached this goal.",
  'goalCard.effectiveTarget': 'total cost of the plan',
  'goalCard.targetBeforePlan': 'You set {amount} before planning',
  'goalCard.planBottomUp':
    'The plan is still incomplete — this total comes from the items and will grow.',
  'goalCard.realismUnavailable':
    "Can't check whether this is realistic — no exchange rate for {currency} right now. " +
    'Your saved and target amounts are unaffected.',
  'goalCard.noDeadlineHint':
    "No deadline set, so there's no monthly target — add one to see whether you're on pace.",
  'goalCard.onTrack': 'On track: {amount} a month gets you there.',
  'goalCard.behindTitle':
    'Not realistic at your current pace — this deadline needs {amount} a month.',
  'goalCard.monthsToTarget': {
    one: 'At your free balance it takes about {count} month',
    other: 'At your free balance it takes about {count} months',
  } satisfies PluralForms,
  'goalCard.monthsPlain': '{months}.',
  'goalCard.monthsWithSuggestion': '{months} — move the deadline to {date}?',
  'goalCard.behindUnreachable':
    "Your free balance doesn't cover this goal right now, so we can't estimate when " +
    "you'd get there.",
  'goalCard.allocated': '{amount} a month of your free balance is going here.',
  'goalCard.noAllocation': 'None of your free balance is going here right now.',

  // --- the goal form ---------------------------------------------------------
  'goalForm.newTitle': 'New goal',
  'goalForm.editTitle': 'Edit goal',
  'goalForm.unavailable': 'This goal is unavailable.',
  'goalForm.target': 'Target amount ({currency})',
  // Mobile makes the currency read-only after create (web offers the relabel
  // behind a wide confirm) — the hint says where that decision can be made.
  'goalForm.currencyImmutableHint':
    "A goal's currency is changed on the web, where the relabelling of every saved " +
    'amount can be read in full. Nothing is ever converted.',
  'goalForm.deadline': 'Deadline',
  'goalForm.deadlineHint':
    "Without a deadline we track what you save but never say you're behind.",
  'goalForm.priority': 'Priority',
  'goalForm.priorityHint': 'Lower runs first: your free balance is shared out top-priority first.',
  'goalForm.priorityHintEdit': 'Leave blank to keep the current one.',
  'goalForm.priorityHintCreate': 'Leave blank to add it last.',
  'goalForm.initialSaved': 'Already saved',
  'goalForm.initialSavedHint': "Recorded as this goal's first contribution, in {currency}.",
  'goalForm.archiveTitle': 'Archive goal',
  'goalForm.unarchiveTitle': 'Unarchive goal',
  'goalForm.archiveMessage':
    'Archive "{name}"? Its history is kept, but it stops taking a share of your free balance.',
  'goalForm.unarchiveMessage': 'Bring "{name}" back? It will share your free balance again.',
  'goalForm.deleteTitle': 'Delete goal',
  'goalForm.deleteMessage':
    'Delete "{name}"? Every contribution recorded against it is deleted too. This ' +
    "can't be undone — archive it instead if you want to keep the history.",

  // --- contributions ---------------------------------------------------------
  'contribution.title': 'Add or withdraw — {name}',
  'contribution.shortTitle': 'Add or withdraw',
  'contribution.direction': 'Direction',
  'contribution.add': 'Add',
  'contribution.withdraw': 'Withdraw',
  'contribution.amount': 'Amount ({currency})',
  'contribution.futureDated':
    'This date is in the future. It counts toward the goal right away.',
  'contributionList.loadFailed': "Couldn't load this goal's history.",
  'contributionList.empty':
    'No money moved yet. Use "Add or withdraw" to record your first contribution.',
  'contributionList.deleteTitle': 'Delete entry',
  'contributionList.deleteMessage': "Delete this entry? This can't be undone.",

  // --- the plan screen -------------------------------------------------------
  'goalPlan.title': 'Plan',
  'goalPlan.backToGoals': '← All goals',
  'goalPlan.notFound': 'This goal no longer exists, or it was deleted.',
  'goalPlan.loadFailed': "Couldn't load this goal's plan.",
  'goalPlan.archivedBanner':
    'This goal is archived, so its plan is read-only. Unarchive it to make changes.',
  'goalPlan.manualTarget': 'Target',
  'goalPlan.finalCostBottomUp': 'Total cost of the plan',
  'goalPlan.finalCostManual': 'Total cost (set by you)',
  'goalPlan.plannedTotal': 'Items add up to',
  'goalPlan.planIncomplete':
    'The plan is still incomplete: this total is assembled from the items below and ' +
    'will grow as you add more.',
  // The amount set before the plan existed, kept on screen next to the plan's own
  // total — a reference, never a second "total".
  'goalPlan.targetBeforePlan': 'Amount you set before planning',
  'goalPlan.initialBudget': 'Initial budget',
  'goalPlan.paid': 'Paid',
  'goalPlan.saved': 'Saved',
  'goalPlan.remaining': 'Still to find',
  'goalPlan.savedTab': 'Saved history',
  'goalPlan.addContribution': 'Add or withdraw',
  'goalPlan.editCost': 'Edit the cost',
  'goalPlan.plannedUnconverted': {
    one: "{count} item has no rate to {currency}, so it isn't counted in the total.",
    other: "{count} items have no rate to {currency}, so they aren't counted in the total.",
  } satisfies PluralForms,
  'goalPlan.paidUnconverted': {
    one: "{count} attached operation has no rate to {currency}, so it isn't counted as paid.",
    other:
      "{count} attached operations have no rate to {currency}, so they aren't counted as paid.",
  } satisfies PluralForms,
  'goalPlan.costTitle': 'Cost',
  'goalPlan.costLede': 'The items below add up to {amount}.',
  'goalPlan.finalCostLabel': 'Total cost, set by hand',
  'goalPlan.finalCostHint':
    'In {currency}. Leave it empty to use the sum of the items instead.',
  'goalPlan.initialBudgetLabel': 'Initial budget',
  'goalPlan.initialBudgetHint': 'In {currency}. What you are setting aside for this goal.',
  'goalPlan.itemsTitle': 'Plan items',
  'goalPlan.addItem': 'Add item',
  'goalPlan.addChild': 'Add inside',
  'goalPlan.emptyTitle': 'This goal has no plan items yet.',
  'goalPlan.emptyBody':
    'Break the goal down — a flight, a hotel, insurance — and each item can carry its ' +
    'own price, deadline and links. Until then the goal keeps the amount you set.',
  'goalPlan.firstItemTitle': 'Start planning from the items?',
  'goalPlan.firstItemMessage':
    "From the first item on, this goal's total cost is assembled from its items and " +
    'will grow as you add more. The amount you set stays as a reference, and you can ' +
    'always set the total by hand again.',
  'goalPlan.firstItemConfirm': 'Add the first item',
  'goalPlan.noOwnAmount': 'No price of its own',
  'goalPlan.convertedSuffix': '≈ {amount}',
  'goalPlan.childrenSum': 'Items inside: {amount}',
  'goalPlan.paidOnNode': 'Paid {amount}',
  'goalPlan.ceilingExceeded':
    'The items inside add up to {children}, more than this item’s own {own}. The ' +
    'total uses the items.',
  'goalPlan.nodeUnconverted':
    'No rate from {from} to {to}, so this amount is not in the totals.',
  'goalPlan.nodePaidUnconverted': {
    one: "{count} attached operation isn't counted as paid — no rate for it.",
    other: "{count} attached operations aren't counted as paid — no rate for them.",
  } satisfies PluralForms,
  'goalPlan.noDeadline': 'No deadline',
  'goalPlan.deadlineOwn': 'By {date}',
  'goalPlan.deadlineInherited': "By {date} · the goal's deadline",
  // The row's "within the next 30 days" mark — the same horizon the deadlines
  // widget uses, so a marked row is a row that widget is showing.
  'goalPlan.soon': 'soon',
  'goalPlan.detailsHint': 'Shows this item and what can be done with it',
  'goalPlan.filesCount': {
    one: '{count} file',
    other: '{count} files',
  } satisfies PluralForms,
  'goalPlan.expandNode': 'Expand {name}',
  'goalPlan.collapseNode': 'Collapse {name}',
  'goalPlan.moveUp': 'Up',
  'goalPlan.moveDown': 'Down',
  'goalPlan.moveUpAria': 'Move {name} up',
  'goalPlan.moveDownAria': 'Move {name} down',
  'goalPlan.moveTo': 'Move',
  'goalPlan.moveTitle': 'Move "{name}"',
  'goalPlan.moveToRoot': 'Top level of the plan',
  'goalPlan.moveNoTargets': 'There is nowhere else this item can go.',
  'goalPlan.moveHint':
    'It moves with everything inside it, and lands last among its new neighbours — ' +
    'use Up and Down to reorder.',
  'goalPlan.deleteTitle': 'Delete plan item',
  // Four sentences, assembled by the screen: the two counts appear only when they
  // are non-zero, and neither of them counts the item being deleted.
  'goalPlan.deleteMessage': 'Delete "{name}"?',
  'goalPlan.deleteChildrenNote': {
    one: '{count} item inside it goes too.',
    other: '{count} items inside it go too.',
  } satisfies PluralForms,
  'goalPlan.deleteFilesNote': {
    one: '{count} attached file is deleted with it.',
    other: '{count} attached files are deleted with it.',
  } satisfies PluralForms,
  'goalPlan.deleteKeepsOperations':
    'Attached operations stay in your history — they simply stop being attached.',

  // --- the plan item form ----------------------------------------------------
  'goalItemForm.newTitle': 'New plan item',
  'goalItemForm.editTitle': 'Edit plan item',
  'goalItemForm.unavailable': 'This plan item is unavailable.',
  'goalItemForm.amount': 'Price ({currency})',
  'goalItemForm.amountHint':
    'Leave it empty for a grouping item — its price is whatever the items inside add up to.',
  'goalItemForm.converted': 'Amount in {currency}',
  'goalItemForm.convertedHint':
    'Leave it empty and the server converts it to {currency} itself. A value you type ' +
    'wins over the automatic one.',
  'goalItemForm.converting': 'Converting…',
  'goalItemForm.convertedNoRate':
    'No rate from {from} to {to} today — type the amount yourself, or this item stays ' +
    'out of the totals.',
  'goalItemForm.convertedRate': 'Rate {rate} as of {date}',
  'goalItemForm.deadline': 'Deadline',
  // Split in two because the first sentence ENDS on a date: ru dates already
  // carry their own "г.", so the screen terminates it with `sentenceEnd` instead
  // of a hard-coded dot.
  'goalItemForm.deadlineInheritHint': "Leave it empty to follow the goal's deadline, {date}",
  'goalItemForm.deadlineInheritMove': 'Move the goal and this moves with it.',
  'goalItemForm.deadlineNoneHint':
    'The goal has no deadline, so leaving this empty means this item has none either.',
  'goalItemForm.remindLegend': 'Remind me',
  'goalItemForm.remindNone': "Don't remind me",
  'goalItemForm.remindOn': 'On a specific date',
  'goalItemForm.remindDays': 'Days before the deadline',
  'goalItemForm.remindPreview': 'That works out as {date}',
  'goalItemForm.remindPreviewPending': 'Fill this in to see the date.',
  'goalItemForm.remindNoDeadline':
    'There is no deadline to count back from yet, so this reminder has no date. Set a ' +
    'deadline and it starts working.',
  'goalItemForm.description': 'Notes',
  'goalItemForm.links': 'Links',
  // One input per link here, not web's one-per-line textarea.
  'goalItemForm.linkNumber': 'Link {number}',
  'goalItemForm.addLink': 'Add a link',
  'goalItemForm.linksHint': 'A booking, a listing, anything worth keeping.',
  'goalItemForm.nameRequired': 'Give this item a name.',
  'goalItemForm.nameTooLong': 'The name must be at most {max} characters.',
  'goalItemForm.descriptionTooLong': 'Notes must be at most {max} characters.',
  'goalItemForm.tooManyLinks': 'At most {max} links.',
  'goalItemForm.linkTooLong': 'A link must be at most {max} characters.',
  'goalItemForm.amountMalformed': 'Enter a valid amount in {currency}.',
  'goalItemForm.amountNegative': 'The amount must not be negative.',
  'goalItemForm.amountDecimals': 'Too many decimal places for {currency}.',
  'goalItemForm.amountOverflow': 'That amount is too large.',
  'goalItemForm.amountPositive': 'Enter an amount greater than zero.',
  'goalItemForm.badDate': 'Choose a valid date.',
  'goalItemForm.remindDateRequired': 'Choose the date to be reminded on.',
  'goalItemForm.remindDaysRequired': 'Enter a whole number of days, up to {max}.',

  // --- photos on a plan item -------------------------------------------------
  'goalPhoto.title': 'Photos',
  'goalPhoto.alt': 'A photo on this plan item',
  'goalPhoto.listFailed': "Couldn't load the photos of this item.",
  'goalPhoto.expired': "This photo didn't load. Retry and it will be fetched again.",
  'goalPhoto.notUploadedTile': "Upload didn't finish",
  'goalPhoto.deleteTitle': 'Delete photo',
  'goalPhoto.deleteMessage':
    "Delete this photo? It can't be undone. The plan item itself stays.",
  'goalPhoto.tooLarge': 'That image is too large. Pick a smaller photo.',
  'goalPhoto.uploadFailed': "The upload didn't go through. Try again.",
  'goalPhoto.limit':
    'This item already holds {max} photos — the most it can. Delete one to add another.',
  'goalPhoto.notUploaded': "The photo didn't finish uploading. Add it again.",
  'goalPhoto.fileGone': 'This photo is no longer there.',
  'goalPhoto.storageUnavailable':
    'Photo storage is unavailable right now. Try again in a moment.',
  'goalPhoto.archived':
    'This goal is archived, so its plan is read-only. Unarchive it to change photos.',
  'goalPhoto.itemGone': 'This plan item no longer exists. Refresh and try again.',
  'goalPhoto.goalGone': 'This goal no longer exists, or it was deleted.',
  'goalPhoto.generic': 'Something went wrong with that photo. Try again.',

  // --- the deadlines widget --------------------------------------------------
  // "and deposits" is absent on purpose: this client has no deposits screen.
  'deadlines.title': 'Coming up in your plans',
  'deadlines.emptyTitle': 'Nothing due in your plans in the next 30 days.',
  'deadlines.emptyBody':
    'Give a plan item a deadline or a reminder and it shows up here before the date.',
  'goalDeadlines.today': 'today',
  'goalDeadlines.loadFailed': "Couldn't load your goal deadlines.",
  'goalDeadlines.manage': 'Open goals',
  // The deadline behind a reminder date — a suffix, not a second column.
  'goalDeadlines.dueBy': 'due {date}',
  'goalDeadlines.more': {
    one: '{count} more item.',
    other: '{count} more items.',
  } satisfies PluralForms,

  // --- the plan-item picker in the transaction form --------------------------
  'txForm.goalItem': 'Goal',
  'txForm.goalItemNone': 'Not part of a goal',
  'txForm.goalItemNode': 'Plan item',
  'txForm.goalItemNoNode': 'No item chosen',
  'txForm.goalItemResolving': 'Attached to a plan item — finding which one…',
  'txForm.goalItemGoalsFailed': "Couldn't load your goals, so this can't be changed right now.",
  'txForm.goalItemNodesFailed': "Couldn't load this goal's plan.",
  'txForm.goalItemEmptyPlan': 'This goal has no plan items yet. Open the goal to add some.',
  'txForm.goalItemUnknown':
    'This operation is attached to a plan item we can no longer find — its goal may be ' +
    'archived. It stays attached unless you detach it.',
  'txForm.goalItemDetach': 'Detach',
  // --- end goals (catch-up 3, line C) ----------------------------------------
};
