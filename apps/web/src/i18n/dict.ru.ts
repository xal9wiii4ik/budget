// The RUSSIAN dictionary. `Dictionary` is a mapped type over dict.en.ts, so this
// object MUST cover every key with the matching shape — a missing key or a plural
// entry written as a bare string is a typecheck failure, not a runtime surprise.
//
// Two things are deliberately NOT translated here: the user's own text (category,
// account, goal and template names, merchants, notes) and anything the server
// wrote (advisor answers, `transfer_rate`, parsed receipt items). System category
// names live in @budget/shared, keyed by their frozen UUIDs.
import type { Dictionary } from './t';

export const ru: Dictionary = {
  // --- общий словарь --------------------------------------------------------
  'common.save': 'Сохранить',
  'common.saving': 'Сохраняем…',
  'common.cancel': 'Отмена',
  'common.delete': 'Удалить',
  'common.deleting': 'Удаляем…',
  'common.remove': 'Убрать',
  'common.removing': 'Убираем…',
  'common.edit': 'Изменить',
  'common.archive': 'В архив',
  'common.archiving': 'Убираем в архив…',
  'common.unarchive': 'Вернуть из архива',
  'common.unarchiving': 'Возвращаем…',
  'common.retry': 'Повторить',
  'common.tryAgain': 'Попробовать ещё раз',
  'common.loading': 'Загрузка…',
  'common.loadMore': 'Показать ещё',
  'common.close': 'Закрыть',
  'common.working': 'Выполняем…',
  'common.optional': '(необязательно)',
  'common.archivedParens': '(в архиве)',
  'common.archivedTag': 'В архиве',
  'common.date': 'Дата',
  'common.note': 'Заметка',
  'common.name': 'Название',
  'common.type': 'Тип',
  'common.currency': 'Валюта',
  'common.amount': 'Сумма',
  'common.expense': 'Расход',
  'common.income': 'Доход',
  'common.net': 'Итог',
  'common.uncategorized': 'Без категории',
  'common.unknownCategory': 'Неизвестная категория',
  'common.notSet': 'Не указана',

  // --- общая модалка --------------------------------------------------------
  'modal.discardMessage': 'Отменить изменения? Всё, что вы здесь ввели, будет потеряно.',
  'modal.keepEditing': 'Продолжить ввод',
  'modal.discardConfirm': 'Отменить изменения',

  // --- ожидание базовой валюты ---------------------------------------------
  'form.baseCurrencyLoadFailed':
    'Не удалось загрузить валюту счёта. Закройте это окно и попробуйте ещё раз.',
  'form.baseCurrencyLoading': 'Загружаем валюту счёта…',

  // --- каркас приложения ----------------------------------------------------
  'nav.primary': 'Основное меню',
  'nav.transactions': 'Операции',
  'nav.stats': 'Статистика',
  'nav.advisor': 'AI',
  'nav.accounts': 'Счета',
  'nav.categories': 'Категории',
  'nav.recurring': 'Регулярные',
  'nav.goals': 'Цели',
  'nav.settings': 'Настройки',
  'shell.meLoadFailed': 'Не удалось загрузить данные аккаунта.',
  'shell.logout': 'Выйти',
  'shell.loggingOut': 'Выходим…',

  'notFound.title': 'Страница не найдена',
  'notFound.body': 'Такой страницы нет.',
  'notFound.back': 'На главную',

  // --- вход и регистрация ---------------------------------------------------
  'auth.email': 'Электронная почта',
  'auth.password': 'Пароль',
  'auth.signIn': 'Войти',
  'auth.signingIn': 'Входим…',
  'auth.signInSubtitle': 'С возвращением в Budget.',
  'auth.noAccount': 'Ещё нет аккаунта?',
  'auth.createOne': 'Создать',
  'auth.sessionExpired': 'Сессия истекла — войдите ещё раз.',
  'auth.accountCreated': 'Аккаунт создан — войдите.',
  'auth.createAccount': 'Создать аккаунт',
  'auth.creatingAccount': 'Создаём аккаунт…',
  'auth.createSubtitle': 'Начните вести свой бюджет.',
  'auth.haveAccount': 'Уже есть аккаунт?',
  'auth.passwordHint': 'Не короче 8 символов.',
  'authError.network':
    'Не получается связаться с сервером. Проверьте соединение и попробуйте ещё раз.',
  'authError.badCredentials': 'Неверная почта или пароль.',
  'authError.emailExists': 'Аккаунт с такой почтой уже существует.',
  'authError.invalidPassword': 'Пароль должен быть не короче 8 символов.',
  'authError.rateLimited': 'Слишком много попыток. Подождите минуту и попробуйте снова.',
  'authError.invalidEmail': 'Введите корректный адрес почты.',
  'authError.generic': 'Что-то пошло не так. Попробуйте ещё раз.',

  // --- счета ----------------------------------------------------------------
  'accounts.title': 'Счета',
  'accounts.add': 'Добавить счёт',
  'accounts.loadFailed': 'Не удалось загрузить счета.',
  'accounts.empty': 'Добавьте первый счёт — каждая операция записывается на счёт.',
  'accounts.archivedGroup': 'В архиве',
  'accounts.typeCard': 'Карта',
  'accounts.typeCash': 'Наличные',
  'accounts.choose': 'Выберите счёт…',
  'accounts.required': 'Сначала создайте счёт — каждая операция записывается на счёт.',
  'accounts.goToAccounts': 'Перейти к счетам',
  'accounts.filterLabel': 'Фильтр по счёту',
  'accounts.all': 'Все счета',
  'accounts.unavailable': 'Недоступный счёт',
  'accountForm.newTitle': 'Новый счёт',
  'accountForm.editTitle': 'Изменить счёт',
  'accountForm.archiveTitle': 'Убрать счёт в архив',
  'accountForm.unarchiveTitle': 'Вернуть счёт из архива',
  'accountForm.archiveMessage':
    'Убрать «{name}» в архив? Прошлые операции останутся как есть — счёт просто ' +
    'перестанет предлагаться для новых.',
  'accountForm.unarchiveMessage': 'Вернуть «{name}», чтобы им снова можно было пользоваться?',
  'accountForm.currencyImmutableHint':
    'Валюту счёта поменять нельзя. Чтобы перейти на другую, уберите этот счёт в ' +
    'архив и создайте новый.',
  'accountForm.currencyCreateHint':
    'Всё, что записано на этот счёт, будет в этой валюте, и позже её уже не поменять.',
  'accountForm.startingBalance': 'Начальный остаток',
  'accountForm.startingBalanceHint':
    'Сколько было на счёте до начала учёта, в {currency}. Оставьте пустым, если ноль; ' +
    'карта с долгом начинается с минуса (например, -250).',

  // --- операции: список, панель, сводка -------------------------------------
  'tx.title': 'Операции',
  'tx.add': 'Добавить операцию',
  'tx.addTransfer': 'Добавить перевод',
  'tx.addByPhoto': 'Добавить по фото',
  'tx.export': 'Выгрузить CSV',
  'tx.exporting': 'Выгружаем…',
  'tx.exportDone': 'Скачан файл {file}.',
  'tx.exportDoneEmpty':
    'Скачан файл {file} — под фильтр ничего не попало, поэтому в нём только заголовки.',
  'tx.filterChip': 'Показан только счёт «{account}» — итоги выше учитывают все счета.',
  'tx.filterOneAccount': 'один счёт',
  'tx.showAllAccounts': 'Показать все счета',
  'tx.loadFailed': 'Не удалось загрузить операции.',
  'tx.emptyMonth': 'Операций за {month} нет',
  'tx.emptyMonthCta': 'Добавьте первую.',
  'tx.emptyAccountMonth': 'На этом счёте операций за {month} нет',
  'tx.showing': 'Показано {shown} из {total}',
  'tx.recurringChip': 'Регулярная',
  'tx.transfer': 'Перевод',
  'tx.transferRoute': 'Перевод: {route}',
  'monthPicker.previous': 'Предыдущий месяц',
  'monthPicker.next': 'Следующий месяц',
  'summary.loadFailed': 'Не удалось загрузить сводку за месяц.',
  'summary.noSpend': 'В этом месяце трат пока нет.',

  'unconverted.totals': {
    one: 'Для {count} операции нет курса, она не вошла в эти итоги.',
    few: 'Для {count} операций нет курса, они не вошли в эти итоги.',
    many: 'Для {count} операций нет курса, они не вошли в эти итоги.',
    other: 'Для {count} операции нет курса, она не вошла в эти итоги.',
  },
  'unconverted.spentAmounts': {
    one: 'Для {count} операции нет курса, она не вошла в эти суммы трат.',
    few: 'Для {count} операций нет курса, они не вошли в эти суммы трат.',
    many: 'Для {count} операций нет курса, они не вошли в эти суммы трат.',
    other: 'Для {count} операции нет курса, она не вошла в эти суммы трат.',
  },
  'unconverted.merchantTotals': {
    one: 'Для {count} операции нет курса, она не вошла в эти суммы по местам.',
    few: 'Для {count} операций нет курса, они не вошли в эти суммы по местам.',
    many: 'Для {count} операций нет курса, они не вошли в эти суммы по местам.',
    other: 'Для {count} операции нет курса, она не вошла в эти суммы по местам.',
  },
  'unconverted.month': {
    one: '{count} операция без курса не вошла в этот месяц.',
    few: '{count} операции без курса не вошли в этот месяц.',
    many: '{count} операций без курса не вошли в этот месяц.',
    other: '{count} операции без курса не вошли в этот месяц.',
  },

  transactionCount: {
    one: '{count} операция',
    few: '{count} операции',
    many: '{count} операций',
    // Дроби («1,5 операции») — категория, которой в английском просто нет.
    other: '{count} операции',
  },

  // --- форма операции -------------------------------------------------------
  'txForm.newTitle': 'Новая операция',
  'txForm.editTitle': 'Изменить операцию',
  'txForm.confirmTitle': 'Проверьте чек',
  'txForm.confirmLede':
    'Считано с вашего фото — проверьте и сохраните. Всё неверное можно поправить здесь.',
  'txForm.account': 'Счёт',
  'txForm.receiptCurrencyWarning':
    'Чек в {receiptCurrency}, а выбранный счёт — в {accountCurrency}. Операция ' +
    'сохранится в {accountCurrency}: проверьте сумму или выберите счёт в ' +
    '{receiptCurrency}.',
  'txForm.spentLabel': 'Потрачено, {currency}',
  'txForm.amountLabel': 'Сумма, {currency}',
  'txForm.spendCurrencyAria': 'Валюта траты',
  'txForm.spendCurrencyHint':
    'Потратили в другой валюте? Поменяйте код на тот, что указан на чеке.',
  'txForm.chargedLabel': 'Списано со счёта, {currency}',
  // FX_RATE_UNAVAILABLE, сказанное ДО сохранения. Это не ошибка и не вина
  // пользователя: курсы храним только по шести парам, для остальных пробел —
  // обычное дело, а выход простой — сумма из банка.
  'txForm.chargeNoRateAhead':
    'Мы храним курсы по шести валютным парам, и на эту дату курса для ' +
    '{from} → {to} нет. Просто впишите, сколько банк на самом деле списал со счёта.',
  'txForm.chargeManual':
    'Курса {from} → {to} на эту дату у нас нет, поэтому эту сумму заполняете вы — ' +
    'впишите, сколько банк списал на самом деле.',
  'txForm.chargeRecalcDated':
    'Оставьте как есть — сумма пересчитается по курсу на {date}.',
  'txForm.chargeRecalc': 'Оставьте как есть — сумма пересчитается при сохранении.',
  'txForm.chargeFetchFailed':
    'Сейчас не удалось получить курс. Сумму в {currency} можно ввести самим.',
  'txForm.chargeEstimate':
    '≈ {amount} по курсу {rate} — точная сумма считается при сохранении.',
  'txForm.chargeDefault':
    'Оставьте пустым — возьмём курс дня. Заполните, если банк списал другую сумму.',
  'txForm.converting': 'Считаем…',
  'txForm.convertedLegend': 'Сумма в {currency}',
  'txForm.resetToAuto': 'Считать автоматически',
  'txForm.convertedRecalcDated': 'Пересчитается по курсу на {date} при сохранении.',
  'txForm.convertedRecalc': 'Пересчитается при сохранении.',
  'txForm.convertedFetchFailed':
    'Сейчас не удалось получить курс. Сумму в {currency} можно ввести самим.',
  'txForm.convertedNoRate':
    'Курса {from}→{to} у нас нет. Сумму в {to} можно ввести самим.',
  'txForm.convertedRate': 'Курс {rate} на {date}',
  'txForm.convertedEstimate': '≈ Оценка — точная сумма считается при сохранении.',
  'txForm.convertedDefault': 'Оставьте пустым — сумму в {currency} посчитаем сами.',
  'txForm.category': 'Категория',
  'txForm.suggestedFromSimilar': 'Подсказано по похожему чеку',
  'txForm.suggestedFromReceipt': 'Подсказано по этому чеку',
  'txForm.merchantLabel': 'Название / место',
  'txForm.moreOptions': 'Ещё',
  'txForm.country': 'Страна',
  'txForm.deleteTitle': 'Удалить операцию',
  'txForm.deleteMessage': 'Удалить эту операцию? Отменить это будет нельзя.',
  'txForm.manualChargeRequired': 'Впишите сумму, которую списали со счёта, в {currency}.',
  'txForm.pairCurrencyMatchesAccount':
    'Этот счёт уже в этой валюте. Верните валюту траты к валюте счёта, чтобы ' +
    'осталась одна сумма.',
  'txForm.pairFieldsRequired': 'Укажите и сумму траты, и валюту, в которой потратили.',
  'txForm.chargeRequired': 'Впишите сумму, которую списали со счёта.',

  // --- фото у операции ------------------------------------------------------
  'photo.label': 'Фото',
  'photo.alt': 'Прикреплённое вами фото',
  'photo.attached': 'Фото прикреплено',
  'photo.alreadyScanned': ' · уже распознано',
  'photo.detailsFailed':
    'Не удалось загрузить сведения об этом фото, но оно по-прежнему связано с операцией.',
  'photo.stays': 'Оно остаётся с этой операцией. Здесь его можно только отвязать.',
  'photo.removeGroup': 'Убрать фото?',
  'photo.removeQuestion': 'Убрать его из этой операции?',
  'photo.keepIt': 'Оставить',
  'photo.preparing': 'Готовим фото…',
  'photo.gettingReady': 'Готовимся к загрузке…',
  'photo.uploading': 'Загружаем…',
  'photo.attach': 'Прикрепить фото',
  'photo.replace': 'Заменить фото',

  // --- чеки -----------------------------------------------------------------
  'receipt.captureTitle': 'Добавить по фото',
  'receipt.dropText':
    'Перетащите сюда фото чека — или скриншот уведомления из банка.',
  'receipt.choosePhoto': 'Выбрать фото',
  'receipt.shrinkHint': 'Фото уменьшается прямо на вашем устройстве перед отправкой.',
  'receipt.addManually': 'Ввести вручную',
  'receipt.uploadingPhoto': 'Загружаем фото…',
  'receipt.reading': 'Читаем чек…',
  'receipt.takesSeconds': 'Обычно это занимает несколько секунд.',
  'receipt.uploadedQuestion': 'Фото загружено. Что с ним сделать?',
  'receipt.scanWithAi': 'Распознать через AI',
  'receipt.scanHint': 'Считает с фото сумму, дату и место.',
  'receipt.saveWithoutScanning': 'Сохранить без распознавания',
  'receipt.saveHint': 'Фото останется прикреплённым к операции, которую вы заполните сами.',
  'receipt.saved': 'Чек сохранён.',
  'receipt.savedHint':
    'Прикрепите его к операции сейчас — после закрытия окна выбрать это фото уже не выйдет.',
  'receipt.addTransactionWith': 'Добавить операцию с этим чеком',
  'receipt.timedOut':
    'Это занимает больше времени, чем обычно. Фото загружено — можно подождать и ' +
    'попробовать распознать ещё раз или добавить операцию самим.',
  'receipt.tryReadingAgain': 'Распознать ещё раз',
  'receipt.chooseAnother': 'Выбрать другое фото',
  'receipt.notAnImage': 'Это не изображение. Выберите фото или скриншот.',
  'receipt.sourceTooLarge': 'Этот файл слишком большой, чтобы открыть его здесь. Выберите фото поменьше.',
  'receipt.decodeFailed': 'Не удалось открыть это изображение. Попробуйте другое фото.',
  'receipt.encodeFailed':
    'Не удалось подготовить это изображение на этом устройстве. Попробуйте другое фото.',
  'receipt.prepareFailed': 'Не удалось подготовить это изображение. Попробуйте другое фото.',
  'receipt.uploadFailed': 'Фото не загрузилось. Попробуйте ещё раз.',
  'receipt.itemsHeading': 'В этом чеке',

  // --- переводы -------------------------------------------------------------
  'transfer.newTitle': 'Новый перевод',
  'transfer.editTitle': 'Изменить перевод',
  'transfer.deleteTitle': 'Удалить перевод',
  'transfer.deleteMessage':
    'Удалить этот перевод? Уйдут обе его стороны, и остатки обоих счетов вернутся назад.',
  'transfer.needTwoAccounts':
    'Перевод переносит деньги между двумя счетами — сначала создайте второй счёт ' +
    'на экране «Счета».',
  'transfer.from': 'Откуда',
  'transfer.to': 'Куда',
  'transfer.amountSent': 'Сумма отправления',
  'transfer.amountSentIn': 'Сумма отправления ({currency})',
  'transfer.amountReceived': 'Сумма зачисления',
  'transfer.amountReceivedIn': 'Сумма зачисления ({currency})',
  'transfer.receivedHint':
    'Сколько на самом деле пришло на другой счёт — по реальному курсу банка, с комиссиями.',
  'transfer.rateAtTime': 'Курс на тот момент: {rate} {counterCurrency} за 1 {currency}',

  // --- категории ------------------------------------------------------------
  'categories.title': 'Категории',
  'categories.add': 'Добавить категорию',
  'categories.loadFailed': 'Не удалось загрузить категории.',
  'categories.budgetsTitle': 'Бюджеты на {month}',
  'categories.budgetsLoadFailed': 'Не удалось загрузить бюджеты.',
  'categories.budgetsEmpty':
    'Бюджетов пока нет — задайте бюджет любой категории расходов, чтобы видеть, ' +
    'сколько из него уже потрачено в этом месяце.',
  'categories.systemTag': 'Системная',
  'categoryForm.newTitle': 'Новая категория',
  'categoryForm.editTitle': 'Изменить категорию',
  'categoryForm.archiveTitle': 'Убрать категорию в архив',
  'categoryForm.unarchiveTitle': 'Вернуть категорию из архива',
  'categoryForm.archiveMessage':
    'Убрать «{name}» в архив? На прошлых операциях она останется, но для новых ' +
    'её выбрать будет нельзя.',
  'categoryForm.unarchiveMessage': 'Вернуть «{name}», чтобы ею снова можно было пользоваться?',
  'categoryForm.icon': 'Значок',
  'categoryForm.color': 'Цвет',
  'categoryForm.colorHint': '(необязательно, например #3366FF)',

  // --- бюджеты по категориям ------------------------------------------------
  'limits.setBudget': 'Задать бюджет',
  'limits.setBudgetFor': 'Задать бюджет для «{name}»',
  'limits.updateBudget': 'Обновить бюджет',
  'limits.editBudgetFor': '{action} — бюджет для «{name}»',
  'limits.removeBudgetFor': 'Убрать бюджет для «{name}»',
  'limits.removeTitle': 'Убрать бюджет',
  'limits.removeMessage': 'Убрать бюджет для «{name}»? Ваши операции это не затронет.',
  'limitForm.setTitle': 'Задать бюджет — {name}',
  'limitForm.editTitle': 'Изменить бюджет — {name}',
  'limitForm.amount': 'Бюджет на месяц',
  'limitForm.baseCurrencyHint': 'Бюджеты задаются в вашей базовой валюте.',
  'limitForm.restamp':
    'Сейчас бюджет — {amount}. Впишите, каким он должен быть в {currency}: при ' +
    'сохранении он перезапишется в этой валюте.',
  'limitForm.submit': 'Сохранить бюджет',
  'limitBar.budgetLabel': 'Бюджет:',
  'limitBar.spentInline': 'потрачено {amount}',
  'limitBar.mismatch':
    'Этот бюджет задан в {limitCurrency}, а базовая валюта теперь {currency}. ' +
    'Обновите бюджет, чтобы их можно было сравнивать.',
  'limitBar.ofLimit': 'из {limit}',
  'limitBar.pair': '{spent} из {limit}',
  'limitBar.over': 'Превышение на {amount}',
  'limitBar.left': 'осталось {amount}',
  'limitBar.aria': 'Бюджет: {name}',

  // --- регулярные операции --------------------------------------------------
  'recurring.title': 'Регулярные',
  'recurring.newTemplate': 'Новый шаблон',
  'recurring.lede':
    'Шаблоны создают операции по расписанию — в списке операций они помечены как регулярные.',
  'recurring.loadFailed': 'Не удалось загрузить регулярные шаблоны.',
  'recurring.emptyTitle': 'Регулярных шаблонов пока нет.',
  'recurring.emptyBody':
    'Добавьте аренду, зарплату или подписку — операция будет создаваться по ' +
    'расписанию сама, с пометкой «Регулярная» в списке.',
  'recurring.deleteTitle': 'Удалить шаблон',
  'recurring.deleteMessage':
    'Удалить этот шаблон? Расписание остановится, а с уже созданных операций ' +
    'снимется пометка «Регулярная». Сами операции и их суммы останутся.',
  'recurring.nextOn': 'Следующая — {date}',
  'recurring.paused': 'На паузе',
  'recurring.pausedNote':
    'Пока шаблон на паузе, ничего не создаётся, а пропущенные даты после ' +
    'возобновления не досоздаются.',
  'recurring.ended': 'Завершён',
  'recurring.endedOn': 'Завершён {date}',
  'recurring.pause': 'Пауза',
  'recurring.resume': 'Возобновить',
  'periodicity.monthly': 'Ежемесячно',
  'periodicity.monthlyOnDay': 'Ежемесячно, {day}-го числа',
  'periodicity.weekly': 'Еженедельно',
  'periodicity.weeklyOn': 'Еженедельно, {weekday}',
  'templateForm.newTitle': 'Новый шаблон',
  'templateForm.editTitle': 'Изменить шаблон',
  'templateForm.nameHint': 'Что это — «Аренда», «Зарплата», «Spotify».',
  'templateForm.account': 'Счёт',
  'templateForm.accountUnknown': 'Счёт этого шаблона',
  'templateForm.accountReadOnlyHint':
    'Каждая операция этого шаблона записывается на этот счёт. После создания ' +
    'шаблона счёт поменять нельзя.',
  'templateForm.accountHint': 'Каждая операция этого шаблона записывается на этот счёт.',
  'templateForm.repeats': 'Повтор',
  'templateForm.dayOfMonth': 'День месяца',
  'templateForm.clampHint':
    'В месяцах короче берётся их последний день (31 → 28 февраля).',
  'templateForm.weekday': 'День недели',
  'templateForm.endDate': 'Дата окончания',
  'templateForm.endDateHint':
    'Оставьте пустым, чтобы шаблон работал, пока вы его не поставите на паузу или не удалите.',
  'templateForm.endDatePassed': 'Эта дата уже прошла — ничего создаваться не будет.',
  'templateForm.merchant': 'Место',
  'templateForm.noteHint': 'Копируется в каждую операцию, созданную этим шаблоном.',

  // --- цели -----------------------------------------------------------------
  'goals.title': 'Цели',
  'goals.showArchived': 'Показать архив',
  'goals.newGoal': 'Новая цель',
  'goals.loadFailed': 'Не удалось загрузить цели.',
  'goals.freeBalancePrefix': 'За последние 3 полных месяца у вас оставалось примерно',
  'goals.freeBalanceSuffix':
    'в месяц. Именно это распределяется ниже — сначала на самые важные цели.',
  'goals.freeBalanceNone':
    'За последние 3 полных месяца вы потратили не меньше, чем заработали ' +
    '(осталось {amount} в месяц), поэтому распределять между целями пока нечего.',
  'goals.realismUnavailable':
    'Для части операций в этом окне не было курса, и они не учтены — поэтому эта ' +
    'цифра и оценки темпа ниже неполные.',
  'goals.emptyTitle': 'Целей пока нет.',
  'goals.emptyBody':
    'Создайте цель, чтобы увидеть, какую часть месячного остатка она займёт и ' +
    'реалистичен ли ваш срок.',
  'goalCard.reached': 'Достигнута',
  'goalCard.priority': 'Приоритет {value}',
  'goalCard.ofTarget': 'из {target}',
  'goalCard.pair': '{saved} из {target}',
  'goalCard.progressAria': 'Прогресс цели «{name}»',
  'goalCard.deadline': 'Срок: {date}',
  'goalCard.noDeadline': 'Без срока',
  'goalCard.completed': 'Вы достигли этой цели.',
  'goalCard.realismUnavailable':
    'Не получается проверить реалистичность — сейчас нет курса для {currency}. ' +
    'На накопленную и целевую суммы это не влияет.',
  'goalCard.noDeadlineHint':
    'Срок не задан, поэтому месячной нормы нет — добавьте срок, чтобы видеть, ' +
    'успеваете ли вы.',
  'goalCard.onTrack': 'Всё по плану: {amount} в месяц приведут к цели.',
  'goalCard.behindTitle':
    'При нынешнем темпе нереалистично — для этого срока нужно {amount} в месяц.',
  'goalCard.monthsToTarget': {
    one: 'При вашем свободном остатке это займёт примерно {count} месяц',
    few: 'При вашем свободном остатке это займёт примерно {count} месяца',
    many: 'При вашем свободном остатке это займёт примерно {count} месяцев',
    other: 'При вашем свободном остатке это займёт примерно {count} месяца',
  },
  'goalCard.monthsPlain': '{months}.',
  'goalCard.monthsWithSuggestion': '{months} — перенести срок на {date}?',
  'goalCard.behindUnreachable':
    'Свободного остатка на эту цель сейчас не хватает, поэтому оценить срок не получится.',
  'goalCard.allocated': 'Сюда идёт {amount} в месяц из свободного остатка.',
  'goalCard.noAllocation': 'Сейчас сюда не идёт ничего из свободного остатка.',
  'goalCard.addOrWithdraw': 'Пополнить или снять',
  'goalCard.hideHistory': 'Скрыть историю',
  'goalCard.showHistory': 'История и прогресс',
  'goalCard.archiveTitle': 'Убрать цель в архив',
  'goalCard.unarchiveTitle': 'Вернуть цель из архива',
  'goalCard.archiveMessage':
    'Убрать «{name}» в архив? История сохранится, но цель перестанет забирать ' +
    'часть свободного остатка.',
  'goalCard.unarchiveMessage':
    'Вернуть «{name}»? Цель снова будет участвовать в распределении свободного остатка.',
  'goalCard.deleteTitle': 'Удалить цель',
  'goalCard.deleteMessage':
    'Удалить «{name}»? Вместе с ней удалятся все записанные пополнения. Отменить ' +
    'это будет нельзя — если история нужна, уберите цель в архив.',
  'goalForm.newTitle': 'Новая цель',
  'goalForm.editTitle': 'Изменить цель',
  'goalForm.target': 'Целевая сумма',
  'goalForm.currencyChangeTitle': 'Сменить валюту',
  'goalForm.currencyChangeMessage':
    'Смена валюты просто переобозначит все накопленные суммы как {currency}. ' +
    'Ничего не пересчитывается и не конвертируется.',
  'goalForm.currencyChangeNotice':
    'Накопленные суммы будут просто переобозначены в {currency} — конвертации не будет.',
  'goalForm.deadline': 'Срок',
  'goalForm.deadlineHint':
    'Без срока мы просто ведём учёт накоплений и никогда не говорим, что вы отстаёте.',
  'goalForm.priority': 'Приоритет',
  'goalForm.priorityHint':
    'Меньше — раньше: свободный остаток распределяется сначала на самые приоритетные цели.',
  'goalForm.priorityHintEdit': 'Оставьте пустым, чтобы сохранить нынешний.',
  'goalForm.priorityHintCreate': 'Оставьте пустым, чтобы поставить цель последней.',
  'goalForm.initialSaved': 'Уже накоплено',
  'goalForm.initialSavedHint': 'Запишем как первое пополнение этой цели, в {currency}.',
  'contribution.title': 'Пополнить или снять — {name}',
  'contribution.direction': 'Направление',
  'contribution.add': 'Пополнить',
  'contribution.withdraw': 'Снять',
  'contribution.amount': 'Сумма ({currency})',
  'contribution.hintAdd': 'Укажите, сколько отложить.',
  'contribution.hintWithdraw': 'Укажите, сколько снять — минус ставить не нужно.',
  'contribution.futureNotice':
    'Эта дата в будущем. В накопления сумма попадёт сразу, но на графике прогресса ' +
    'месяцы показываются только по текущий.',
  'contributionList.loadFailed': 'Не удалось загрузить историю этой цели.',
  'contributionList.empty':
    'Движений пока не было. Нажмите «Пополнить или снять», чтобы записать первое.',
  'contributionList.deleteTitle': 'Удалить запись',
  'contributionList.deleteMessage': 'Удалить {amount} от {date}? Отменить это будет нельзя.',
  'goalChart.loadFailed': 'Не удалось загрузить график прогресса.',
  'goalChart.empty': 'Строить график пока не из чего — линия начнётся с первого пополнения.',
  'goalChart.emptyFutureOnly':
    'Строить график пока не из чего — всё накопленное здесь ({amount}) датировано ' +
    'позже этого месяца.',
  'goalChart.trailingNote':
    'График заканчивается текущим месяцем — всё, что датировано позже, входит в ' +
    'накопления ({amount}), но не в линию.',
  'goalChart.target': 'Цель',
  'goalChart.thisMonth': 'За месяц',
  'goalChart.saved': 'Накоплено',

  // --- статистика -----------------------------------------------------------
  'stats.title': 'Статистика',
  'stats.askAi': 'Спросить AI',
  'stats.resetPeriod': 'Вернуться к текущему месяцу',
  'stats.empty': 'Операций за {period} нет',
  'stats.emptyBody':
    'Добавьте операцию или выберите период, в котором точно что-то было — ' +
    'переключатель прямо сверху.',
  'stats.emptyBodyCustom': 'Добавьте операцию или расширьте диапазон «с — по» сверху.',
  'stats.addTransaction': 'Добавить операцию',
  'stats.backToThisMonth': 'К текущему месяцу',
  'period.unitGroup': 'Единица периода',
  'period.month': 'Месяц',
  'period.quarter': 'Квартал',
  'period.year': 'Год',
  'period.custom': 'Произвольный',
  'period.previous': 'Предыдущий период: {unit}',
  'period.next': 'Следующий период: {unit}',
  'period.from': 'С',
  'period.to': 'По',
  'statsTotals.expenses': 'Расходы',
  'statsTotals.comparedWith':
    'В сравнении с {from} – {to} — такой же по длине период непосредственно перед ' +
    'этим, границы определил сервер.',
  'statsTotals.bothZero': 'Как и в прошлом периоде — по нулям.',
  'statsTotals.bothZeroIncomplete': 'В этом периоде ничего — а прошлый период неполный.',
  'statsTotals.incomplete': '— прошлый период неполный, поэтому без процентов',
  'statsTotals.noBaseZero': '— в прошлом периоде ничего не было',
  'statsTotals.noBaseNegative': '— прошлый период был отрицательным, поэтому без процентов',
  'breakdown.heading': 'По категориям',
  'budgets.heading': 'Бюджеты',
  'budgets.manage': 'Управлять бюджетами',
  'budgets.monthOnly': 'Бюджеты месячные — выберите период «Месяц», чтобы их увидеть.',
  'budgets.emptyPrefix': 'На {month} бюджеты не заданы.',
  'budgets.emptyLink': 'Задайте бюджет категории',
  'budgets.emptySuffix': 'чтобы видеть, сколько из него уже потрачено.',
  'goalsSection.open': 'Открыть цели',
  'goalsSection.emptyPrefix': 'Целей пока нет.',
  'goalsSection.emptyLink': 'Создайте цель',
  'goalsSection.emptySuffix': 'чтобы увидеть, какую часть месячного остатка она займёт.',
  'monthly.heading': 'Последние {months} мес.',
  'monthly.windowGroup': 'Сколько месяцев показывать',
  'monthly.scopeNote':
    'Скользящее окно, заканчивающееся текущим месяцем, — оно не следует за периодом выше.',
  'monthly.loadFailed': 'Не удалось загрузить график по месяцам.',
  'monthly.emptyWindow': 'В этом окне активности не было.',
  'monthly.currentMonthNote':
    'Последний столбец ({month}) — текущий месяц: он неполный и продолжит расти.',
  'monthly.flaggedNote':
    '{months} — в этих месяцах есть операции без курса, они не вошли в столбцы. ' +
    'Наведите на месяц, чтобы увидеть его счётчик.',
  'monthly.footer': 'Суммы в {currency}, за {months} мес.',
  'monthly.thisMonthSoFar': ' — текущий месяц, неполный',
  'topMerchants.heading': 'Основные места трат',
  'topMerchants.loadFailed': 'Не удалось загрузить список мест.',
  'topMerchants.empty':
    'Названий мест пока нет — сюда попадают чеки и операции, у которых указано место.',

  // --- советник (только интерфейс; ОТВЕТЫ модели не трогаем) ----------------
  'advisor.title': 'AI-советник',
  'advisor.toStats': 'К статистике',
  'advisor.lead':
    'Ответы строятся по вашим тратам за последние месяцы, категориям и целям. ' +
    'История разговора хранится только на этой странице.',
  'advisor.emptyTitle': 'Спросите про свои траты',
  'advisor.emptyBody':
    'AI видит ваши категории, суммы за последние месяцы и цели — и отвечает ' +
    'обычным текстом. Например:',
  'advisor.example1': 'Куда уходят мои деньги в этом месяце?',
  'advisor.example2': 'На чём я могу сэкономить?',
  'advisor.example3': 'Как я двигаюсь к своим целям?',
  'advisor.you': 'Вы',
  'advisor.assistant': 'AI',
  'advisor.typing': 'AI печатает…',
  'advisor.stopped': 'Вы остановили ответ.',
  'advisor.answerReady': 'Ответ готов',
  'advisor.questionLabel': 'Вопрос',
  'advisor.placeholder': 'Например: сколько я потратил на еду в июле?',
  'advisor.counter': '{length} / {max} · Cmd/Ctrl+Enter — отправить',
  'advisor.stop': 'Остановить',
  'advisor.answering': 'Отвечает…',
  'advisor.ask': 'Спросить',
  'advisor.questionRequired': 'Введите вопрос.',
  'advisor.questionTooLong': 'Вопрос должен быть не длиннее {max} символов.',

  // --- настройки и токены доступа -------------------------------------------
  'settings.title': 'Настройки',
  'settings.language.title': 'Язык',
  'settings.language.lede':
    'Задаёт язык интерфейса, а также формат дат и чисел. Выбор сохраняется в ' +
    'профиле, поэтому мобильное приложение использует его же.',
  'settings.language.label': 'Язык интерфейса',
  'settings.language.saving': 'Сохраняем…',
  'settings.language.saveFailed':
    'Не удалось сохранить выбор в профиле — на этом устройстве он всё равно применён.',
  'tokens.heading': 'Токены доступа',
  'tokens.new': 'Новый токен',
  'tokens.lede':
    'Токен позволяет MCP-клиенту — Claude Desktop или Claude Code — работать с этим ' +
    'бюджетом от вашего имени. Вы сами решаете, что можно каждому токену, и в любой ' +
    'момент можете его отозвать.',
  'tokens.loadFailed': 'Не удалось загрузить токены доступа.',
  'tokens.emptyTitle': 'Токенов доступа пока нет.',
  'tokens.emptyBody':
    'Создайте токен, чтобы подключить Claude Desktop или Claude Code к этому бюджету. ' +
    'Строка токена показывается один раз, сразу после создания.',
  'tokens.revokeTitle': 'Отозвать токен',
  'tokens.revokeMessage':
    'Отозвать «{name}»? Всё, что использует этот токен, сразу перестанет работать, ' +
    'и восстановить его будет нельзя.',
  'tokens.revoke': 'Отозвать',
  'tokens.revoking': 'Отзываем…',
  'tokens.scopeRead': 'Только просмотр',
  'tokens.scopeFull': 'Просмотр и изменение',
  'tokens.revokedBadge': 'Отозван {date}',
  'tokens.created': 'Создан {date}',
  'tokens.lastUsed': 'последний раз использован {date}',
  'tokens.neverUsed': 'ни разу не использован',
  'tokenForm.createdTitle': 'Ваш новый токен',
  'tokenForm.namePlaceholder': 'MacBook — Claude Desktop',
  'tokenForm.nameHint': 'Видно только вам. По нему вы потом отличите токены друг от друга.',
  'tokenForm.nameRequired': 'Дайте токену название, чтобы потом его узнать.',
  'tokenForm.nameTooLong': 'Название должно быть не длиннее {max} символов.',
  'tokenForm.scopeLegend': 'Что можно этому токену',
  'tokenForm.scopeReadBody':
    'Может смотреть ваши данные — операции, категории, бюджеты, цели и статистику. ' +
    'Изменять или удалять что-либо не может.',
  'tokenForm.scopeFullBody':
    'Может смотреть ваши данные и изменять их — в том числе добавлять, править и ' +
    'удалять операции.',
  'tokenForm.create': 'Создать токен',
  'tokenForm.creating': 'Создаём…',
  'tokenCreated.introPrefix': 'Токен',
  'tokenCreated.introSuffix': 'готов. Вставьте его в настройки вашего MCP-клиента.',
  'tokenCreated.srLabel': 'Ваш новый токен',
  'tokenCreated.copy': 'Скопировать',
  'tokenCreated.copied': 'Скопировано',
  'tokenCreated.copiedStatus': 'Токен скопирован в буфер обмена.',
  'tokenCreated.copyFailed':
    'Скопировать автоматически не вышло — токен выделен выше, скопируйте его ' +
    'вручную (Ctrl+C / ⌘C).',
  'tokenCreated.warning':
    'Сохраните его сейчас — эту строку мы больше не покажем. Если потеряете, ' +
    'отзовите этот токен и создайте новый.',
  'tokenCreated.done': 'Готово',
};
