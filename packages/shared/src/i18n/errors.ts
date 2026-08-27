// Error COPY, per language, keyed by a message id.
//
// Codes stay codes (F6): the wire keeps sending SCREAMING_SNAKE `detail` strings
// and each client keeps its own code -> field routing (apps/web/src/lib/errors.ts).
// What moves here is only the sentence a human reads, because mobile shows the
// same sentences for the same failures.
//
// Keys are MESSAGE ids, not codes, on purpose: the same code says different things
// in different places (CATEGORY_NOT_FOUND in the category form vs. in the budget
// dialog), and one code -> one string would force one of those two to lie.
import type { Lang } from './lang';

export type ErrorMessageKey =
  // shared by every surface
  | 'network'
  | 'generic'
  // categories
  | 'category.systemReadonly'
  | 'category.notFound'
  | 'category.nameConflict'
  | 'categoryUnavailable'
  // accounts
  | 'account.notFound'
  | 'account.archived'
  | 'account.currencyImmutable'
  // deposits
  | 'deposit.notFound'
  | 'deposit.archived'
  | 'deposit.unarchiveOnly'
  | 'deposit.termBeforeOpening'
  // transactions & transfers
  | 'transaction.notFound'
  | 'transaction.accountUnavailable'
  | 'transaction.accountArchived'
  | 'transaction.currencyMismatch'
  | 'transaction.sameAccountTransfer'
  | 'transaction.receiptUnavailable'
  | 'transaction.depositTransferOnly'
  // goals
  | 'goal.notFound'
  | 'contribution.exceedsSaved'
  | 'contribution.notFound'
  // goal plan items (goal-planner)
  | 'goal.archived'
  | 'goalItem.notFound'
  | 'goalItem.parentNotFound'
  | 'goalItem.cycle'
  | 'goalItem.depthExceeded'
  | 'goalItem.limitExceeded'
  // recurring templates
  | 'recurring.notFound'
  | 'recurring.accountUnavailable'
  | 'recurring.startAfterEnd'
  | 'recurring.startTooEarly'
  // category limits (budgets)
  | 'limit.categoryNotExpense'
  | 'limit.categoryArchived'
  | 'limit.alreadyGone'
  // personal access tokens
  | 'token.alreadyRevoked'
  // receipts
  | 'receipt.rateLimited'
  | 'receipt.notFound'
  | 'receipt.notUploaded'
  | 'receipt.processing'
  | 'receipt.alreadyParsed'
  | 'receipt.imageTooLarge'
  | 'receipt.storageUnavailable'
  | 'receipt.aiNotConfigured'
  | 'receipt.notAReceipt'
  | 'receipt.unreadable'
  | 'receipt.invalidOutput'
  | 'receipt.anthropicError'
  | 'receipt.downloadFailed'
  // statement imports (statement-import S4). Additive: mobile has no statement
  // client (frozen), but these are refusals about the user's MONEY and about a
  // file they chose, in the same voice as every other code in this table — the
  // moment mobile unfreezes it needs the identical sentences.
  | 'statement.accountNotFound'
  | 'statement.accountArchived'
  | 'statement.tooLarge'
  | 'statement.parseFailed'
  | 'statement.formatUnknown'
  | 'statement.currencyMismatch'
  | 'statement.rateLimited'
  | 'statement.importNotFound'
  | 'statement.importFinished'
  | 'statement.decisionNeedsMatch'
  | 'statement.transferReplaceForbidden'
  | 'statement.replaceFromOutOfRange'
  | 'statement.replaceConfirmationMismatch'
  // advisor
  | 'advisor.aiNotConfigured'
  | 'advisor.rateLimited'
  | 'advisor.anthropicError'
  | 'advisor.streamIncomplete';

export const ERROR_MESSAGES: Record<Lang, Record<ErrorMessageKey, string>> = {
  en: {
    network: "Can't reach the server. Check your connection and try again.",
    generic: 'Something went wrong. Please try again.',

    'category.systemReadonly': "System categories can't be edited.",
    'category.notFound': 'That category no longer exists. Refresh and try again.',
    'category.nameConflict': 'A category with this name already exists in this type.',
    categoryUnavailable: 'That category is unavailable. Pick another one.',

    'account.notFound': 'This account no longer exists. Refresh and try again.',
    'account.archived': 'This account is archived. Unarchive it or pick another one.',
    'account.currencyImmutable':
      "An account's currency can't change. Archive this one and create a new " +
      'account in the currency you need.',

    'deposit.notFound': 'This deposit no longer exists. Refresh and try again.',
    'deposit.archived':
      "This deposit is closed, so its terms can't be changed. Reopen it first.",
    // The server accepts a write on a closed deposit only as the reopening flag
    // ALONE, so this fires on a stale screen: the copy says why there are two
    // steps rather than repeating a code at the user.
    'deposit.unarchiveOnly':
      'Reopening a deposit and editing it are two separate steps. Reopen it first, ' +
      'then change what you need.',
    'deposit.termBeforeOpening': 'The term must end after the opening date.',

    'transaction.notFound': 'This transaction no longer exists. Refresh and try again.',
    'transaction.accountUnavailable':
      'That account is no longer available. Refresh and pick another one.',
    'transaction.accountArchived':
      'That account is archived, so nothing new can be recorded on it. ' +
      'Pick another account and save again.',
    'transaction.currencyMismatch':
      "This amount doesn't match the account's currency. Reopen the form and try again.",
    'transaction.sameAccountTransfer': 'Pick a different account to transfer to.',
    'transaction.receiptUnavailable':
      'This receipt is no longer available, so it can’t be attached. ' +
      'Close this and add the transaction manually.',
    // Only a TRANSFER may touch a deposit's ledger (architecture): the deposit
    // side is never offered in an expense/income picker, so this takes a stale
    // screen — and the copy names the way that does work.
    'transaction.depositTransferOnly':
      'A deposit only takes transfers. Move the money with a transfer from the ' +
      'deposits screen instead.',

    'goal.notFound': 'This goal no longer exists. Refresh and try again.',
    'contribution.exceedsSaved': "That's more than this goal has saved.",
    'contribution.notFound': 'This contribution no longer exists. Refresh and try again.',

    'goal.archived': 'This goal is archived, so its plan can\u2019t be changed. Unarchive it first.',
    'goalItem.notFound': 'This plan item no longer exists. Refresh and try again.',
    'goalItem.parentNotFound':
      'That parent item is no longer in this plan. Refresh and pick another one.',
    'goalItem.cycle': "An item can't be moved inside itself. Pick a different parent.",
    'goalItem.depthExceeded':
      'The plan only goes six levels deep. Move this item somewhere higher up.',
    'goalItem.limitExceeded':
      'This goal already has the maximum number of plan items. Delete one to add another.',

    'recurring.notFound': 'This template no longer exists. Refresh and try again.',
    'recurring.accountUnavailable': 'That account is unavailable. Pick another one.',
    'recurring.startAfterEnd': 'The start date must be on or before the end date.',
    'recurring.startTooEarly':
      "This template has already created charges, so it can't start any earlier than " +
      'that. To record earlier history, create a new template or add those ' +
      'transactions yourself.',

    'limit.categoryNotExpense': 'Budgets are only for expense categories.',
    'limit.categoryArchived': "This category is archived, so it can't take a new budget.",
    'limit.alreadyGone': 'This budget is already gone.',

    'token.alreadyRevoked': 'This token is already revoked. The list has been refreshed.',

    'receipt.rateLimited': "You've hit the limit for now. Wait a minute and try again.",
    'receipt.notFound': 'This receipt is no longer available. Pick a photo again.',
    'receipt.notUploaded': "The photo didn't finish uploading. Try again.",
    'receipt.processing': 'This receipt is already being read.',
    'receipt.alreadyParsed': 'This receipt has already been read.',
    'receipt.imageTooLarge': 'That image is too large. Pick a smaller photo.',
    'receipt.storageUnavailable':
      'Photo storage is unavailable right now. Try again in a moment.',
    'receipt.aiNotConfigured':
      'AI reading is unavailable: no AI key is configured on the server. ' +
      'The photo is saved — add the transaction manually and it stays attached.',
    'receipt.notAReceipt':
      "That photo doesn't look like a receipt. You can add the transaction manually.",
    'receipt.unreadable': "Couldn't read the receipt. Try a clearer, well-lit photo.",
    'receipt.invalidOutput':
      "Couldn't make sense of this one. Try again, or add the transaction manually.",
    'receipt.anthropicError': 'Reading the receipt failed. Try again in a moment.',
    'receipt.downloadFailed':
      'Something went wrong reading the uploaded photo. Try again.',

    'statement.accountNotFound':
      'That account no longer exists, so there is nothing to import into. ' +
      'Refresh and pick another one.',
    'statement.accountArchived':
      "This account is archived, so nothing can be imported into it. Unarchive it " +
      'or pick another account.',
    'statement.tooLarge':
      'That file is too large (the limit is 1 MB). Export a shorter period and ' +
      'upload it again.',
    'statement.parseFailed':
      'This file does not read as a statement of the bank you picked. Check that ' +
      'the bank is right, download the statement again in CSV, and upload that file.',
    'statement.formatUnknown':
      'That statement format is not supported. Pick one of the banks the list ' +
      'offers.',
    // The specific sentence NAMES both currencies; it needs interpolation, so it
    // lives in the web dictionary. This is what is shown when the server did not
    // send them.
    'statement.currencyMismatch':
      "The statement's currency is not this account's. Pick the account this " +
      'statement belongs to.',
    'statement.rateLimited':
      "You've uploaded a lot of statements just now. Wait a minute and try again.",
    'statement.importNotFound':
      'This import no longer exists. It may have been cancelled, or replaced by a ' +
      'newer upload for the same account.',
    'statement.importFinished':
      'This import has already been carried out, so it cannot be changed. Upload ' +
      'the statement again to import more.',
    'statement.decisionNeedsMatch':
      'There is no record of yours to replace on this line. Import it as a new ' +
      'operation, or skip it.',
    'statement.transferReplaceForbidden':
      'That record of yours is a transfer between two accounts, so it cannot be ' +
      'replaced from one statement. Skip this line, or delete the transfer yourself.',
    'statement.replaceFromOutOfRange':
      'Pick a date inside the statement period: outside it the statement has ' +
      'nothing to put back in place of what would be deleted.',
    // Again the specific sentence names both numbers and lives in the web
    // dictionary; this is the fallback when the server did not send them.
    'statement.replaceConfirmationMismatch':
      'Your data changed while you were confirming, so nothing was deleted. Check ' +
      'the new figures and confirm again.',

    'advisor.aiNotConfigured': 'AI is unavailable — no key is configured',
    'advisor.rateLimited': 'Too many requests. Wait a moment and try again.',
    'advisor.anthropicError': 'The answer broke off on the AI side. Try asking again.',
    'advisor.streamIncomplete': 'The connection dropped — the answer may be incomplete.',
  },
  ru: {
    network: 'Не удалось связаться с сервером. Проверьте соединение и попробуйте снова.',
    generic: 'Что-то пошло не так. Попробуйте ещё раз.',

    'category.systemReadonly': 'Системные категории нельзя изменять.',
    'category.notFound': 'Такой категории больше нет. Обновите страницу и попробуйте снова.',
    'category.nameConflict': 'Категория с таким названием уже есть в этом типе.',
    categoryUnavailable: 'Эта категория недоступна. Выберите другую.',

    'account.notFound': 'Этого счёта больше нет. Обновите страницу и попробуйте снова.',
    'account.archived': 'Счёт в архиве. Верните его из архива или выберите другой.',
    'account.currencyImmutable':
      'Валюту счёта изменить нельзя. Заархивируйте этот счёт и создайте новый ' +
      'в нужной валюте.',

    'deposit.notFound': 'Этого вклада больше нет. Обновите страницу и попробуйте снова.',
    'deposit.archived': 'Вклад закрыт, менять его условия нельзя. Сначала верните его из архива.',
    'deposit.unarchiveOnly':
      'Разархивация и правка — два разных действия. Сначала верните вклад из архива, ' +
      'потом меняйте условия.',
    'deposit.termBeforeOpening': 'Срок должен заканчиваться позже даты открытия.',

    'transaction.notFound': 'Этой операции больше нет. Обновите страницу и попробуйте снова.',
    'transaction.accountUnavailable':
      'Этот счёт больше недоступен. Обновите страницу и выберите другой.',
    'transaction.accountArchived':
      'Счёт в архиве — новые операции по нему записать нельзя. ' +
      'Выберите другой счёт и сохраните ещё раз.',
    'transaction.currencyMismatch':
      'Сумма не совпадает с валютой счёта. Откройте форму заново и попробуйте снова.',
    'transaction.sameAccountTransfer': 'Выберите другой счёт для перевода.',
    'transaction.receiptUnavailable':
      'Этот чек больше недоступен, прикрепить его нельзя. ' +
      'Закройте окно и добавьте операцию вручную.',
    'transaction.depositTransferOnly':
      'По вкладу возможны только переводы. Переведите деньги переводом со страницы вкладов.',

    'goal.notFound': 'Этой цели больше нет. Обновите страницу и попробуйте снова.',

    'goal.archived': 'Цель в архиве — менять её план нельзя. Сначала верните её из архива.',
    'goalItem.notFound': 'Этого пункта плана больше нет. Обновите страницу и попробуйте снова.',
    'goalItem.parentNotFound':
      'Такого родительского пункта в плане больше нет. Обновите страницу и выберите другой.',
    'goalItem.cycle': 'Пункт нельзя перенести внутрь самого себя. Выберите другого родителя.',
    'goalItem.depthExceeded':
      'В плане не больше шести уровней. Перенесите пункт на уровень выше.',
    'goalItem.limitExceeded':
      'В этой цели уже максимальное число пунктов. Удалите один, чтобы добавить новый.',
    'contribution.exceedsSaved': 'Это больше, чем накоплено по этой цели.',
    'contribution.notFound':
      'Этого пополнения больше нет. Обновите страницу и попробуйте снова.',

    'recurring.notFound': 'Этого шаблона больше нет. Обновите страницу и попробуйте снова.',
    'recurring.accountUnavailable': 'Этот счёт недоступен. Выберите другой.',
    'recurring.startAfterEnd': 'Дата начала должна быть не позже даты окончания.',
    'recurring.startTooEarly':
      'По этому шаблону уже прошли списания, поэтому начать раньше нельзя. Чтобы ' +
      'записать более раннюю историю, создайте новый шаблон или добавьте эти ' +
      'операции вручную.',

    'limit.categoryNotExpense': 'Бюджеты доступны только для категорий расходов.',
    'limit.categoryArchived': 'Категория в архиве — задать для неё бюджет нельзя.',
    'limit.alreadyGone': 'Этого бюджета уже нет.',

    'token.alreadyRevoked': 'Этот токен уже отозван. Список обновлён.',

    'receipt.rateLimited': 'Пока достигнут лимит. Подождите минуту и попробуйте снова.',
    'receipt.notFound': 'Этот чек больше недоступен. Выберите фото заново.',
    'receipt.notUploaded': 'Фото не догрузилось. Попробуйте снова.',
    'receipt.processing': 'Этот чек уже распознаётся.',
    'receipt.alreadyParsed': 'Этот чек уже распознан.',
    'receipt.imageTooLarge': 'Изображение слишком большое. Выберите файл поменьше.',
    'receipt.storageUnavailable':
      'Хранилище фото сейчас недоступно. Попробуйте чуть позже.',
    'receipt.aiNotConfigured':
      'Распознавание недоступно: на сервере не настроен AI-ключ. ' +
      'Фото сохранено — добавьте операцию вручную, и оно останется прикреплённым.',
    'receipt.notAReceipt': 'Это фото не похоже на чек. Операцию можно добавить вручную.',
    'receipt.unreadable':
      'Не удалось прочитать чек. Попробуйте более чёткое фото при хорошем свете.',
    'receipt.invalidOutput':
      'Не удалось разобрать этот чек. Попробуйте снова или добавьте операцию вручную.',
    'receipt.anthropicError': 'Распознавание чека не удалось. Попробуйте чуть позже.',
    'receipt.downloadFailed': 'Не удалось прочитать загруженное фото. Попробуйте снова.',

    'statement.accountNotFound':
      'Этого счёта больше нет — импортировать некуда. Обновите страницу и выберите другой.',
    'statement.accountArchived':
      'Счёт в архиве — импортировать в него нельзя. Верните счёт из архива или ' +
      'выберите другой.',
    'statement.tooLarge':
      'Файл слишком большой (предел — 1 МБ). Выгрузите выписку за меньший период ' +
      'и загрузите её.',
    'statement.parseFailed':
      'Файл не читается как выписка выбранного банка. Проверьте, тот ли банк ' +
      'выбран, выгрузите выписку из банка ещё раз в формате CSV и загрузите её.',
    'statement.formatUnknown':
      'Этот формат выписки не поддерживается. Выберите банк из списка.',
    'statement.currencyMismatch':
      'Валюта выписки не совпадает с валютой счёта. Выберите тот счёт, к которому ' +
      'относится выписка.',
    'statement.rateLimited':
      'Слишком много загрузок подряд. Подождите минуту и попробуйте снова.',
    'statement.importNotFound':
      'Этого импорта больше нет: его отменили или вытеснила новая загрузка по тому ' +
      'же счёту.',
    'statement.importFinished':
      'Этот импорт уже выполнен, менять его нельзя. Чтобы импортировать ещё, ' +
      'загрузите выписку заново.',
    'statement.decisionNeedsMatch':
      'По этой строке нечего заменять — вашей записи для неё нет. Импортируйте её ' +
      'как новую операцию или пропустите.',
    'statement.transferReplaceForbidden':
      'Ваша запись — перевод между двумя счетами, заменить его по выписке одного ' +
      'счёта нельзя. Пропустите строку или удалите перевод вручную.',
    'statement.replaceFromOutOfRange':
      'Выберите дату внутри периода выписки: за его пределами выписке нечем ' +
      'заменить удалённое.',
    'statement.replaceConfirmationMismatch':
      'Пока вы подтверждали, данные изменились — ничего не удалено. Посмотрите ' +
      'новые числа и подтвердите ещё раз.',

    // BINDING copy (4.4 task.md): with language=ru this string is byte-exact.
    'advisor.aiNotConfigured': 'AI недоступен — ключ не настроен',
    'advisor.rateLimited': 'Слишком много запросов. Подождите и попробуйте снова.',
    'advisor.anthropicError': 'Ответ оборвался на стороне AI. Попробуйте спросить ещё раз.',
    'advisor.streamIncomplete': 'Соединение прервалось — ответ может быть неполным.',
  },
};

/** The sentence to show for `key` in `lang`. Total: every key exists in both. */
export function errorMessage(key: ErrorMessageKey, lang: Lang): string {
  return ERROR_MESSAGES[lang][key];
}
