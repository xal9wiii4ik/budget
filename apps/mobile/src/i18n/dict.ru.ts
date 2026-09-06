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
  // catch-up 3, линия A: одно-предложный 'tx.filterNotice' убран — см. dict.en.ts.
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

  // --- фильтры операций (catch-up 3, линия A) --------------------------------
  'tx.searchLabel': 'Поиск операций',
  'tx.searchPlaceholder': 'Магазин или заметка',
  'tx.searchClear': 'Очистить поиск',
  'tx.filters': 'Фильтры',
  'tx.filtersActive': {
    one: 'Применён {count} фильтр',
    few: 'Применено {count} фильтра',
    many: 'Применено {count} фильтров',
    other: 'Применено {count} фильтра',
  },
  'tx.filtersReset': 'Сбросить эти фильтры',
  'tx.filterCategoryLabel': 'Категория',
  'tx.allCategories': 'Все категории',
  'tx.filterCountryLabel': 'Страна',
  'tx.allCountries': 'Все страны',
  'tx.filterCountrySearch': 'Начните вводить название страны',
  'tx.filterMoreHidden': 'Показаны не все варианты — уточните запрос выше.',
  'tx.filterCategoryChip': 'Категория: {category}',
  'tx.filterOneCategory': 'выбранная категория',
  'tx.clearCategoryFilter': 'Сбросить фильтр по категории',
  'tx.filterCountryChip': 'Страна: {country}',
  'tx.clearCountryFilter': 'Сбросить фильтр по стране',
  'tx.sortLabel': 'Сортировка',
  'tx.sortDateDesc': 'Сначала новые',
  'tx.sortDateAsc': 'Сначала старые',
  'tx.sortAmountDesc': 'Сначала крупные суммы',
  'tx.sortAmountAsc': 'Сначала мелкие суммы',
  'tx.rangeAllTime': 'За всё время',
  'tx.rangeCustom': 'Произвольный период',
  'tx.rangeBackToMonth': 'Вернуться к месяцу',
  'tx.rangeApply': 'Применить',
  'tx.rangeLabel': '{from} – {to}',
  'tx.rangeInverted': 'Конец периода раньше его начала.',
  'tx.rangeIncomplete': 'Укажите обе даты.',
  'tx.emptyFilteredMonth': 'В {month} под эти фильтры ничего не подходит',
  'tx.emptyFiltered': 'Под эти фильтры ничего не подходит.',
  'tx.emptyAll': 'Операций пока нет.',
  'tx.emptyClearFilters': 'Сбросить поиск и фильтры',
  // Без слова «счёт» перед {account}, в отличие от веба: подстановка на месте
  // имени может быть запасным «один счёт» (имя ещё не загружено), и
  // «счёт «один счёт»» — мусор.
  'tx.filterChip': 'Показан только {account}.',
  'tx.filterSummaryNote': 'Итоги выше по-прежнему учитывают все счета и категории.',
  'period.unitGroup': 'Единица периода',
  'period.month': 'Месяц',
  'period.from': 'С',
  'period.to': 'По',

  // --- поиск по вкладке категорий (catch-up 3, линия A) ----------------------
  'categories.searchLabel': 'Поиск категорий',
  'categories.searchPlaceholder': 'Поиск по названию',
  'categories.searchEmpty': 'По запросу «{query}» ничего не найдено.',
  'categories.searchClearAction': 'Очистить поиск',

  // --- операции одной категории (catch-up 3, линия A) ------------------------
  'categories.viewTransactionsFor': 'Операции в категории «{name}»',
  'categoryTx.total': 'Всего за период',
  'categoryTx.totalFailed': 'Не удалось загрузить итог за период.',
  'categoryTx.empty': 'В этой категории за выбранный период операций нет.',
  'categoryTx.unavailable': 'Эта категория недоступна.',
  'unconverted.month': {
    one: '{count} операция без курса не вошла в этот месяц.',
    few: '{count} операции без курса не вошли в этот месяц.',
    many: '{count} операций без курса не вошли в этот месяц.',
    other: '{count} операции без курса не вошли в этот месяц.',
  },
  'unconverted.totals': {
    one: 'Для {count} операции нет курса, она не вошла в эти итоги.',
    few: 'Для {count} операций нет курса, они не вошли в эти итоги.',
    many: 'Для {count} операций нет курса, они не вошли в эти итоги.',
    other: 'Для {count} операции нет курса, она не вошла в эти итоги.',
  },
  // --- конец фильтров операций / категорий (catch-up 3, линия A) -------------

  // --- регулярные / настройки (catch-up 3, линия B) --------------------------
  // Каждая фраза, которая есть и в вебе, взята оттуда дословно; новые здесь —
  // только те, которых в вебе нет (дата начала в строке, вкладка «Ещё», пауза).
  'tabs.more': 'Ещё',
  'more.recurring': 'Регулярные операции',
  'more.recurringHint': 'Аренда, зарплата, подписки — создаются по расписанию.',

  // --- регулярные шаблоны ----------------------------------------------------
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
  'recurring.startsOn': 'Начнётся {date}',
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

  // --- форма регулярного шаблона ---------------------------------------------
  'templateForm.newTitle': 'Новый шаблон',
  'templateForm.editTitle': 'Изменить шаблон',
  'templateForm.unavailable': 'Этот шаблон недоступен.',
  'templateForm.nameHint': 'Что это — «Аренда», «Зарплата», «Spotify».',
  'templateForm.account': 'Счёт',
  'templateForm.accountUnknown': 'Счёт этого шаблона',
  'templateForm.accountReadOnlyHint':
    'Каждая операция этого шаблона записывается на этот счёт. После создания ' +
    'шаблона счёт поменять нельзя.',
  'templateForm.accountHint':
    'Каждая операция этого шаблона записывается на этот счёт, в его валюте.',
  'templateForm.amountIn': 'Сумма, {currency}',
  'templateForm.repeats': 'Повтор',
  'templateForm.dayOfMonth': 'День месяца',
  'templateForm.clampHint':
    'В месяцах короче берётся их последний день (31 → 28 февраля).',
  'templateForm.weekday': 'День недели',
  'templateForm.startDate': 'Дата начала',
  'templateForm.startDateHint':
    'День повтора выше подстраивается под выбранную здесь дату. Оставьте ' +
    'поле пустым, чтобы начать с ближайшей даты по расписанию.',
  'templateForm.startDateConflict':
    'Дата начала — {startDate}, но повтор задан как «{schedule}»: первая ' +
    'операция будет создана {firstCharge}.',
  'templateForm.endDate': 'Дата окончания',
  'templateForm.endDateHint':
    'Оставьте пустым, чтобы шаблон работал, пока вы его не поставите на паузу или не удалите.',
  'templateForm.endDatePassed': 'Эта дата уже прошла — ничего создаваться не будет.',
  'templateForm.merchant': 'Место',
  'templateForm.noteHint': 'Копируется в каждую операцию, созданную этим шаблоном.',
  'templateForm.paused': 'На паузе',

  // --- виджет ближайших списаний (вкладка операций) --------------------------
  'upcoming.title': 'Ближайшие 30 дней',
  'upcoming.today': 'сегодня',
  'upcoming.loadFailed': 'Не удалось загрузить ближайшие списания.',
  'upcoming.emptyTitle': 'В ближайшие 30 дней ничего не запланировано.',
  'upcoming.emptyBody':
    'Аренда, зарплата или подписка, сохранённые как регулярный шаблон, ' +
    'появятся здесь до списания.',
  'upcoming.manage': 'Регулярные операции',
  'upcoming.more': {
    one: 'Ещё {count} списание.',
    few: 'Ещё {count} списания.',
    many: 'Ещё {count} списаний.',
    // Дробное число здесь невозможно, но категория обязана существовать.
    other: 'Ещё {count} списания.',
  },

  // --- настройки / язык ------------------------------------------------------
  'settings.language.title': 'Язык',
  'settings.language.lede':
    'Задаёт язык интерфейса, а также формат дат и чисел. Выбор сохраняется в ' +
    'профиле, поэтому веб-приложение использует его же.',
  'settings.language.saving': 'Сохраняем…',
  'settings.language.saveFailed':
    'Не удалось сохранить язык — ничего не изменилось. Попробуйте ещё раз.',

  // --- настройки / основная валюта -------------------------------------------
  'settings.baseCurrency.title': 'Основная валюта',
  'settings.baseCurrency.lede':
    'Валюта, в которой показываются итоги, бюджеты и цели. Выбор сохраняется в ' +
    'профиле, поэтому веб-приложение использует его же.',
  'settings.baseCurrency.saving': 'Сохраняем…',
  'settings.baseCurrency.saveFailed':
    'Не удалось сохранить основную валюту — ничего не изменилось. Попробуйте ещё раз.',
  'settings.baseCurrency.loadFailed': 'Не удалось загрузить профиль.',
  'settings.baseCurrency.warning':
    'Смена валюты меняет то, что вы видите, а не то, что хранится: у каждой операции ' +
    'остаются её сумма и курс на момент записи. Операции, для которых нет курса, ' +
    'показываются неконвертированными, а не подмешиваются в итоги молча. Заявленный ' +
    'доход будет сброшен — укажите его заново в новой валюте.',
  'settings.baseCurrency.confirmTitle': 'Сменить основную валюту?',
  'settings.baseCurrency.confirmMessage':
    'Итоги перейдут с {from} на {to}. Сохранённые суммы и курсы не меняются — ' +
    'меняется только то, что вам показывают.',
  'settings.baseCurrency.confirmMessageIncome':
    'Вы указывали доход {amount} {from}. Это число хранится без валюты, поэтому ' +
    'перенести его в {to} нельзя: оно будет сброшено, а в поле ниже появится ' +
    'пересчитанная подсказка — её можно принять или ввести своё число.',
  'settings.baseCurrency.confirmSubmit': 'Сменить на {to}',

  // --- настройки / заявленный месячный доход ---------------------------------
  'settings.income.title': 'Месячный доход',
  'settings.income.lede':
    'Цели используют его, пока истории не хватает, чтобы посчитать, сколько у вас ' +
    'реально остаётся за месяц.',
  'settings.income.label': 'Месячный доход',
  'settings.income.baseNote':
    'Читается как сумма в {currency} — вашей основной валюте. Сам по себе он не ' +
    'переводится в другую валюту: при смене основной валюты поле очищается, чтобы ' +
    'число всегда было тем, которое вы ввели в нужной валюте.',
  'settings.income.clearHint':
    'Оставьте поле пустым, чтобы убрать заявленный доход — тогда цели будут ждать ' +
    'реальную историю.',
  'settings.income.save': 'Сохранить',
  'settings.income.saving': 'Сохраняем…',
  'settings.income.saved': 'Сохранено.',
  'settings.income.saveFailed':
    'Не удалось сохранить месячный доход — ничего не изменилось.',
  'settings.income.suggestion':
    'Подсказка: {amount} — прежний доход, пересчитанный из {from} по сегодняшнему ' +
    'курсу. Пока вы не нажмёте «Сохранить», ничего не сохранено.',
  'settings.income.suggestionUnavailable':
    'Курса для пересчёта прежнего дохода не нашлось, поэтому поле пустое — укажите ' +
    'сумму в {currency}.',
  'settings.income.error.malformed': 'Введите сумму, например 1200 или 1200.50.',
  'settings.income.error.negative': 'Введите положительную сумму.',
  'settings.income.error.tooManyDecimals':
    'Слишком много знаков после точки для {currency}.',
  'settings.income.error.overflow': 'Слишком большая сумма.',
  // --- конец регулярных / настроек (catch-up 3, линия B) ---------------------

  // --- цели (catch-up 3, линия C) --------------------------------------------
  // Формулировки взяты из apps/web/src/i18n/dict.ru.ts там, где та же фраза есть
  // и в вебе. Новые ключи — только про элементы, которых в вебе нет (сегмент,
  // вкладка, чипы).
  'tabs.goals': 'Цели',
  'common.edit': 'Изменить',

  'goals.showArchived': 'Показать архив',
  'goals.newGoal': 'Новая цель',
  'goals.loadFailed': 'Не удалось загрузить цели.',
  'goals.openPlanHint': 'Откроет план этой цели',
  'goals.editAria': 'Изменить «{name}»',
  'goals.emptyTitle': 'Целей пока нет.',
  'goals.emptyBody':
    'Создайте цель, чтобы увидеть, какую часть месячного остатка она займёт и ' +
    'реалистичен ли ваш срок.',
  'goals.realismUnavailable':
    'Для части операций в этом окне не было курса, и они не учтены — поэтому эта ' +
    'цифра и оценки темпа ниже неполные.',
  'goals.freeBalancePrefix': 'За последние 3 полных месяца у вас оставалось примерно',
  'goals.freeBalanceSuffix':
    'в месяц. Именно это распределяется ниже — сначала на самые важные цели.',
  'goals.freeBalanceNone':
    'За последние 3 полных месяца вы потратили не меньше, чем заработали ' +
    '(осталось {amount} в месяц), поэтому распределять между целями пока нечего.',
  'goals.freeBalancePrefixPartial':
    'По {count} из 3 месяцев с активностью у вас оставалось примерно',
  'goals.freeBalanceNonePartial':
    'По {count} из 3 месяцев с активностью вы потратили не меньше, чем заработали ' +
    '(осталось {amount} в месяц), поэтому распределять между целями пока нечего.',
  'goals.freeBalanceBasis': 'Учтены месяцы: {from} – {to}',
  'goals.freeBalanceCurrentMonthNote':
    'Текущий месяц ещё идёт, поэтому доходы и траты этого месяца начнут учитываться, ' +
    'когда он закончится.',
  'goals.freeBalanceDeclaredPrefix':
    'Полных месяцев с операциями пока нет, поэтому цели считаются от заявленного ' +
    'дохода:',
  'goals.freeBalanceDeclaredSuffix':
    'в месяц. Именно это распределяется ниже — сначала на самые важные цели.',
  'goals.freeBalanceDeclaredBasis':
    'Как только позади будет полный месяц с операциями, расчёт переключится на то, ' +
    'сколько у вас реально осталось.',
  'goals.freeBalanceDeclaredZero':
    'Вы указали месячный доход 0, а истории операций пока нет, поэтому распределять ' +
    'между целями нечего.',
  'goals.freeBalanceNoBasisTitle': 'Пока не от чего считать.',
  'goals.freeBalanceNoBasisBody':
    'Полных месяцев с операциями ещё нет, и месячный доход не указан — поэтому целям ' +
    'нечего распределять. Укажите, сколько вы зарабатываете в месяц, и планирование ' +
    'начнётся сразу.',
  'goals.freeBalanceNoBasisLink': 'Указать месячный доход во вкладке «Ещё»',

  // --- карточка цели ---------------------------------------------------------
  'goalCard.reached': 'Достигнута',
  'goalCard.priority': 'Приоритет {value}',
  'goalCard.ofTarget': 'из {target}',
  'goalCard.deadline': 'Срок: {date}',
  'goalCard.noDeadline': 'Без срока',
  'goalCard.completed': 'Вы достигли этой цели.',
  'goalCard.effectiveTarget': 'итоговая стоимость плана',
  'goalCard.targetBeforePlan': 'До планирования вы задали {amount}',
  'goalCard.planBottomUp': 'План неполный: стоимость собирается из пунктов и будет расти.',
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

  // --- форма цели ------------------------------------------------------------
  'goalForm.newTitle': 'Новая цель',
  'goalForm.editTitle': 'Изменить цель',
  'goalForm.unavailable': 'Эта цель недоступна.',
  'goalForm.target': 'Целевая сумма ({currency})',
  'goalForm.currencyImmutableHint':
    'Валюта цели меняется в вебе — там видно целиком, как переобозначатся все ' +
    'накопленные суммы. Конвертации не происходит никогда.',
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
  'goalForm.archiveTitle': 'Убрать цель в архив',
  'goalForm.unarchiveTitle': 'Вернуть цель из архива',
  'goalForm.archiveMessage':
    'Убрать «{name}» в архив? История сохранится, но цель перестанет забирать ' +
    'часть свободного остатка.',
  'goalForm.unarchiveMessage':
    'Вернуть «{name}»? Цель снова будет участвовать в распределении свободного остатка.',
  'goalForm.deleteTitle': 'Удалить цель',
  'goalForm.deleteMessage':
    'Удалить «{name}»? Вместе с ней удалятся все записанные пополнения. Отменить ' +
    'это будет нельзя — если история нужна, уберите цель в архив.',

  // --- пополнения ------------------------------------------------------------
  'contribution.title': 'Пополнить или снять — {name}',
  'contribution.shortTitle': 'Пополнить или снять',
  'contribution.direction': 'Направление',
  'contribution.add': 'Пополнить',
  'contribution.withdraw': 'Снять',
  'contribution.amount': 'Сумма ({currency})',
  'contribution.futureDated': 'Эта дата в будущем. В накопления сумма попадёт сразу.',
  'contributionList.loadFailed': 'Не удалось загрузить историю этой цели.',
  'contributionList.empty':
    'Движений пока не было. Нажмите «Пополнить или снять», чтобы записать первое.',
  'contributionList.deleteTitle': 'Удалить запись',
  'contributionList.deleteMessage': 'Удалить эту запись? Отменить это будет нельзя.',

  // --- экран плана -----------------------------------------------------------
  'goalPlan.title': 'План',
  'goalPlan.backToGoals': '← Все цели',
  'goalPlan.notFound': 'Этой цели больше нет — возможно, она удалена.',
  'goalPlan.loadFailed': 'Не удалось загрузить план цели.',
  'goalPlan.archivedBanner':
    'Цель в архиве, план доступен только для чтения. Верните цель из архива, ' +
    'чтобы менять план.',
  'goalPlan.manualTarget': 'Сумма цели',
  'goalPlan.finalCostBottomUp': 'Итоговая стоимость плана',
  'goalPlan.finalCostManual': 'Итоговая стоимость (задана вручную)',
  'goalPlan.plannedTotal': 'Пункты складываются в',
  'goalPlan.planIncomplete':
    'План ещё неполный: итоговая стоимость собирается снизу из пунктов и будет расти ' +
    'по мере их добавления.',
  'goalPlan.targetBeforePlan': 'Сумма, заданная до планирования',
  'goalPlan.initialBudget': 'Первоначальный бюджет',
  'goalPlan.paid': 'Оплачено',
  'goalPlan.saved': 'Накоплено',
  'goalPlan.remaining': 'Осталось найти',
  'goalPlan.savedTab': 'История накоплений',
  'goalPlan.addContribution': 'Пополнить или снять',
  'goalPlan.editCost': 'Изменить стоимость',
  'goalPlan.plannedUnconverted': {
    one: 'Для {count} пункта нет курса к {currency} — он не вошёл в итоговую стоимость.',
    few: 'Для {count} пунктов нет курса к {currency} — они не вошли в итоговую стоимость.',
    many: 'Для {count} пунктов нет курса к {currency} — они не вошли в итоговую стоимость.',
    other: 'Для {count} пункта нет курса к {currency} — он не вошёл в итоговую стоимость.',
  },
  'goalPlan.paidUnconverted': {
    one: 'Для {count} привязанной операции нет курса к {currency} — она не вошла в «оплачено».',
    few: 'Для {count} привязанных операций нет курса к {currency} — они не вошли в «оплачено».',
    many: 'Для {count} привязанных операций нет курса к {currency} — они не вошли в «оплачено».',
    other: 'Для {count} привязанной операции нет курса к {currency} — она не вошла в «оплачено».',
  },
  'goalPlan.costTitle': 'Стоимость',
  'goalPlan.costLede': 'Пункты плана складываются в {amount}.',
  'goalPlan.finalCostLabel': 'Итоговая стоимость вручную',
  'goalPlan.finalCostHint':
    'В {currency}. Оставьте пустым — стоимость будет считаться из пунктов.',
  'goalPlan.initialBudgetLabel': 'Первоначальный бюджет',
  'goalPlan.initialBudgetHint': 'В {currency}. Сколько вы закладываете на эту цель.',
  'goalPlan.itemsTitle': 'Пункты плана',
  'goalPlan.addItem': 'Добавить пункт',
  'goalPlan.addChild': 'Добавить внутрь',
  'goalPlan.emptyTitle': 'В этой цели пока нет пунктов.',
  'goalPlan.emptyBody':
    'Разложите цель на пункты — билеты, жильё, страховка: у каждого своя цена, свой ' +
    'срок и свои ссылки. Пока пунктов нет, у цели остаётся заданная вами сумма.',
  'goalPlan.firstItemTitle': 'Считать стоимость из пунктов?',
  'goalPlan.firstItemMessage':
    'С первого пункта итоговая стоимость цели начнёт собираться снизу и будет расти по ' +
    'мере добавления пунктов. Заданная вами сумма останется ориентиром, а итоговую ' +
    'всегда можно снова задать вручную.',
  'goalPlan.firstItemConfirm': 'Добавить первый пункт',
  'goalPlan.noOwnAmount': 'Без своей суммы',
  'goalPlan.convertedSuffix': '≈ {amount}',
  'goalPlan.childrenSum': 'Пункты внутри: {amount}',
  'goalPlan.paidOnNode': 'Оплачено {amount}',
  'goalPlan.ceilingExceeded':
    'Пункты внутри складываются в {children} — больше собственной суммы {own}. ' +
    'В итог идёт сумма пунктов.',
  'goalPlan.nodeUnconverted': 'Нет курса {from} → {to}, поэтому эта сумма не вошла в итоги.',
  'goalPlan.nodePaidUnconverted': {
    one: '{count} привязанная операция не вошла в «оплачено» — нет курса.',
    few: '{count} привязанные операции не вошли в «оплачено» — нет курса.',
    many: '{count} привязанных операций не вошли в «оплачено» — нет курса.',
    other: '{count} привязанной операции не вошло в «оплачено» — нет курса.',
  },
  'goalPlan.noDeadline': 'Срок не задан',
  'goalPlan.deadlineOwn': 'К {date}',
  'goalPlan.deadlineInherited': 'К {date} · срок цели',
  'goalPlan.soon': 'скоро',
  'goalPlan.detailsHint': 'Покажет пункт и что с ним можно сделать',
  'goalPlan.filesCount': {
    one: '{count} файл',
    few: '{count} файла',
    many: '{count} файлов',
    other: '{count} файла',
  },
  'goalPlan.expandNode': 'Развернуть {name}',
  'goalPlan.collapseNode': 'Свернуть {name}',
  'goalPlan.moveUp': 'Выше',
  'goalPlan.moveDown': 'Ниже',
  'goalPlan.moveUpAria': 'Переместить {name} выше',
  'goalPlan.moveDownAria': 'Переместить {name} ниже',
  'goalPlan.moveTo': 'Перенести',
  'goalPlan.moveTitle': 'Перенести «{name}»',
  'goalPlan.moveToRoot': 'Верхний уровень плана',
  'goalPlan.moveNoTargets': 'Перенести этот пункт больше некуда.',
  'goalPlan.moveHint':
    'Пункт переедет вместе со всем, что внутри, и встанет последним среди новых ' +
    'соседей — порядок меняется кнопками «Выше» и «Ниже».',
  'goalPlan.deleteTitle': 'Удалить пункт плана',
  'goalPlan.deleteMessage': 'Удалить «{name}»?',
  'goalPlan.deleteChildrenNote': {
    one: 'Вместе с ним уйдёт {count} вложенный пункт.',
    few: 'Вместе с ним уйдут {count} вложенных пункта.',
    many: 'Вместе с ним уйдёт {count} вложенных пунктов.',
    other: 'Вместе с ним уйдёт {count} вложенного пункта.',
  },
  'goalPlan.deleteFilesNote': {
    one: 'Удалится и {count} прикреплённый файл.',
    few: 'Удалятся и {count} прикреплённых файла.',
    many: 'Удалится и {count} прикреплённых файлов.',
    other: 'Удалится и {count} прикреплённого файла.',
  },
  'goalPlan.deleteKeepsOperations':
    'Привязанные операции останутся в истории — просто без привязки.',

  // --- форма пункта плана ----------------------------------------------------
  'goalItemForm.newTitle': 'Новый пункт плана',
  'goalItemForm.editTitle': 'Изменить пункт плана',
  'goalItemForm.unavailable': 'Этот пункт плана недоступен.',
  'goalItemForm.amount': 'Стоимость ({currency})',
  'goalItemForm.amountHint':
    'Оставьте пустым для группирующего пункта — его стоимость соберётся из вложенных.',
  'goalItemForm.converted': 'Сумма в {currency}',
  'goalItemForm.convertedHint':
    'Оставьте пустым — сервер сам переведёт сумму в {currency}. Введённое вручную ' +
    'значение побеждает автоконвертацию.',
  'goalItemForm.converting': 'Конвертируем…',
  'goalItemForm.convertedNoRate':
    'Курса {from} → {to} на сегодня нет — введите сумму сами, иначе пункт не попадёт ' +
    'в итоги.',
  'goalItemForm.convertedRate': 'Курс {rate} на {date}',
  'goalItemForm.deadline': 'Срок',
  'goalItemForm.deadlineInheritHint': 'Оставьте пустым — пункт унаследует срок цели, {date}',
  'goalItemForm.deadlineInheritMove': 'Сдвинете цель — сдвинется и он.',
  'goalItemForm.deadlineNoneHint':
    'У цели нет срока, поэтому пустое поле означает, что срока нет и у пункта.',
  'goalItemForm.remindLegend': 'Напомнить',
  'goalItemForm.remindNone': 'Не напоминать',
  'goalItemForm.remindOn': 'В конкретную дату',
  'goalItemForm.remindDays': 'За сколько дней до срока',
  'goalItemForm.remindPreview': 'Получается {date}',
  'goalItemForm.remindPreviewPending': 'Заполните поле — покажем дату.',
  'goalItemForm.remindNoDeadline':
    'Отсчитывать пока не от чего: срока нет, поэтому у напоминания нет даты. Задайте ' +
    'срок — и оно заработает.',
  'goalItemForm.description': 'Заметки',
  'goalItemForm.links': 'Ссылки',
  'goalItemForm.linkNumber': 'Ссылка {number}',
  'goalItemForm.addLink': 'Добавить ссылку',
  'goalItemForm.linksHint': 'Бронь, объявление — что угодно нужное.',
  'goalItemForm.nameRequired': 'Назовите пункт.',
  'goalItemForm.nameTooLong': 'Название — не длиннее {max} символов.',
  'goalItemForm.descriptionTooLong': 'Заметки — не длиннее {max} символов.',
  'goalItemForm.tooManyLinks': 'Не больше {max} ссылок.',
  'goalItemForm.linkTooLong': 'Ссылка — не длиннее {max} символов.',
  'goalItemForm.amountMalformed': 'Введите корректную сумму в {currency}.',
  'goalItemForm.amountNegative': 'Сумма не может быть отрицательной.',
  'goalItemForm.amountDecimals': 'Слишком много знаков после запятой для {currency}.',
  'goalItemForm.amountOverflow': 'Слишком большая сумма.',
  'goalItemForm.amountPositive': 'Введите сумму больше нуля.',
  'goalItemForm.badDate': 'Выберите корректную дату.',
  'goalItemForm.remindDateRequired': 'Выберите дату напоминания.',
  'goalItemForm.remindDaysRequired': 'Введите целое число дней, не больше {max}.',

  // --- фото пункта плана -----------------------------------------------------
  'goalPhoto.title': 'Фото',
  'goalPhoto.alt': 'Фото пункта плана',
  'goalPhoto.listFailed': 'Не удалось загрузить фото пункта.',
  'goalPhoto.expired': 'Фото не загрузилось. Нажмите «Повторить» — запросим его заново.',
  'goalPhoto.notUploadedTile': 'Загрузка не завершилась',
  'goalPhoto.deleteTitle': 'Удалить фото',
  'goalPhoto.deleteMessage': 'Удалить это фото? Отменить будет нельзя. Сам пункт останется.',
  'goalPhoto.tooLarge': 'Изображение слишком большое. Выберите файл поменьше.',
  'goalPhoto.uploadFailed': 'Загрузка не прошла. Попробуйте ещё раз.',
  'goalPhoto.limit':
    'У пункта уже {max} фото — это максимум. Удалите одно, чтобы добавить другое.',
  'goalPhoto.notUploaded': 'Фото не догрузилось. Добавьте его заново.',
  'goalPhoto.fileGone': 'Этого фото больше нет.',
  'goalPhoto.storageUnavailable': 'Хранилище фото сейчас недоступно. Попробуйте чуть позже.',
  'goalPhoto.archived':
    'Цель в архиве, её план только для чтения. Верните цель из архива, чтобы менять фото.',
  'goalPhoto.itemGone': 'Этого пункта плана больше нет. Обновите экран и попробуйте снова.',
  'goalPhoto.goalGone': 'Этой цели больше нет — возможно, она удалена.',
  'goalPhoto.generic': 'С этим фото что-то пошло не так. Попробуйте снова.',

  // --- блок ближайших сроков -------------------------------------------------
  // «и вкладам» тут нет намеренно: экрана вкладов на этом клиенте нет.
  'deadlines.title': 'Скоро по планам',
  'deadlines.emptyTitle': 'В ближайшие 30 дней по планам ничего не наступает.',
  'deadlines.emptyBody':
    'Поставьте пункту плана срок или напоминание — и он появится здесь заранее.',
  'goalDeadlines.today': 'сегодня',
  'goalDeadlines.loadFailed': 'Не удалось загрузить ближайшие сроки целей.',
  'goalDeadlines.manage': 'Открыть цели',
  'goalDeadlines.dueBy': 'срок {date}',
  'goalDeadlines.more': {
    one: 'Ещё {count} пункт.',
    few: 'Ещё {count} пункта.',
    many: 'Ещё {count} пунктов.',
    // Дробное число здесь невозможно, но категория обязана существовать.
    other: 'Ещё {count} пункта.',
  },

  // --- пункт плана в форме операции ------------------------------------------
  'txForm.goalItem': 'Цель',
  'txForm.goalItemNone': 'Не относится к цели',
  'txForm.goalItemNode': 'Пункт плана',
  'txForm.goalItemNoNode': 'Пункт не выбран',
  'txForm.goalItemResolving': 'Операция привязана к пункту плана — ищем, к какому…',
  'txForm.goalItemGoalsFailed': 'Не удалось загрузить цели — сейчас привязку не изменить.',
  'txForm.goalItemNodesFailed': 'Не удалось загрузить план этой цели.',
  'txForm.goalItemEmptyPlan': 'У этой цели пока нет пунктов плана. Откройте цель и добавьте их.',
  'txForm.goalItemUnknown':
    'Операция привязана к пункту плана, которого мы больше не находим, — возможно, его цель в ' +
    'архиве. Привязка сохранится, пока вы её не снимете.',
  'txForm.goalItemDetach': 'Снять привязку',
  // --- конец целей (catch-up 3, линия C) -------------------------------------
};
