// The ENGLISH dictionary — the source of truth for the key set.
//
// `keyof typeof en` is the `MessageKey` type (t.ts), and dict.ru.ts is annotated
// with a mapped type over this object: a key added here and forgotten in ru, or a
// plural entry written as a plain string, fails `pnpm typecheck` rather than
// silently rendering a raw key in production. That type safety is the whole
// reason this layer is hand-written instead of pulling in i18next (plan-web S5).
//
// Keys are dotted namespaces by SCREEN/AREA, and values interpolate `{name}`
// placeholders. Copy for error CODES does not live here — it is shared with
// mobile (`ERROR_MESSAGES` in @budget/shared) and reached through lib/errors.ts.
//
// NOT in here, on purpose:
//   * user-typed names (categories, accounts, goals, templates, merchants);
//   * system category names — keyed by frozen UUID in @budget/shared;
//   * anything the SERVER wrote: advisor answers, `transfer_rate` strings,
//     parsed receipt line items.
import type { PluralForms } from './types';

export const en = {
  // --- shared vocabulary ---------------------------------------------------
  'common.save': 'Save',
  'common.saving': 'Saving…',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.deleting': 'Deleting…',
  'common.remove': 'Remove',
  'common.removing': 'Removing…',
  'common.edit': 'Edit',
  'common.archive': 'Archive',
  'common.archiving': 'Archiving…',
  'common.unarchive': 'Unarchive',
  'common.unarchiving': 'Unarchiving…',
  'common.retry': 'Retry',
  'common.tryAgain': 'Try again',
  'common.loading': 'Loading…',
  'common.loadMore': 'Load more',
  'common.close': 'Close',
  'common.working': 'Working…',
  'common.optional': '(optional)',
  'common.archivedParens': '(archived)',
  'common.archivedTag': 'Archived',
  'common.date': 'Date',
  'common.note': 'Note',
  'common.name': 'Name',
  'common.type': 'Type',
  'common.currency': 'Currency',
  'common.amount': 'Amount',
  'common.expense': 'Expense',
  'common.income': 'Income',
  'common.net': 'Net',
  'common.uncategorized': 'Uncategorized',
  'common.unknownCategory': 'Unknown category',
  'common.notSet': 'Not set',

  // --- the shared modal shell ---------------------------------------------
  'modal.discardMessage': 'Discard your changes? What you typed here will be lost.',
  'modal.keepEditing': 'Keep editing',
  'modal.discardConfirm': 'Discard changes',

  // --- the base-currency shell every money form waits on -------------------
  'form.baseCurrencyLoadFailed':
    "Couldn't load your account currency. Close this and try again.",
  'form.baseCurrencyLoading': 'Loading account currency…',

  // --- app shell ----------------------------------------------------------
  'nav.primary': 'Primary',
  'nav.transactions': 'Transactions',
  'nav.stats': 'Stats',
  'nav.advisor': 'AI',
  'nav.accounts': 'Accounts',
  'nav.categories': 'Categories',
  'nav.recurring': 'Recurring',
  'nav.goals': 'Goals',
  'nav.settings': 'Settings',
  'shell.meLoadFailed': "Couldn't load your account.",
  'shell.logout': 'Log out',
  'shell.loggingOut': 'Logging out…',

  'notFound.title': 'Page not found',
  'notFound.body': "The page you were looking for doesn't exist.",
  'notFound.back': 'Back to home',

  // --- auth ---------------------------------------------------------------
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.signIn': 'Sign in',
  'auth.signingIn': 'Signing in…',
  'auth.signInSubtitle': 'Welcome back to Budget.',
  'auth.noAccount': 'No account?',
  'auth.createOne': 'Create one',
  'auth.sessionExpired': 'Your session expired — please sign in again.',
  'auth.accountCreated': 'Account created — please sign in.',
  'auth.createAccount': 'Create account',
  'auth.creatingAccount': 'Creating account…',
  'auth.createSubtitle': 'Start tracking your budget.',
  'auth.haveAccount': 'Already have an account?',
  'auth.passwordHint': 'At least 8 characters.',
  // The auth failure table (auth/errors.ts routes CODES; the copy is here).
  'authError.network': "Can't reach the server. Check your connection and try again.",
  'authError.badCredentials': 'Incorrect email or password.',
  'authError.emailExists': 'An account with this email already exists.',
  'authError.invalidPassword': 'Password must be at least 8 characters.',
  'authError.rateLimited': 'Too many attempts. Please wait a minute and try again.',
  'authError.invalidEmail': 'Enter a valid email address.',
  'authError.generic': 'Something went wrong. Please try again.',

  // --- accounts -----------------------------------------------------------
  'accounts.title': 'Accounts',
  'accounts.add': 'Add account',
  'accounts.loadFailed': "Couldn't load your accounts.",
  'accounts.empty': 'Add your first account — every transaction is recorded on one.',
  'accounts.archivedGroup': 'Archived',
  'accounts.typeCard': 'Card',
  'accounts.typeCash': 'Cash',
  'accounts.choose': 'Choose an account…',
  'accounts.required': 'Create an account first — every transaction is recorded on one.',
  'accounts.goToAccounts': 'Go to accounts',
  'accounts.filterLabel': 'Filter by account',
  'accounts.all': 'All accounts',
  'accounts.unavailable': 'Unavailable account',
  'accountForm.newTitle': 'New account',
  'accountForm.editTitle': 'Edit account',
  'accountForm.archiveTitle': 'Archive account',
  'accountForm.unarchiveTitle': 'Unarchive account',
  'accountForm.archiveMessage':
    'Archive "{name}"? Its past operations stay exactly as they are — it just ' +
    'stops being offered for new ones.',
  'accountForm.unarchiveMessage': 'Restore "{name}" so it can be used again?',
  'accountForm.currencyImmutableHint':
    "An account's currency can't change. To switch, archive this account and " +
    'create a new one.',
  'accountForm.currencyCreateHint':
    "Everything recorded on this account is in this currency, and it can't be " +
    'changed later.',
  'accountForm.startingBalance': 'Starting balance',
  'accountForm.startingBalanceHint':
    'What was on this account before you started tracking, in {currency}. Leave ' +
    'empty for zero; a card you owe on starts negative (e.g. -250).',

  // --- transactions: list, toolbar, summary --------------------------------
  'tx.title': 'Transactions',
  'tx.add': 'Add transaction',
  'tx.addTransfer': 'Add transfer',
  'tx.addByPhoto': 'Add by photo',
  'tx.export': 'Export CSV',
  'tx.exporting': 'Exporting…',
  'tx.exportDone': 'Downloaded {file}.',
  'tx.exportDoneEmpty': 'Downloaded {file} — no transactions matched, so it has headers only.',
  'tx.filterChip': 'Showing {account} only.',
  'tx.filterOneAccount': 'one account',
  'tx.filterCategoryChip': 'Category: {category}',
  'tx.filterOneCategory': 'the selected category',
  'tx.filterSummaryNote': 'The totals above still cover every account and category.',
  'tx.clearCategoryFilter': 'Clear the category filter',
  'tx.showAllAccounts': 'Show all accounts',
  'tx.showAllCategories': 'Show all categories',
  'tx.rangeAllTime': 'All time',
  'tx.rangeShowAllTime': 'Show all time',
  'tx.rangeBackToMonth': 'Back to this month',
  // category-drilldown-and-budget-ui: the third range mode — a custom period.
  'tx.rangeCustom': 'Custom period',
  'tx.rangeApply': 'Apply',
  'tx.rangeLabel': '{from} – {to}',
  'tx.rangeInverted': 'The end date is before the start date.',
  'tx.rangeIncomplete': 'Enter both dates.',
  'tx.loadFailed': "Couldn't load transactions.",
  'tx.emptyMonth': 'No transactions in {month}',
  'tx.emptyMonthCta': 'Add your first one.',
  'tx.emptyAccountMonth': 'No operations on this account in {month}',
  'tx.emptyFilteredMonth': 'Nothing matches these filters in {month}',
  'tx.emptyFiltered': 'Nothing matches these filters.',
  'tx.emptyAll': 'You have no transactions yet.',
  'tx.showing': 'Showing {shown} of {total}',
  'tx.recurringChip': 'Recurring',
  'tx.transfer': 'Transfer',
  'tx.transferRoute': 'Transfer: {route}',
  // search-and-drilldown S3: search box, filter popover, sort order.
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
  'tx.filterCountryChip': 'Country: {country}',
  'tx.clearCountryFilter': 'Clear the country filter',
  'tx.sortLabel': 'Sort by',
  'tx.sortDateDesc': 'Newest first',
  'tx.sortDateAsc': 'Oldest first',
  'tx.sortAmountDesc': 'Largest amount first',
  'tx.sortAmountAsc': 'Smallest amount first',
  'tx.emptyClearFilters': 'Clear search and filters',
  'monthPicker.previous': 'Previous month',
  'monthPicker.next': 'Next month',
  'summary.loadFailed': "Couldn't load this month's summary.",
  'summary.noSpend': 'No spend yet this month.',

  // The disclosure that rate-less rows are left out of a server total. One
  // plural entry per SCOPE, because the sentence names what they are missing
  // from and English/Russian put that phrase in different places.
  'unconverted.totals': {
    one: '{count} transaction has no exchange rate and is not included in these totals.',
    other:
      '{count} transactions have no exchange rate and are not included in these totals.',
  } satisfies PluralForms,
  'unconverted.spentAmounts': {
    one: '{count} transaction has no exchange rate and is not included in these spent amounts.',
    other:
      '{count} transactions have no exchange rate and are not included in these spent amounts.',
  } satisfies PluralForms,
  'unconverted.merchantTotals': {
    one: '{count} transaction has no exchange rate and is not included in these merchant totals.',
    other:
      '{count} transactions have no exchange rate and are not included in these merchant totals.',
  } satisfies PluralForms,
  'unconverted.month': {
    one: '{count} transaction with no exchange rate is left out of this month.',
    other: '{count} transactions with no exchange rate are left out of this month.',
  } satisfies PluralForms,

  // Used by the top-merchants list. Seeded in phase 1 because the Russian forms
  // are the part a hand-rolled dictionary gets wrong, and t.test.ts pins them.
  transactionCount: {
    one: '{count} transaction',
    other: '{count} transactions',
  } satisfies PluralForms,

  // --- the transaction form ------------------------------------------------
  'txForm.newTitle': 'New transaction',
  'txForm.editTitle': 'Edit transaction',
  'txForm.fromTemplateLede':
    'Filled in from "{name}". Check the amount and save — this records an ' +
    'ordinary operation and does not replace the scheduled one.',
  'txForm.confirmTitle': 'Confirm receipt',
  'txForm.confirmLede':
    'Read from your photo — check it and save. Anything wrong can be edited here.',
  // The account label names the DIRECTION, so the form reads correctly before
  // anything is filled in (the Type radios sit above it).
  'txForm.accountExpense': 'Paid from',
  'txForm.accountIncome': 'Received to',
  'txForm.receiptCurrencyWarning':
    'This receipt is in {receiptCurrency}, but the account you picked is in ' +
    '{accountCurrency}. It will be saved as {accountCurrency} — check the amount, ' +
    'or choose an account in {receiptCurrency}.',
  'txForm.spentLabel': 'Spent, {currency}',
  'txForm.amountLabel': 'Amount, {currency}',
  // Income twins of the four above. The slot is the same field; only the
  // direction changes, and "Spent" on a salary was the actual complaint.
  'txForm.receivedLabel': 'Received, {currency}',
  'txForm.amountLabelIncome': 'Received, {currency}',
  // Visible captions of the currency picker, not aria-labels: an unlabelled code
  // box next to the amount was read as "the currency is fixed".
  'txForm.spendCurrencyLabel': 'Currency spent',
  'txForm.spendCurrencyLabelIncome': 'Currency received',
  // The escape hatch out of the suggested list — any well-formed code stays
  // reachable (D7), the list is only what this user usually deals in.
  'txForm.spendCurrencyOther': 'Other currency…',
  'txForm.spendCurrencyOtherLabel': 'Currency code, 3 letters',
  'txForm.spendCurrencyHint':
    'Spent in another currency? Pick it here — any 3-letter code works.',
  'txForm.spendCurrencyHintIncome':
    'Paid to you in another currency? Pick it here — any 3-letter code works.',
  'txForm.chargedLabel': 'Charged to the account, {currency}',
  'txForm.creditedLabel': 'Credited to the account, {currency}',
  // FX_RATE_UNAVAILABLE, said BEFORE the save. Not a failure and not the user's
  // fault: only six currency pairs have stored rates, so a gap is the normal
  // answer for anything else and the way forward is the bank's own number.
  'txForm.chargeNoRateAhead':
    'We keep exchange rates for six currency pairs, and we have none for ' +
    '{from} → {to} on this date. Just write in what your bank actually took ' +
    'from the account.',
  'txForm.chargeManual':
    'We have no {from} → {to} rate for that date, so this amount is yours to fill in — ' +
    'write in what your bank actually took.',
  'txForm.chargeManualIncome':
    'We have no {from} → {to} rate for that date, so this amount is yours to fill in — ' +
    'write in what actually landed on the account.',
  'txForm.chargeRecalcDated':
    'Leave it as it is and it will be recalculated at the {date} rate.',
  'txForm.chargeRecalc': 'Leave it as it is and it will be recalculated when you save.',
  'txForm.chargeFetchFailed':
    "Couldn't fetch a rate right now. You can enter the {currency} amount yourself.",
  'txForm.chargeEstimate':
    '≈ {amount} at rate {rate} — the exact amount is computed when you save.',
  'txForm.chargeDefault':
    "Leave this empty and we'll use the day's rate. Fill it in if your bank charged " +
    'something else.',
  'txForm.chargeDefaultIncome':
    "Leave this empty and we'll use the day's rate. Fill it in if a different amount " +
    'actually landed on the account.',
  'txForm.converting': 'Converting…',
  'txForm.convertedLegend': 'Amount in {currency}',
  'txForm.resetToAuto': 'Reset to auto',
  'txForm.convertedRecalcDated':
    'Will be recalculated at the {date} rate when you save.',
  'txForm.convertedRecalc': 'Will be recalculated when you save.',
  'txForm.convertedFetchFailed':
    "Couldn't fetch a rate right now. You can enter the {currency} amount yourself.",
  'txForm.convertedNoRate':
    'No exchange rate available for {from}→{to}. You can enter the {to} amount yourself.',
  'txForm.convertedRate': 'Rate {rate} as of {date}',
  'txForm.convertedEstimate': '≈ Estimate — the exact amount is computed when you save.',
  'txForm.convertedDefault':
    'Leave this empty to have the {currency} amount calculated for you.',
  'txForm.category': 'Category',
  'txForm.suggestedFromSimilar': 'Suggested from a similar receipt',
  'txForm.suggestedFromReceipt': 'Suggested from this receipt',
  'txForm.merchantLabel': 'Name / place',
  // Relabelled, never hidden: this is the `merchant` column, and it is what
  // titles the row in the list — hiding it would leave every salary titled by
  // its category alone.
  'txForm.merchantLabelIncome': 'Source',
  'txForm.merchantHintIncome': 'Who paid — an employer, a client, a marketplace.',
  'txForm.moreOptions': 'More options',
  'txForm.country': 'Country',
  'txForm.deleteTitle': 'Delete transaction',
  'txForm.deleteMessage': "Delete this transaction? This can't be undone.",
  'txForm.manualChargeRequired': 'Enter the amount your account was charged in {currency}.',
  'txForm.manualChargeRequiredIncome':
    'Enter the amount that actually landed on the account in {currency}.',
  // The two-amount model's own 422s (features/transactions/originalPair.ts).
  'txForm.pairCurrencyMatchesAccount':
    'This account is already in that currency. Set the spent currency back to the ' +
    'account currency to keep just one amount.',
  'txForm.pairFieldsRequired': 'Enter both what you spent and the currency you spent it in.',
  'txForm.chargeRequired': 'Enter the amount your account was charged.',

  // --- the photo attached to an operation ----------------------------------
  'photo.label': 'Photo',
  'photo.alt': 'The photo you attached',
  'photo.attached': 'Photo attached',
  'photo.alreadyScanned': ' · already scanned',
  'photo.detailsFailed':
    "We couldn't load this photo's details, but it is still linked to this operation.",
  'photo.stays': 'It stays with this operation. Removing it here only unlinks it.',
  'photo.removeGroup': 'Remove the photo?',
  'photo.removeQuestion': 'Remove it from this operation?',
  'photo.keepIt': 'Keep it',
  'photo.preparing': 'Preparing the photo…',
  'photo.gettingReady': 'Getting ready to upload…',
  'photo.uploading': 'Uploading…',
  'photo.attach': 'Attach a photo',
  'photo.replace': 'Replace the photo',

  // --- receipts (capture flow) ---------------------------------------------
  'receipt.captureTitle': 'Add by photo',
  'receipt.dropText': 'Drop a photo of a receipt here — or a screenshot of a bank notification.',
  'receipt.choosePhoto': 'Choose a photo',
  'receipt.shrinkHint': 'The photo is shrunk on your device before it is uploaded.',
  'receipt.addManually': 'Add manually instead',
  'receipt.uploadingPhoto': 'Uploading the photo…',
  'receipt.reading': 'Reading the receipt…',
  'receipt.takesSeconds': 'This usually takes a few seconds.',
  'receipt.uploadedQuestion': 'Photo uploaded. What should we do with it?',
  'receipt.scanWithAi': 'Scan with AI',
  'receipt.scanHint': 'Reads the amount, date and merchant off the photo for you.',
  'receipt.saveWithoutScanning': 'Save without scanning',
  'receipt.saveHint': 'Keeps the photo attached to a transaction you fill in yourself.',
  'receipt.saved': 'Receipt saved.',
  'receipt.savedHint':
    'Attach it to a transaction now — after you close this window the photo can no ' +
    'longer be picked out.',
  'receipt.addTransactionWith': 'Add transaction with this receipt',
  'receipt.timedOut':
    'This is taking longer than expected. The photo is uploaded — you can wait and ' +
    'try reading it again, or add the transaction yourself.',
  'receipt.tryReadingAgain': 'Try reading again',
  'receipt.chooseAnother': 'Choose another photo',
  'receipt.notAnImage': 'That file is not an image. Pick a photo or a screenshot.',
  'receipt.sourceTooLarge': 'That file is too big to open here. Pick a smaller photo.',
  'receipt.decodeFailed': "Couldn't open that image. Try a different photo.",
  'receipt.encodeFailed': "Couldn't prepare that image on this device. Try a different photo.",
  'receipt.prepareFailed': "Couldn't prepare that image. Try a different photo.",
  'receipt.uploadFailed': "The photo couldn't be uploaded. Try again.",
  'receipt.itemsHeading': 'On this receipt',

  // --- transfers ------------------------------------------------------------
  'transfer.newTitle': 'New transfer',
  'transfer.editTitle': 'Edit transfer',
  'transfer.deleteTitle': 'Delete transfer',
  'transfer.deleteMessage':
    'Delete this transfer? Both sides of it go, and both account balances go back.',
  'transfer.needTwoAccounts':
    'A transfer moves money between two accounts — create a second one on the ' +
    'accounts screen first.',
  'transfer.from': 'From',
  'transfer.to': 'To',
  'transfer.amountSent': 'Amount sent',
  'transfer.amountSentIn': 'Amount sent ({currency})',
  'transfer.amountReceived': 'Amount received',
  'transfer.amountReceivedIn': 'Amount received ({currency})',
  'transfer.receivedHint':
    "What actually landed on the other account — your bank's real rate, fees included.",
  'transfer.rateAtTime': 'Rate at the time: {rate} {counterCurrency} per 1 {currency}',

  // --- categories -----------------------------------------------------------
  'categories.title': 'Categories',
  'categories.add': 'Add category',
  'categories.loadFailed': "Couldn't load your categories.",
  'categories.budgetsTitle': 'Budgets for {month}',
  'categories.budgetsLoadFailed': "Couldn't load your budgets.",
  'categories.budgetsEmpty':
    "No budgets yet — set one on any expense category to track how much of it you've " +
    'used this month.',
  'categories.systemTag': 'System',
  'categories.viewTransactions': 'Transactions in this category',
  'categories.viewTransactionsFor': 'Transactions in “{name}”',
  'categories.searchLabel': 'Search categories',
  'categories.searchPlaceholder': 'Search by name',
  'categories.searchEmpty': 'No category matches “{query}”.',
  'categories.searchClearAction': 'Clear the search',
  'categoryForm.newTitle': 'New category',
  'categoryForm.editTitle': 'Edit category',
  'categoryForm.archiveTitle': 'Archive category',
  'categoryForm.unarchiveTitle': 'Unarchive category',
  'categoryForm.archiveMessage':
    'Archive "{name}"? It stays on past transactions but won\'t be selectable for new ones.',
  'categoryForm.unarchiveMessage': 'Restore "{name}" so it can be used again?',
  'categoryForm.icon': 'Icon',
  'categoryForm.color': 'Color',
  'categoryForm.colorHint': '(optional, e.g. #3366FF)',

  // --- budgets (category limits) -------------------------------------------
  'limits.setBudget': 'Set a budget',
  'limits.setBudgetFor': 'Set a budget for {name}',
  'limits.updateBudget': 'Update budget',
  'limits.editBudgetFor': '{action} — budget for {name}',
  'limits.removeBudgetFor': 'Remove the budget for {name}',
  'limits.removeTitle': 'Remove budget',
  'limits.removeMessage': 'Remove the budget for "{name}"? Your transactions are not affected.',
  'limitForm.setTitle': 'Set a budget — {name}',
  'limitForm.editTitle': 'Edit budget — {name}',
  'limitForm.amount': 'Monthly budget',
  'limitForm.baseCurrencyHint': 'Budgets are set in your base currency.',
  'limitForm.restamp':
    'The current budget is {amount}. Enter what it should be in {currency} — saving ' +
    're-stamps it.',
  'limitForm.submit': 'Save budget',
  'limitBar.budgetLabel': 'Budget:',
  'limitBar.spentInline': 'spent {amount}',
  'limitBar.mismatch':
    'This budget is set in {limitCurrency} but your base currency is now {currency}. ' +
    'Update the budget to compare them.',
  'limitBar.ofLimit': 'of {limit}',
  'limitBar.pair': '{spent} of {limit}',
  'limitBar.over': 'Over by {amount}',
  'limitBar.left': '{amount} left',
  'limitBar.aria': '{name} budget',

  // --- recurring templates --------------------------------------------------
  'recurring.title': 'Recurring',
  'recurring.newTemplate': 'New template',
  'recurring.lede':
    'Templates create transactions for you on schedule — they show up in your ' +
    'transactions with a Recurring label.',
  'recurring.loadFailed': "Couldn't load your recurring templates.",
  'recurring.emptyTitle': 'No recurring templates yet.',
  'recurring.emptyBody':
    "Add rent, a salary or a subscription and it will be created automatically on " +
    "schedule — you'll see it in your transactions with a Recurring label.",
  'recurring.deleteTitle': 'Delete template',
  'recurring.deleteMessage':
    "Delete this template? The schedule stops and the 'Recurring' label is removed " +
    'from the transactions it already created. Those transactions and their amounts stay.',
  'recurring.nextOn': 'Next on {date}',
  'recurring.paused': 'Paused',
  'recurring.pausedNote':
    'Nothing is created while paused, and skipped dates are not backfilled when you resume.',
  'recurring.ended': 'Ended',
  'recurring.endedOn': 'Ended {date}',
  'recurring.pause': 'Pause',
  'recurring.resume': 'Resume',
  'recurring.addTransaction': 'Add operation',
  'periodicity.monthly': 'Monthly',
  'periodicity.monthlyOnDay': 'Monthly on day {day}',
  'periodicity.weekly': 'Weekly',
  'periodicity.weeklyOn': 'Weekly on {weekday}',
  'templateForm.newTitle': 'New template',
  'templateForm.editTitle': 'Edit template',
  'templateForm.nameHint': 'What this is — "Rent", "Salary", "Spotify".',
  'templateForm.account': 'Account',
  'templateForm.accountUnknown': "This template's account",
  'templateForm.accountReadOnlyHint':
    'Every transaction this template creates is recorded on this account. It ' +
    "can't be changed after the template is created.",
  'templateForm.accountHint':
    'Every transaction this template creates is recorded on this account.',
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

  // --- upcoming charges widget (/transactions) ------------------------------
  'upcoming.title': 'Next 30 days',
  'upcoming.today': 'today',
  'upcoming.loadFailed': "Couldn't load your upcoming charges.",
  'upcoming.emptyTitle': 'Nothing scheduled in the next 30 days.',
  'upcoming.emptyBody':
    'Rent, a salary or a subscription saved as a recurring template shows up here ' +
    'before it is charged.',
  'upcoming.manage': 'Manage recurring',
  'upcoming.addFromTemplate': 'Add an operation from "{name}", dated {date}',
  'upcoming.addFromTemplateShort': 'Add an operation from this template',
  'upcoming.more': {
    one: '{count} more charge.',
    other: '{count} more charges.',
  } satisfies PluralForms,

  // --- goals ----------------------------------------------------------------
  'goals.title': 'Goals',
  'goals.showArchived': 'Show archived',
  'goals.newGoal': 'New goal',
  'goals.loadFailed': "Couldn't load your goals.",
  // Split around the amount so it can stay <strong> in the markup.
  'goals.freeBalancePrefix': 'Over the last 3 full months you had about',
  'goals.freeBalanceSuffix':
    "a month left over. That's what gets shared out below, top priority first.",
  'goals.freeBalanceNone':
    'Over the last 3 full months you spent at least as much as you earned ({amount} a ' +
    "month left over), so there's nothing to share out between goals yet.",
  // Answers "why doesn't this month's income count?" — the window is three FULL
  // months, so the current one joins it when it closes (architecture C: explain
  // the rule, do not change it).
  'goals.freeBalanceBasis': 'Counted over the months {from} – {to}',
  'goals.freeBalanceCurrentMonthNote':
    'This month is still running, so what you earn and spend now starts counting ' +
    'once the month is over.',
  // base-currency-and-goal-basis W1: the average is divided by the months that
  // actually HAD activity (server D2), so "the last 3 full months" is only true
  // when all three did. With 1 or 2 the sentence says so — the same figure
  // presented as a three-month average was the reported dishonesty.
  'goals.freeBalancePrefixPartial':
    'Counting the {count} of the last 3 months that had any activity, you had about',
  'goals.freeBalanceNonePartial':
    'In the {count} of the last 3 months that had any activity you spent at least as ' +
    "much as you earned ({amount} a month left over), so there's nothing to share out " +
    'between goals yet.',
  // Basis "declared": no month has any activity, so the free balance IS the
  // income the user typed in Settings. No month window is shown for this arm —
  // naming three months that contributed nothing is exactly the claim D2 fixes.
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
  // Basis "none": no history AND no declared income. The old copy claimed the
  // user had spent as much as they earned — a flat falsehood for a brand-new
  // account, and the defect this scope was opened for.
  'goals.freeBalanceNoBasisTitle': 'Nothing to plan from yet.',
  'goals.freeBalanceNoBasisBody':
    'There are no full months of transactions behind you and no declared monthly ' +
    'income, so goals cannot be given a share of anything yet. Tell us what you earn ' +
    'in a month and planning starts right away.',
  'goals.freeBalanceNoBasisLink': 'Set your monthly income',
  'goals.realismUnavailable':
    'Some transactions in that window had no exchange rate and were left out, so this ' +
    'figure — and the pace estimates below — are incomplete.',
  'goals.emptyTitle': 'No goals yet.',
  'goals.emptyBody':
    'Create one to see how much of your monthly surplus it would take and whether your ' +
    'deadline is realistic.',
  'goalCard.reached': 'Reached',
  'goalCard.priority': 'Priority {value}',
  'goalCard.ofTarget': 'of {target}',
  'goalCard.pair': '{saved} of {target}',
  'goalCard.progressAria': '{name} progress',
  'goalCard.deadline': 'Deadline {date}',
  'goalCard.noDeadline': 'No deadline',
  'goalCard.completed': "You've reached this goal.",
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
  'goalCard.effectiveTarget': 'total cost of the plan',
  'goalCard.planBottomUp':
    'The plan is still incomplete — this total comes from the items and will grow.',
  'goalCard.openPlan': 'Plan',
  'goalCard.addOrWithdraw': 'Add or withdraw',
  'goalCard.hideHistory': 'Hide history',
  'goalCard.showHistory': 'History & progress',
  'goalCard.archiveTitle': 'Archive goal',
  'goalCard.unarchiveTitle': 'Unarchive goal',
  'goalCard.archiveMessage':
    'Archive "{name}"? Its history is kept, but it stops taking a share of your free balance.',
  'goalCard.unarchiveMessage': 'Bring "{name}" back? It will share your free balance again.',
  'goalCard.deleteTitle': 'Delete goal',
  'goalCard.deleteMessage':
    'Delete "{name}"? Every contribution recorded against it is deleted too. This ' +
    "can't be undone — archive it instead if you want to keep the history.",
  'goalForm.newTitle': 'New goal',
  'goalForm.editTitle': 'Edit goal',
  'goalForm.target': 'Target amount',
  'goalForm.currencyChangeTitle': 'Change currency',
  'goalForm.currencyChangeMessage':
    'Changing the currency relabels every saved amount in {currency}. Nothing is ' +
    'recalculated or converted.',
  'goalForm.currencyChangeNotice':
    'Saved amounts will simply be relabelled in {currency} — nothing is converted.',
  'goalForm.deadline': 'Deadline',
  'goalForm.deadlineHint':
    "Without a deadline we track what you save but never say you're behind.",
  'goalForm.priority': 'Priority',
  'goalForm.priorityHint': 'Lower runs first: your free balance is shared out top-priority first.',
  'goalForm.priorityHintEdit': 'Leave blank to keep the current one.',
  'goalForm.priorityHintCreate': 'Leave blank to add it last.',
  'goalForm.initialSaved': 'Already saved',
  'goalForm.initialSavedHint': "Recorded as this goal's first contribution, in {currency}.",
  'contribution.title': 'Add or withdraw — {name}',
  'contribution.direction': 'Direction',
  'contribution.add': 'Add',
  'contribution.withdraw': 'Withdraw',
  'contribution.amount': 'Amount ({currency})',
  'contribution.hintAdd': 'Enter how much to put aside.',
  'contribution.hintWithdraw': 'Enter how much to take out — no minus sign needed.',
  'contribution.futureNotice':
    'This date is in the future. It counts toward the goal right away, but the ' +
    'progress chart only shows months up to this one.',
  'contributionList.loadFailed': "Couldn't load this goal's history.",
  'contributionList.empty':
    'No money moved yet. Use “Add or withdraw” to record your first contribution.',
  'contributionList.deleteTitle': 'Delete entry',
  'contributionList.deleteMessage': "Delete {amount} from {date}? This can't be undone.",
  'goalChart.loadFailed': "Couldn't load the progress chart.",
  'goalChart.empty': 'Nothing to chart yet — the line starts with your first contribution.',
  'goalChart.emptyFutureOnly':
    'Nothing to chart yet — everything saved here ({amount}) is dated after this month.',
  'goalChart.trailingNote':
    'The chart stops at this month — anything dated later counts toward the saved total ' +
    '({amount}) but not toward the line.',
  'goalChart.target': 'Target',
  'goalChart.thisMonth': 'This month',
  'goalChart.saved': 'Saved',

  // --- stats ----------------------------------------------------------------
  'stats.title': 'Stats',
  'stats.askAi': 'Ask AI',
  'stats.resetPeriod': 'Reset to this month',
  'stats.empty': 'No transactions in {period}',
  'stats.emptyBody':
    'Add one, or pick a period you know has activity — the stepper is right above.',
  'stats.emptyBodyCustom': 'Add one, or widen the From/To range right above.',
  'stats.addTransaction': 'Add a transaction',
  'stats.backToThisMonth': 'Back to this month',
  'period.unitGroup': 'Period unit',
  'period.month': 'Month',
  'period.quarter': 'Quarter',
  'period.year': 'Year',
  'period.custom': 'Custom',
  'period.previous': 'Previous period: {unit}',
  'period.next': 'Next period: {unit}',
  'period.from': 'From',
  'period.to': 'To',
  'statsTotals.expenses': 'Expenses',
  'statsTotals.comparedWith':
    'Compared with {from} – {to} — the same length immediately before, resolved by the server.',
  'statsTotals.bothZero': 'Same as last period — both zero.',
  'statsTotals.bothZeroIncomplete': 'Nothing this period — and last period is incomplete.',
  'statsTotals.incomplete': '— last period is incomplete, so no percentage',
  'statsTotals.noBaseZero': '— nothing last period',
  'statsTotals.noBaseNegative': '— last period was negative, so no percentage',
  'breakdown.heading': 'By category',
  'budgets.heading': 'Budgets',
  'budgets.manage': 'Manage budgets',
  'budgets.monthOnly': 'Budgets are monthly — pick a month period to see them.',
  'budgets.emptyPrefix': 'No budgets set for {month}.',
  'budgets.emptyLink': 'Set one on a category',
  'budgets.emptySuffix': "to track how much of it you've used.",
  'goalsSection.open': 'Open goals',
  'goalsSection.emptyPrefix': 'No goals yet.',
  'goalsSection.emptyLink': 'Create one',
  'goalsSection.emptySuffix': 'to see how much of your monthly surplus it would take.',
  'monthly.heading': 'Last {months} months',
  'monthly.windowGroup': 'Months shown',
  'monthly.scopeNote':
    'A trailing window ending with the current month — it does not follow the period ' +
    'selected above.',
  'monthly.loadFailed': "Couldn't load the monthly chart.",
  'monthly.emptyWindow': 'No activity in this window.',
  'monthly.currentMonthNote':
    'The last bar ({month}) is this month so far — it covers a part-month and will keep growing.',
  'monthly.flaggedNote':
    '{months} include transactions with no exchange rate — those are left out of the ' +
    'bars. Hover a month for its own count.',
  'monthly.footer': 'Amounts in {currency}, over {months} months.',
  'monthly.thisMonthSoFar': ' — this month so far',
  'topMerchants.heading': 'Top merchants (spending)',
  'topMerchants.loadFailed': "Couldn't load top merchants.",
  'topMerchants.empty':
    'No merchant names yet — receipts and manual entries with a merchant show up here.',

  // --- advisor (chrome only; the ANSWERS are the model's and are never touched)
  'advisor.title': 'AI advisor',
  'advisor.toStats': 'To stats',
  'advisor.lead':
    'Answers are built from your spending over the last few months, your categories ' +
    'and your goals. The conversation is kept on this page only.',
  'advisor.emptyTitle': 'Ask about your spending',
  'advisor.emptyBody':
    'The AI sees your categories, your amounts over the last few months and your ' +
    'goals — and answers in plain text. For example:',
  'advisor.example1': 'Where is my money going this month?',
  'advisor.example2': 'What could I cut back on?',
  'advisor.example3': 'How am I doing against my goals?',
  'advisor.you': 'You',
  'advisor.assistant': 'AI',
  'advisor.typing': 'AI is typing…',
  'advisor.stopped': 'You stopped the answer.',
  'advisor.answerReady': 'Answer ready',
  'advisor.questionLabel': 'Question',
  'advisor.placeholder': 'For example: how much did I spend on food in July?',
  'advisor.counter': '{length} / {max} · Cmd/Ctrl+Enter to send',
  'advisor.stop': 'Stop',
  'advisor.answering': 'Answering…',
  'advisor.ask': 'Ask',
  'advisor.questionRequired': 'Enter a question.',
  'advisor.questionTooLong': 'The question must be at most {max} characters.',

  // --- settings / access tokens --------------------------------------------
  'settings.title': 'Settings',
  'settings.language.title': 'Language',
  'settings.language.lede':
    'Sets the language of the interface, and the way dates and numbers are ' +
    'written. It is saved to your profile, so the mobile app follows the same ' +
    'choice.',
  'settings.language.label': 'Interface language',
  'settings.language.saving': 'Saving…',
  'settings.language.saveFailed':
    "Couldn't save this to your profile — it still applies on this device.",
  // --- settings / base currency (base-currency-and-goal-basis D1) ----------
  'settings.baseCurrency.title': 'Base currency',
  'settings.baseCurrency.lede':
    'The currency your totals, budgets and goals are shown in. It is saved to your ' +
    'profile, so the mobile app follows the same choice.',
  'settings.baseCurrency.label': 'Base currency',
  'settings.baseCurrency.saving': 'Saving…',
  'settings.baseCurrency.saveFailed':
    "Couldn't save your base currency — nothing was changed. Try again.",
  'settings.baseCurrency.loadFailed': "Couldn't load your profile.",
  // Three facts, stated before the control is touched (D1 + Amendment A1).
  'settings.baseCurrency.warning':
    'Changing it changes what you see, not what is stored: every transaction keeps the ' +
    'amount and the rate it was recorded with. Transactions we have no rate for are ' +
    'shown as unconverted instead of being quietly folded into your totals. Your ' +
    'declared monthly income is cleared — enter it again in the new currency.',
  'settings.baseCurrency.confirmTitle': 'Change base currency?',
  'settings.baseCurrency.confirmMessage':
    'You declared a monthly income of {amount} {from}. That number is stored without ' +
    'a currency, so it cannot be carried over to {to}: it is cleared, and we take you ' +
    'straight to the field with a converted suggestion you can accept or retype.',
  'settings.baseCurrency.confirmSubmit': 'Change to {to}',
  'settings.baseCurrency.confirmPending': 'Changing…',

  // --- settings / declared monthly income (D2) -----------------------------
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
  'settings.income.saveFailed':
    "Couldn't save your monthly income — nothing was changed.",
  'settings.income.suggestion':
    'Suggestion: {amount}, your previous income converted from {from} at today\u2019s ' +
    'rate. Nothing is saved until you press Save.',
  'settings.income.suggestionUnavailable':
    'There was no rate to convert your previous income, so the field is empty — enter ' +
    'the amount in {currency}.',
  'settings.income.error.malformed': 'Enter an amount like 1200 or 1200.50.',
  'settings.income.error.negative': 'Enter a positive amount.',
  'settings.income.error.tooManyDecimals': 'Too many decimal places for {currency}.',
  'settings.income.error.overflow': 'That amount is too large.',
  'tokens.heading': 'Access tokens',
  'tokens.new': 'New token',
  'tokens.lede':
    'A token lets an MCP client — Claude Desktop or Claude Code — work with this budget ' +
    'on your behalf. You choose what each token may do, and you can revoke it at any time.',
  'tokens.loadFailed': "Couldn't load your access tokens.",
  'tokens.emptyTitle': 'No access tokens yet.',
  'tokens.emptyBody':
    'Create one to connect Claude Desktop or Claude Code to this budget. The token ' +
    'string is shown once, right after you create it.',
  'tokens.revokeTitle': 'Revoke token',
  'tokens.revokeMessage':
    'Revoke "{name}"? Anything using this token stops working immediately, and the ' +
    'token cannot be restored.',
  'tokens.revoke': 'Revoke',
  'tokens.revoking': 'Revoking…',
  'tokens.scopeRead': 'View only',
  'tokens.scopeFull': 'View and change',
  'tokens.revokedBadge': 'Revoked {date}',
  'tokens.created': 'Created {date}',
  'tokens.lastUsed': 'last used {date}',
  'tokens.neverUsed': 'never used',
  'tokenForm.createdTitle': 'Your new token',
  'tokenForm.namePlaceholder': 'MacBook — Claude Desktop',
  'tokenForm.nameHint': 'Only you see this. It is how you tell your tokens apart later.',
  'tokenForm.nameRequired': 'Give this token a name so you can tell it apart later.',
  'tokenForm.nameTooLong': 'The name must be at most {max} characters.',
  'tokenForm.scopeLegend': 'What this token may do',
  'tokenForm.scopeReadBody':
    'Can look at your data — transactions, categories, budgets, goals and statistics. ' +
    'It cannot change or delete anything.',
  'tokenForm.scopeFullBody':
    'Can look at your data and change it — including adding, editing and deleting ' +
    'transactions.',
  'tokenForm.create': 'Create token',
  'tokenForm.creating': 'Creating…',
  'tokenCreated.introPrefix': 'Token',
  'tokenCreated.introSuffix':
    "is ready. Paste it into your MCP client's configuration.",
  'tokenCreated.srLabel': 'Your new token',
  'tokenCreated.copy': 'Copy',
  'tokenCreated.copied': 'Copied',
  'tokenCreated.copiedStatus': 'Token copied to the clipboard.',
  'tokenCreated.copyFailed':
    "Couldn't copy automatically — the token is selected above, copy it by hand (Ctrl+C / ⌘C).",
  'tokenCreated.warning':
    'Save it now — we will never show this string again. If you lose it, revoke this ' +
    'token and create a new one.',
  'tokenCreated.done': 'Done',

  // --- goal plan (goal-planner W1) ----------------------------------------
  // Goal and item NAMES are user-typed and never appear here.
  'goalPlan.title': 'Plan',
  'goalPlan.backToGoals': '← All goals',
  'goalPlan.notFound': 'This goal no longer exists, or it was deleted.',
  'goalPlan.loadFailed': "Couldn't load this goal's plan.",
  'goalPlan.archivedBanner':
    'This goal is archived, so its plan is read-only. Unarchive it to make changes.',
  'goalPlan.summaryAria': 'Goal cost and progress',
  'goalPlan.manualTarget': 'Target',
  'goalPlan.finalCostBottomUp': 'Total cost of the plan',
  'goalPlan.finalCostManual': 'Total cost (set by you)',
  'goalPlan.finalCostNone': 'not set',
  'goalPlan.plannedTotal': 'Items add up to',
  'goalPlan.planIncomplete':
    'The plan is still incomplete: this total is assembled from the items below and ' +
    'will grow as you add more.',
  'goalPlan.initialBudget': 'Initial budget',
  'goalPlan.paid': 'Paid',
  'goalPlan.saved': 'Saved',
  'goalPlan.remaining': 'Still to find',
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
  'goalPlan.costSaved': 'Saved.',
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
  'goalPlan.filesCount': {
    one: '{count} file',
    other: '{count} files',
  } satisfies PluralForms,
  'goalPlan.showDetails': 'Details',
  'goalPlan.hideDetails': 'Hide details',
  'goalPlan.detailsEmpty': 'No description, links or files on this item.',
  'goalPlan.expandNode': 'Expand {name}',
  'goalPlan.collapseNode': 'Collapse {name}',
  'goalPlan.hiddenChildren': {
    one: '{count} item hidden',
    other: '{count} items hidden',
  } satisfies PluralForms,
  'goalPlan.moveUpAria': 'Move {name} up',
  'goalPlan.moveDownAria': 'Move {name} down',
  'goalPlan.moveTo': 'Move',
  'goalPlan.moveTitle': 'Move "{name}"',
  'goalPlan.moveParentLabel': 'Put it inside',
  'goalPlan.moveToRoot': 'Top level of the plan',
  'goalPlan.moveHint':
    'It moves with everything inside it, and lands last among its new neighbours — ' +
    'use the arrows to reorder.',
  'goalPlan.moveConfirm': 'Move',
  'goalPlan.deleteTitle': 'Delete plan item',
  'goalPlan.deleteMessage':
    'Delete "{name}"? This removes {items} and {files}. Operations attached to them ' +
    'stay in your history — they simply stop being attached.',
  'goalPlan.deleteItemsCount': {
    one: '{count} plan item',
    other: '{count} plan items',
  } satisfies PluralForms,
  'goalPlan.deleteFilesCount': {
    one: '{count} attached file',
    other: '{count} attached files',
  } satisfies PluralForms,

  // --- plan item form -------------------------------------------------------
  'goalItemForm.newTitle': 'New plan item',
  'goalItemForm.editTitle': 'Edit plan item',
  'goalItemForm.amount': 'Price',
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
  'goalItemForm.convertedAuto': 'Back to the automatic amount',
  'goalItemForm.deadline': 'Deadline',
  'goalItemForm.deadlineInheritHint':
    "Leave it empty to follow the goal's deadline, {date}. Move the goal and this moves with it.",
  'goalItemForm.deadlineNoneHint':
    'The goal has no deadline, so leaving this empty means this item has none either.',
  'goalItemForm.remindLegend': 'Remind me',
  'goalItemForm.remindNone': "Don't remind me",
  'goalItemForm.remindOn': 'On a specific date',
  'goalItemForm.remindDays': 'A number of days before the deadline',
  'goalItemForm.remindPreview': 'That works out as {date}.',
  'goalItemForm.remindPreviewPending': 'Fill this in to see the date.',
  'goalItemForm.remindNoDeadline':
    'There is no deadline to count back from yet, so this reminder has no date. Set a ' +
    'deadline and it starts working.',
  'goalItemForm.description': 'Notes',
  'goalItemForm.links': 'Links',
  'goalItemForm.linksHint': 'One per line — a booking, a listing, anything worth keeping.',
  'goalItemForm.error.nameRequired': 'Give this item a name.',
  'goalItemForm.error.nameTooLong': 'The name must be at most {max} characters.',
  'goalItemForm.error.descriptionTooLong': 'Notes must be at most {max} characters.',
  'goalItemForm.error.tooManyLinks': 'At most {max} links.',
  'goalItemForm.error.linkTooLong': 'A link must be at most {max} characters.',
  'goalItemForm.error.amountMalformed': 'Enter a valid amount in {currency}.',
  'goalItemForm.error.amountNegative': 'The amount must not be negative.',
  'goalItemForm.error.amountDecimals': 'Too many decimal places for {currency}.',
  'goalItemForm.error.amountOverflow': 'That amount is too large.',
  'goalItemForm.error.amountPositive': 'Enter an amount greater than zero.',
  'goalItemForm.error.badDate': 'Choose a valid date.',
  'goalItemForm.error.remindDateRequired': 'Choose the date to be reminded on.',
  'goalItemForm.error.remindDaysRequired': 'Enter a whole number of days, up to {max}.',
};
