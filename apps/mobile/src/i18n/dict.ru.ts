// The RUSSIAN dictionary. `Dictionary` is a mapped type over dict.en.ts, so this
// object MUST cover every key with the matching shape — a missing key or a plural
// entry written as a bare string is a typecheck failure, not a runtime surprise.
//
// Wording is taken from apps/web/src/i18n/dict.ru.ts wherever the same sentence
// exists there, so a user who moves between the phone and the browser reads the
// same words for the same thing.
//
// NOT translated here: the user's own text (account, category and transaction
// names, notes) and anything the server wrote — `transfer_rate` above all.
import type { Dictionary } from './t';

export const ru: Dictionary = {
  // --- общий словарь ---------------------------------------------------------
  'common.save': 'Сохранить',
  'common.cancel': 'Отмена',
  'common.delete': 'Удалить',
  'common.archive': 'В архив',
  'common.unarchive': 'Вернуть из архива',
  'common.retry': 'Повторить',
  'common.done': 'Готово',
  'common.loading': 'Загрузка…',
  'common.goBack': 'Назад',
  'common.name': 'Название',
  'common.type': 'Тип',
  'common.currency': 'Валюта',
  'common.amount': 'Сумма',
  'common.date': 'Дата',
  'common.noteOptional': 'Заметка (необязательно)',
  'common.expense': 'Расход',
  'common.income': 'Доход',
  'common.net': 'Итог',
  'common.uncategorized': 'Без категории',
  'common.optional': '(необязательно)',
  'common.notSet': 'Не указана',
  'common.remove': 'Убрать',
  'common.tryAgain': 'Попробовать ещё раз',
  'common.unknownCategory': 'Неизвестная категория',
  'common.archivedTag': 'В архиве',
  'common.archivedParens': '(в архиве)',

  // --- нижние вкладки --------------------------------------------------------
  'tabs.transactions': 'Операции',
  'tabs.categories': 'Категории',
  'tabs.accounts': 'Счета',

  // --- оболочка приложения ---------------------------------------------------
  'shell.logout': 'Выйти',
  'shell.retryAccount': 'Повторить',

  // --- вход и регистрация ----------------------------------------------------
  'auth.email': 'Почта',
  'auth.password': 'Пароль',
  'auth.signIn': 'Войти',
  'auth.signInSubtitle': 'С возвращением в Budget.',
  'auth.noAccount': 'Нет аккаунта?',
  'auth.createOne': 'Создать',
  'auth.sessionExpired': 'Сессия истекла — войдите ещё раз.',
  'auth.accountCreated': 'Аккаунт создан — войдите.',
  'auth.createAccount': 'Создать аккаунт',
  'auth.createSubtitle': 'Начните вести бюджет.',
  'auth.haveAccount': 'Уже есть аккаунт?',
  'auth.passwordHint': 'Не короче 8 символов.',

  'authError.network': 'Не удалось связаться с сервером. Проверьте связь и попробуйте снова.',
  'authError.badCredentials': 'Неверная почта или пароль.',
  'authError.emailExists': 'Аккаунт с такой почтой уже существует.',
  'authError.invalidPassword': 'Пароль должен быть не короче 8 символов.',
  'authError.rateLimited': 'Слишком много попыток. Подождите минуту и попробуйте снова.',
  'authError.invalidEmail': 'Введите корректный адрес почты.',
  'authError.generic': 'Что-то пошло не так. Попробуйте ещё раз.',

  // --- вкладка «Счета» -------------------------------------------------------
  // one/few/many — счёт / счёта / счетов; `other` достаётся дробным (1,5 счёта).
  accountCount: {
    one: '{count} счёт',
    few: '{count} счёта',
    many: '{count} счетов',
    other: '{count} счёта',
  },
  'accounts.add': 'Добавить счёт',
  'accounts.loadFailed': 'Не удалось загрузить счета.',
  'accounts.empty': 'Добавьте первый счёт — каждая операция записывается на счёт.',
  'accounts.group': 'Счета',
  'accounts.archivedGroup': 'В архиве',
  'accounts.typeCard': 'Карта',
  'accounts.typeCash': 'Наличные',
  'accounts.all': 'Все счета',
  'accounts.noneToRecordOn':
    'Записывать операцию некуда — сначала добавьте счёт на вкладке «Счета».',

  // --- форма счёта -----------------------------------------------------------
  'accountForm.newTitle': 'Новый счёт',
  'accountForm.editTitle': 'Изменить счёт',
  'accountForm.unavailable': 'Этот счёт недоступен.',
  'accountForm.archiveTitle': 'Убрать счёт в архив',
  'accountForm.unarchiveTitle': 'Вернуть счёт из архива',
  'accountForm.archiveMessage':
    'Убрать «{name}» в архив? Прошлые операции останутся как есть — счёт просто ' +
    'перестанет предлагаться для новых.',
  'accountForm.unarchiveMessage': 'Вернуть «{name}», чтобы им снова можно было пользоваться?',
  'accountForm.currencyImmutableHint':
    'Валюту счёта поменять нельзя. Чтобы перейти на другую, уберите этот счёт в ' +
    'архив и создайте новый.',
  'accountForm.startingBalance': 'Начальный остаток ({currency})',
  'accountForm.startingBalanceHint':
    'Сколько на счёте прямо сейчас. Для карты с долгом поставьте минус; оставьте ' +
    'пустым, если ноль.',

  // --- вкладка «Категории» ---------------------------------------------------
  categoryCount: {
    one: '{count} категория',
    few: '{count} категории',
    many: '{count} категорий',
    other: '{count} категории',
  },
  'categories.add': 'Добавить категорию',
  'categories.loadFailed': 'Не удалось загрузить категории.',
  'categories.empty': 'Категорий пока нет.',
  'categories.systemTag': 'Системная',

  // --- форма категории -------------------------------------------------------
  'categoryForm.newTitle': 'Новая категория',
  'categoryForm.editTitle': 'Изменить категорию',
  'categoryForm.unavailable': 'Эта категория недоступна.',
  'categoryForm.archiveTitle': 'Убрать категорию в архив',
  'categoryForm.unarchiveTitle': 'Вернуть категорию из архива',
  'categoryForm.archiveMessage':
    'Убрать «{name}» в архив? Она останется на прошлых операциях, но для новых ' +
    'её будет не выбрать.',
  'categoryForm.unarchiveMessage': 'Вернуть «{name}», чтобы ею снова можно было пользоваться?',
  'categoryForm.iconOptional': 'Значок (необязательно)',
  'categoryForm.colorOptional': 'Цвет (необязательно, например #3366FF)',

  // --- вкладка «Операции» ----------------------------------------------------
  'tx.add': 'Добавить операцию',
  'tx.addTransfer': 'Добавить перевод',
  'tx.previousMonth': 'Предыдущий месяц',
  'tx.nextMonth': 'Следующий месяц',
  'tx.loadFailed': 'Не удалось загрузить операции.',
  'tx.emptyMonth': 'Операций за {month} нет',
  'tx.emptyMonthCta': 'Добавьте первую.',
  'tx.showing': 'Показано {shown} из {total}',
  // Без слова «счёт» перед {account}: подстановка на месте имени может быть
  // запасным «один счёт» (имя ещё не загружено), и «счёт один счёт» — мусор.
  'tx.filterNotice': 'Показан только {account} — итоги выше по всем счетам.',
  'tx.filterOneAccount': 'один счёт',
  'tx.transfer': 'Перевод',
  'tx.transferRoute': 'Перевод: {route}',

  // --- сводка за месяц -------------------------------------------------------
  'summary.loadFailed': 'Не удалось загрузить сводку за месяц.',
  'summary.noSpend': 'В этом месяце трат пока нет.',

  // --- форма операции --------------------------------------------------------
  'txForm.newTitle': 'Новая операция',
  'txForm.editTitle': 'Изменить операцию',
  'txForm.unavailable': 'Эта операция недоступна.',
  'txForm.accountExpense': 'С какого счёта списано',
  'txForm.accountIncome': 'Куда пришло',
  'txForm.amountLabel': 'Сумма, {currency}',
  'txForm.amountLabelIncome': 'Получено, {currency}',
  'txForm.spentLabel': 'Потрачено, {currency}',
  'txForm.receivedLabel': 'Получено, {currency}',
  'txForm.spendCurrencyLabel': 'Валюта траты',
  'txForm.spendCurrencyLabelIncome': 'Валюта поступления',
  'txForm.spendCurrencyHint':
    'Потратили в другой валюте? Выберите её здесь — подойдёт любой код из трёх букв.',
  'txForm.spendCurrencyHintIncome':
    'Пришло в другой валюте? Выберите её здесь — подойдёт любой код из трёх букв.',
  'txForm.spendCurrencyOther': 'Другая…',
  'txForm.spendCurrencyOtherLabel': 'Код валюты, 3 буквы',
  'txForm.chargedLabel': 'Списано со счёта, {currency}',
  'txForm.creditedLabel': 'Зачислено на счёт, {currency}',
  'txForm.chargeNoRateAhead':
    'Мы храним курсы по шести валютным парам, и на эту дату курса для ' +
    '{from} → {to} нет. Просто впишите, сколько банк на самом деле списал со счёта.',
  'txForm.chargeNoRateAheadIncome':
    'Мы храним курсы по шести валютным парам, и на эту дату курса для ' +
    '{from} → {to} нет. Просто впишите, сколько на самом деле пришло на счёт.',
  'txForm.chargeManual':
    'Курса {from} → {to} на эту дату у нас нет, поэтому эту сумму заполняете вы — ' +
    'впишите, сколько банк списал на самом деле.',
  'txForm.chargeManualIncome':
    'Курса {from} → {to} на эту дату у нас нет, поэтому эту сумму заполняете вы — ' +
    'впишите, сколько на самом деле пришло на счёт.',
  'txForm.chargeRecalcDated':
    'Оставьте как есть — сумма пересчитается по курсу на {date}.',
  'txForm.chargeRecalc': 'Оставьте как есть — сумма пересчитается при сохранении.',
  'txForm.chargeFetchFailed':
    'Сейчас не удалось получить курс. Сумму в {currency} можно ввести самим.',
  'txForm.chargeEstimate':
    '≈ {amount} по курсу {rate} — точная сумма считается при сохранении.',
  'txForm.chargeDefault':
    'Оставьте пустым — возьмём курс дня. Заполните, если банк списал другую сумму.',
  'txForm.chargeDefaultIncome':
    'Оставьте пустым — возьмём курс дня. Заполните, если на счёт пришла другая сумма.',
  'txForm.converting': 'Считаем…',
  'txForm.manualChargeRequired': 'Впишите сумму, которую списали со счёта, в {currency}.',
  'txForm.manualChargeRequiredIncome':
    'Впишите сумму, которая на самом деле пришла на счёт, в {currency}.',
  'txForm.pairCurrencyMatchesAccount':
    'Этот счёт уже в этой валюте. Верните валюту траты к валюте счёта, чтобы ' +
    'осталась одна сумма.',
  'txForm.pairFieldsRequired': 'Укажите и сумму траты, и валюту, в которой потратили.',
  'txForm.chargeRequired': 'Впишите сумму, которую списали со счёта.',
  'txForm.merchantLabel': 'Название / место',
  'txForm.merchantLabelIncome': 'Источник (кто заплатил)',
  'txForm.merchantHintIncome': 'Кто заплатил — работодатель, клиент, площадка.',
  'txForm.moreOptions': 'Ещё',
  'txForm.country': 'Страна',
  'txForm.countryFilter': 'Начните вводить страну',
  'txForm.countryMore': 'Показаны не все страны — начните вводить название.',
  'txForm.category': 'Категория',
  'txForm.deleteTitle': 'Удалить операцию',
  'txForm.deleteMessage': 'Удалить эту операцию? Отменить это будет нельзя.',
  'txForm.isTransfer': 'Это перевод между счетами — он изменяется на своём экране.',
  'txForm.openTransfer': 'Открыть перевод',

  // --- фото у операции -------------------------------------------------------
  'photo.label': 'Фото',
  'photo.alt': 'Прикреплённое вами фото',
  'photo.attached': 'Фото прикреплено',
  'photo.stays': 'Оно остаётся с этой операцией. Здесь его можно только отвязать.',
  'photo.detailsFailed':
    'Не удалось загрузить сведения об этом фото, но оно по-прежнему связано с операцией.',
  'photo.unavailable':
    'Фото прикреплено; показать его здесь можно после того, как его распознают в веб-версии.',
  'photo.removeTitle': 'Убрать фото?',
  'photo.removeQuestion': 'Убрать его из этой операции?',
  'photo.gettingReady': 'Готовимся к загрузке…',
  'photo.uploading': 'Загружаем…',
  'photo.replace': 'Заменить фото',
  'photo.takePhoto': 'Сделать фото',
  'photo.choosePhoto': 'Выбрать фото',
  'photo.uploadFailed': 'Фото не загрузилось.',
  'photo.tooLarge':
    'Это фото больше 5 МБ. Сделайте новое или выберите файл поменьше.',
  'photo.cameraDenied':
    'У «Budget» нет доступа к камере. Его можно включить в настройках.',
  'photo.libraryDenied':
    'У «Budget» нет доступа к вашим фото. Его можно включить в настройках.',
  'photo.openSettings': 'Открыть настройки',

  // --- форма перевода --------------------------------------------------------
  'transfer.newTitle': 'Новый перевод',
  'transfer.editTitle': 'Изменить перевод',
  'transfer.unavailable': 'Этот перевод недоступен.',
  'transfer.deleteTitle': 'Удалить перевод',
  'transfer.deleteMessage':
    'Удалить этот перевод? Уйдут обе его стороны, и остатки обоих счетов вернутся назад.',
  'transfer.needTwoAccounts':
    'Перевод переносит деньги между двумя счетами — сначала создайте второй счёт ' +
    'на вкладке «Счета».',
  'transfer.from': 'Откуда',
  'transfer.to': 'Куда',
  'transfer.amountSent': 'Сумма отправления',
  'transfer.amountSentIn': 'Сумма отправления ({currency})',
  'transfer.amountReceived': 'Сумма зачисления',
  'transfer.amountReceivedIn': 'Сумма зачисления ({currency})',
  'transfer.receivedHint':
    'Сколько на самом деле пришло на другой счёт — по реальному курсу банка, с комиссиями.',
  'transfer.rateAtTime': 'Курс на тот момент: {rate} {counterCurrency} за 1 {currency}',
};
