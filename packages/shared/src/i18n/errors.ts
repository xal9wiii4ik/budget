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
  // transactions & transfers
  | 'transaction.notFound'
  | 'transaction.accountUnavailable'
  | 'transaction.accountArchived'
  | 'transaction.currencyMismatch'
  | 'transaction.sameAccountTransfer'
  | 'transaction.receiptUnavailable'
  // goals
  | 'goal.notFound'
  | 'contribution.exceedsSaved'
  | 'contribution.notFound'
  // recurring templates
  | 'recurring.notFound'
  | 'recurring.accountUnavailable'
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

    'transaction.notFound': 'This transaction no longer exists. Refresh and try again.',
    'transaction.accountUnavailable':
      'That account is no longer available. Refresh and pick another one.',
    'transaction.accountArchived':
      'That account is archived, so nothing new can be recorded on it.',
    'transaction.currencyMismatch':
      "This amount doesn't match the account's currency. Reopen the form and try again.",
    'transaction.sameAccountTransfer': 'Pick a different account to transfer to.',
    'transaction.receiptUnavailable':
      'This receipt is no longer available, so it can’t be attached. ' +
      'Close this and add the transaction manually.',

    'goal.notFound': 'This goal no longer exists. Refresh and try again.',
    'contribution.exceedsSaved': "That's more than this goal has saved.",
    'contribution.notFound': 'This contribution no longer exists. Refresh and try again.',

    'recurring.notFound': 'This template no longer exists. Refresh and try again.',
    'recurring.accountUnavailable': 'That account is unavailable. Pick another one.',

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

    'transaction.notFound': 'Этой операции больше нет. Обновите страницу и попробуйте снова.',
    'transaction.accountUnavailable':
      'Этот счёт больше недоступен. Обновите страницу и выберите другой.',
    'transaction.accountArchived':
      'Счёт в архиве — новые операции по нему записать нельзя.',
    'transaction.currencyMismatch':
      'Сумма не совпадает с валютой счёта. Откройте форму заново и попробуйте снова.',
    'transaction.sameAccountTransfer': 'Выберите другой счёт для перевода.',
    'transaction.receiptUnavailable':
      'Этот чек больше недоступен, прикрепить его нельзя. ' +
      'Закройте окно и добавьте операцию вручную.',

    'goal.notFound': 'Этой цели больше нет. Обновите страницу и попробуйте снова.',
    'contribution.exceedsSaved': 'Это больше, чем накоплено по этой цели.',
    'contribution.notFound':
      'Этого пополнения больше нет. Обновите страницу и попробуйте снова.',

    'recurring.notFound': 'Этого шаблона больше нет. Обновите страницу и попробуйте снова.',
    'recurring.accountUnavailable': 'Этот счёт недоступен. Выберите другой.',

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
