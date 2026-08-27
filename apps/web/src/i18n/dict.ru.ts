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
  'nav.deposits': 'Вклады',
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
  'accounts.importStatement': 'Импортировать выписку',
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
  'accounts.depositTag': '(вклад)',
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

  // --- вклады (deposits W1) -------------------------------------------------
  'deposits.title': 'Вклады',
  'deposits.add': 'Добавить вклад',
  'deposits.loadFailed': 'Не удалось загрузить вклады.',
  'deposits.lede':
    'Деньги на вкладе отложены: их нет в остатках по счетам, их не предлагают в ' +
    'формах операций и не считают ни в одном итоге. Они здесь.',
  'deposits.empty':
    'Вкладов пока нет. Добавьте вклад, чтобы видеть тело и проценты отдельно от ' +
    'обычных счетов.',
  'deposits.archivedGroup': 'Закрытые',
  'deposits.body': 'Тело',
  'deposits.accrued': 'Проценты',
  'deposits.afterTax': 'на руки',
  'deposits.rate': '{rate}% годовых',
  'deposits.capNone': 'простые проценты',
  'deposits.capMonthly': 'капитализация ежемесячно',
  'deposits.capQuarterly': 'капитализация ежеквартально',
  'deposits.capAtMaturity': 'капитализация в конце срока',
  'deposits.opened': 'открыт {date}',
  'deposits.term': 'до {date}',
  'deposits.openEnded': 'бессрочный',
  'deposits.badgeMatured': 'Срок истёк',
  'deposits.badgeOverridden': 'Поправлено вручную',
  'deposits.badgeArchived': 'Закрыт',
  'deposits.overrideAsOf':
    'Проценты поправлены вручную {date}; прогноз продолжает идти от этой суммы.',
  'deposits.topUp': 'Пополнить',
  'deposits.withdraw': 'Снять',
  'deposits.history': 'История',
  'deposits.accruedToday': 'Проценты на сегодня',

  // --- движения по одному вкладу во всплывающем окне над /deposits -----------
  // Без итога: это переводы (без категории, вне агрегатов /stats), серверного
  // поля с итогом по счёту за период нет, а сам клиент деньги не складывает.
  'depositTx.lede':
    'Пополнения и снятия. Тело и проценты — в строке самого вклада.',
  'depositTx.empty':
    'За выбранный период пополнений и снятий по этому вкладу нет. Выберите другой ' +
    'период или откройте все операции ниже.',
  'depositTx.listLabel': 'Операции по вкладу «{name}»',

  'depositForm.newTitle': 'Новый вклад',
  'depositForm.editTitle': 'Изменить вклад',
  'depositForm.rate': 'Ставка, % годовых',
  'depositForm.rateHint':
    'Ставка из договора, например 10.95. Проценты — это ПРОГНОЗ, никаких операций ' +
    'по вашим счетам они не создают.',
  'depositForm.capitalization': 'Капитализация',
  'depositForm.capNone': 'Нет — простые проценты',
  'depositForm.capMonthly': 'Ежемесячно',
  'depositForm.capQuarterly': 'Ежеквартально',
  'depositForm.capAtMaturity': 'В конце срока',
  'depositForm.openedOn': 'Дата открытия',
  'depositForm.openedOnHint':
    'Дата в прошлом — обычное дело: прогноз считается от неё.',
  'depositForm.termEnd': 'Окончание срока',
  'depositForm.termEndHint':
    'Оставьте пустым, если вклад бессрочный — например, накопительный счёт.',
  'depositForm.taxRate': 'Налог с процентов, %',
  'depositForm.taxRateHint':
    'Оставьте пустым, если проценты не облагаются налогом: пусто — это не 0.',
  'depositForm.initialBalance': 'Тело на дату открытия',
  'depositForm.initialBalanceHint':
    'Сколько уже лежало на вкладе в день открытия, в {currency}. Оставьте пустым, ' +
    'если вклад пустой и вы сейчас его пополните. Все последующие пополнения и ' +
    'снятия — это переводы, а не правка этого числа.',
  'depositForm.currencyCreateHint':
    'Деньги вклада учитываются в этой валюте, потом её изменить нельзя.',
  'depositForm.currencyImmutableHint':
    'Валюту вклада изменить нельзя. Закройте этот вклад и откройте новый в нужной валюте.',
  'depositForm.archiveTitle': 'Закрыть вклад',
  'depositForm.archiveMessage':
    'Закрыть вклад «{name}»? История останется как есть — он просто перестанет ' +
    'принимать деньги. Если деньги ещё на нём, сначала переведите их обратно на ' +
    'счёт: закрытый вклад переводы не принимает.',
  'depositForm.unarchiveTitle': 'Вернуть вклад из архива',
  'depositForm.unarchiveMessage': 'Вернуть «{name}», чтобы снова двигать по нему деньги?',
  'depositForm.archivedNotice':
    'Вклад закрыт, поэтому его условия менять нельзя. Сначала верните его из архива: ' +
    'разархивация и правка — два разных действия.',
  'depositForm.error.nameRequired': 'Введите название.',
  'depositForm.error.nameTooLong': 'Название — не длиннее {max} символов.',
  'depositForm.error.openedOnRequired': 'Выберите дату открытия.',
  'depositForm.error.rateMalformed': 'Введите ставку числом, например 10.95.',
  'depositForm.error.rateDecimals': 'В ставке не больше 4 знаков после точки.',
  'depositForm.error.rateTooLarge': 'Такая ставка слишком велика.',
  'depositForm.error.taxMalformed': 'Введите ставку налога числом, например 13.',
  'depositForm.error.taxDecimals': 'В ставке налога не больше 2 знаков после точки.',
  'depositForm.error.taxTooLarge': 'Ставка налога должна быть от 0 до 100.',
  'depositForm.error.termBeforeOpening': 'Срок должен заканчиваться позже даты открытия.',
  'depositForm.error.amountMalformed': 'Введите корректную сумму.',
  'depositForm.error.amountNegative': 'Вклад не открывают в минус.',
  'depositForm.error.amountDecimals': 'Слишком много знаков после точки для {currency}.',
  'depositForm.error.amountOverflow': 'Слишком большая сумма.',

  'depositAccrued.title': 'Проценты на сегодня',
  'depositAccrued.computed': 'Накоплено на сегодня по расчёту:',
  'depositAccrued.afterTax': 'На руки после налога: {amount}',
  'depositAccrued.field': 'Накопленные проценты ({currency})',
  'depositAccrued.hint':
    'Впишите сумму, которую показывает банк. Это не разовая правка: прогноз ' +
    'продолжит идти от этого числа и от этой даты, поэтому завтра сумма снова вырастет.',
  'depositAccrued.overriddenSince': 'Поправлено вручную {date}',
  'depositAccrued.reset': 'Сбросить к расчёту',
  'depositAccrued.resetTitle': 'Сбросить к расчёту',
  'depositAccrued.resetMessage':
    'Убрать вашу сумму и снова считать проценты по истории вклада? ' +
    'Ваша правка не сохранится.',
  'depositAccrued.resetting': 'Сбрасываем…',

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
  'tx.filterChip': 'Показан только счёт «{account}».',
  'tx.filterOneAccount': 'один счёт',
  'tx.filterCategoryChip': 'Категория: {category}',
  'tx.filterOneCategory': 'выбранная категория',
  'tx.filterSummaryNote': 'Итоги выше по-прежнему учитывают все счета и категории.',
  'tx.clearCategoryFilter': 'Сбросить фильтр по категории',
  'tx.showAllAccounts': 'Показать все счета',
  'tx.showAllCategories': 'Показать все категории',
  'tx.rangeAllTime': 'За всё время',
  'tx.rangeShowAllTime': 'Показать за всё время',
  'tx.rangeBackToMonth': 'Вернуться к месяцу',
  'tx.rangeCustom': 'Произвольный период',
  'tx.rangeApply': 'Применить',
  'tx.rangeLabel': '{from} – {to}',
  'tx.rangeInverted': 'Конец периода раньше его начала.',
  'tx.rangeIncomplete': 'Укажите обе даты.',
  'tx.loadFailed': 'Не удалось загрузить операции.',
  'tx.emptyMonth': 'Операций за {month} нет',
  'tx.emptyMonthCta': 'Добавьте первую.',
  'tx.emptyAccountMonth': 'На этом счёте операций за {month} нет',
  'tx.emptyFilteredMonth': 'За {month} под эти фильтры ничего не попало',
  'tx.emptyFiltered': 'Под эти фильтры ничего не попало.',
  'tx.emptyAll': 'Операций пока нет.',
  'tx.showing': 'Показано {shown} из {total}',
  'tx.recurringChip': 'Регулярная',
  'tx.transfer': 'Перевод',
  'tx.transferRoute': 'Перевод: {route}',
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
  'tx.filterCountryChip': 'Страна: {country}',
  'tx.clearCountryFilter': 'Сбросить фильтр по стране',
  'tx.sortLabel': 'Сортировка',
  'tx.sortDateDesc': 'Сначала новые',
  'tx.sortDateAsc': 'Сначала старые',
  'tx.sortAmountDesc': 'Сначала крупные суммы',
  'tx.sortAmountAsc': 'Сначала мелкие суммы',
  'tx.emptyClearFilters': 'Сбросить поиск и фильтры',
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
  'txForm.fromTemplateLede':
    'Заполнено по шаблону «{name}». Проверьте сумму и сохраните — это обычная ' +
    'операция, автоматическое списание она не отменяет.',
  'txForm.confirmTitle': 'Проверьте чек',
  'txForm.confirmLede':
    'Считано с вашего фото — проверьте и сохраните. Всё неверное можно поправить здесь.',
  'txForm.accountExpense': 'С какого счёта списано',
  'txForm.accountIncome': 'Куда пришло',
  'txForm.receiptCurrencyWarning':
    'Чек в {receiptCurrency}, а выбранный счёт — в {accountCurrency}. Операция ' +
    'сохранится в {accountCurrency}: проверьте сумму или выберите счёт в ' +
    '{receiptCurrency}.',
  'txForm.spentLabel': 'Потрачено, {currency}',
  'txForm.amountLabel': 'Сумма, {currency}',
  'txForm.receivedLabel': 'Получено, {currency}',
  'txForm.amountLabelIncome': 'Получено, {currency}',
  'txForm.spendCurrencyLabel': 'Валюта траты',
  'txForm.spendCurrencyLabelIncome': 'Валюта поступления',
  'txForm.spendCurrencyOther': 'Другая валюта…',
  'txForm.spendCurrencyOtherLabel': 'Код валюты, 3 буквы',
  'txForm.spendCurrencyHint':
    'Потратили в другой валюте? Выберите её здесь — подойдёт любой код из трёх букв.',
  'txForm.spendCurrencyHintIncome':
    'Пришло в другой валюте? Выберите её здесь — подойдёт любой код из трёх букв.',
  'txForm.chargedLabel': 'Списано со счёта, {currency}',
  'txForm.creditedLabel': 'Зачислено на счёт, {currency}',
  // FX_RATE_UNAVAILABLE, сказанное ДО сохранения. Это не ошибка и не вина
  // пользователя: курсы храним только по шести парам, для остальных пробел —
  // обычное дело, а выход простой — сумма из банка.
  'txForm.chargeNoRateAhead':
    'Мы храним курсы по шести валютным парам, и на эту дату курса для ' +
    '{from} → {to} нет. Просто впишите, сколько банк на самом деле списал со счёта.',
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
  // goal-planner W2: привязка расхода к пункту плана.
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
  'txForm.category': 'Категория',
  'txForm.suggestedFromSimilar': 'Подсказано по похожему чеку',
  'txForm.suggestedFromReceipt': 'Подсказано по этому чеку',
  'txForm.merchantLabel': 'Название / место',
  'txForm.merchantLabelIncome': 'Источник (кто заплатил)',
  'txForm.merchantHintIncome': 'Кто заплатил — работодатель, клиент, площадка.',
  'txForm.moreOptions': 'Ещё',
  'txForm.country': 'Страна',
  'txForm.deleteTitle': 'Удалить операцию',
  'txForm.deleteMessage': 'Удалить эту операцию? Отменить это будет нельзя.',
  'txForm.manualChargeRequired': 'Впишите сумму, которую списали со счёта, в {currency}.',
  'txForm.manualChargeRequiredIncome':
    'Впишите сумму, которая на самом деле пришла на счёт, в {currency}.',
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
  'transfer.topUpTitle': 'Пополнить вклад',
  'transfer.withdrawTitle': 'Снять с вклада',
  'transfer.fixedSideHint': 'Зафиксировано: форма открыта со страницы вклада.',
  'transfer.depositLegHint': 'Вклад: эту сторону перевода менять нельзя.',
  'transfer.needOneAccount':
    'Переводу нужен счёт на второй стороне — сначала создайте счёт на странице счетов.',

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
  'categories.viewTransactions': 'Операции в этой категории',
  'categories.viewTransactionsFor': 'Операции в категории «{name}»',
  'categories.searchLabel': 'Поиск категорий',
  'categories.searchPlaceholder': 'Поиск по названию',
  'categories.searchEmpty': 'По запросу «{query}» ничего не найдено.',
  'categories.searchClearAction': 'Очистить поиск',

  // --- операции одной категории во всплывающем окне над /categories ---------
  'categoryTx.total': 'Всего за период',
  'categoryTx.totalFailed': 'Не удалось загрузить итог за период.',
  'categoryTx.empty':
    'В этой категории за выбранный период операций нет. Выберите другой период ' +
    'или откройте все операции ниже.',

  // --- общее окно операций (features/transactions/TxWindowModal) -------------
  'txWindow.openAll': 'Открыть все операции →',

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
  'limits.setBudgetShort': 'Бюджет',
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
  'recurring.addTransaction': 'Записать операцию',
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

  // --- виджет ближайших списаний (/transactions) ----------------------------
  'upcoming.title': 'Ближайшие 30 дней',
  'upcoming.today': 'сегодня',
  'upcoming.loadFailed': 'Не удалось загрузить ближайшие списания.',
  'upcoming.emptyTitle': 'В ближайшие 30 дней ничего не запланировано.',
  'upcoming.emptyBody':
    'Аренда, зарплата или подписка, сохранённые как регулярный шаблон, ' +
    'появятся здесь до списания.',
  'upcoming.manage': 'Регулярные операции',
  'upcoming.addFromTemplate': 'Записать операцию по шаблону «{name}» на {date}',
  'upcoming.addFromTemplateShort': 'Записать операцию по этому шаблону',
  'upcoming.more': {
    one: 'Ещё {count} списание.',
    few: 'Ещё {count} списания.',
    many: 'Ещё {count} списаний.',
    // Дробное число здесь невозможно, но категория обязана существовать.
    other: 'Ещё {count} списания.',
  },

  // --- виджет ближайших сроков (/transactions, goal-planner W2 + deposits W1) -
  'deadlines.title': 'Скоро по планам и вкладам',
  'deadlines.emptyTitle': 'В ближайшие 30 дней по планам и вкладам ничего не наступает.',
  'deadlines.emptyBody':
    'Поставьте пункту плана срок или напоминание, а вкладу — дату окончания, ' +
    'и они появятся здесь заранее.',
  'deadlines.depositTerm': 'заканчивается срок вклада',
  'deadlines.openDeposits': 'Открыть вклады',
  'goalDeadlines.today': 'сегодня',
  'goalDeadlines.loadFailed': 'Не удалось загрузить ближайшие сроки целей.',
  'goalDeadlines.manage': 'Открыть цели',
  // Срок за напоминанием — приписка, а не вторая колонка.
  'goalDeadlines.dueBy': 'срок {date}',
  'goalDeadlines.more': {
    one: 'Ещё {count} пункт.',
    few: 'Ещё {count} пункта.',
    many: 'Ещё {count} пунктов.',
    // Дробное число здесь невозможно, но категория обязана существовать.
    other: 'Ещё {count} пункта.',
  },

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
  'goals.freeBalanceBasis': 'Учтены месяцы: {from} – {to}',
  'goals.freeBalanceCurrentMonthNote':
    'Текущий месяц ещё идёт, поэтому доходы и траты этого месяца начнут учитываться, ' +
    'когда он закончится.',
  'goals.freeBalancePrefixPartial':
    'По {count} из 3 месяцев с активностью у вас оставалось примерно',
  'goals.freeBalanceNonePartial':
    'По {count} из 3 месяцев с активностью вы потратили не меньше, чем заработали ' +
    '(осталось {amount} в месяц), поэтому распределять между целями пока нечего.',
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
  'goals.freeBalanceNoBasisLink': 'Указать месячный доход',
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
  'goalCard.effectiveTarget': 'итоговая стоимость плана',
  'goalCard.planBottomUp': 'План неполный: стоимость собирается из пунктов и будет расти.',
  'goalCard.openPlan': 'План',
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
  // --- настройки / основная валюта ------------------------------------------
  'settings.baseCurrency.title': 'Основная валюта',
  'settings.baseCurrency.lede':
    'Валюта, в которой показываются итоги, бюджеты и цели. Выбор сохраняется в ' +
    'профиле, поэтому мобильное приложение использует его же.',
  'settings.baseCurrency.label': 'Основная валюта',
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
    'Вы указывали доход {amount} {from}. Это число хранится без валюты, поэтому ' +
    'перенести его в {to} нельзя: оно будет сброшено, а мы сразу приведём вас к полю ' +
    'и подставим пересчитанную подсказку — её можно принять или ввести своё число.',
  'settings.baseCurrency.confirmSubmit': 'Сменить на {to}',
  'settings.baseCurrency.confirmPending': 'Меняем…',

  // --- настройки / заявленный месячный доход --------------------------------
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

  // --- план цели (goal-planner W1) -----------------------------------------
  'goalPlan.title': 'План',
  'goalPlan.backToGoals': '← Все цели',
  'goalPlan.notFound': 'Этой цели больше нет — возможно, она удалена.',
  'goalPlan.loadFailed': 'Не удалось загрузить план цели.',
  'goalPlan.archivedBanner':
    'Цель в архиве, план доступен только для чтения. Верните цель из архива, ' +
    'чтобы менять план.',
  'goalPlan.summaryAria': 'Стоимость цели и прогресс',
  'goalPlan.manualTarget': 'Сумма цели',
  'goalPlan.finalCostBottomUp': 'Итоговая стоимость плана',
  'goalPlan.finalCostManual': 'Итоговая стоимость (задана вручную)',
  'goalPlan.finalCostNone': 'не задана',
  'goalPlan.plannedTotal': 'Пункты складываются в',
  'goalPlan.planIncomplete':
    'План ещё неполный: итоговая стоимость собирается снизу из пунктов и будет расти ' +
    'по мере их добавления.',
  'goalPlan.targetBeforePlan': 'Сумма, заданная до планирования',
  'goalPlan.initialBudget': 'Первоначальный бюджет',
  'goalPlan.paid': 'Оплачено',
  'goalPlan.saved': 'Накоплено',
  'goalPlan.remaining': 'Осталось найти',
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
  'goalPlan.costSaved': 'Сохранено.',
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
  'goalPlan.nodeUnconverted':
    'Нет курса {from} → {to}, поэтому эта сумма не вошла в итоги.',
  'goalPlan.nodePaidUnconverted': {
    one: '{count} привязанная операция не вошла в «оплачено» — нет курса.',
    few: '{count} привязанные операции не вошли в «оплачено» — нет курса.',
    many: '{count} привязанных операций не вошли в «оплачено» — нет курса.',
    other: '{count} привязанной операции не вошло в «оплачено» — нет курса.',
  },
  'goalPlan.noDeadline': 'Срок не задан',
  'goalPlan.deadlineOwn': 'К {date}',
  'goalPlan.deadlineInherited': 'К {date} · срок цели',
  'goalPlan.filesCount': {
    one: '{count} файл',
    few: '{count} файла',
    many: '{count} файлов',
    other: '{count} файла',
  },
  // --- фото пункта плана ---
  'goalPlan.photosTitle': 'Фото',
  'goalPlan.photosLoadFailed': 'Не удалось загрузить фото пункта.',
  'goalPlan.photosEmpty':
    'Фото пока нет. Прикрепите билет, бронь или скриншот с ценой — до {max} на пункт.',
  'goalPlan.photosEmptyReadOnly': 'У пункта нет фото.',
  'goalPlan.photoAdd': 'Добавить фото',
  'goalPlan.photosLeft': 'Можно добавить ещё {count}.',
  'goalPlan.photosAtLimit':
    'У пункта уже {max} фото — это максимум. Удалите одно, чтобы добавить другое.',
  'goalPlan.photoAlt': 'Фото {index}',
  'goalPlan.photoUnavailable': 'Фото не загрузилось. Обновите — мы запросим его заново.',
  'goalPlan.photoRefresh': 'Обновить',
  'goalPlan.photoUnfinished': 'Загрузка не завершилась',
  'goalPlan.photoDeleteAria': 'Удалить фото {index}',
  'goalPlan.photoDeleteTitle': 'Удалить фото',
  'goalPlan.photoDeleteMessage':
    'Удалить это фото? Отменить будет нельзя. Сам пункт плана останется.',
  'goalPlan.photoPreparing': 'Готовим…',
  'goalPlan.photoUploading': 'Загружаем…',
  'goalPlan.photoConfirming': 'Завершаем…',
  'goalPlan.photoDismiss': 'Понятно',
  'goalPlan.photoError.notAnImage': 'Это не изображение. Прикрепите фото или скриншот.',
  'goalPlan.photoError.tooLarge': 'Изображение слишком большое. Выберите файл поменьше.',
  'goalPlan.photoError.prepareFailed':
    'Не удалось подготовить это изображение на вашем устройстве. Попробуйте другое фото.',
  'goalPlan.photoError.uploadFailed': 'Загрузка не прошла. Попробуйте ещё раз.',
  'goalPlan.photoError.limit':
    'У пункта уже {max} фото — это максимум. Удалите одно, чтобы добавить другое.',
  'goalPlan.photoError.notUploaded': 'Фото не догрузилось. Добавьте его заново.',
  'goalPlan.photoError.fileGone': 'Этого фото больше нет.',
  'goalPlan.photoError.storageUnavailable':
    'Хранилище фото сейчас недоступно. Попробуйте чуть позже.',
  'goalPlan.photoError.archived':
    'Цель в архиве, её план только для чтения. Верните цель из архива, чтобы менять фото.',
  'goalPlan.photoError.itemGone':
    'Этого пункта плана больше нет. Обновите страницу и попробуйте снова.',
  'goalPlan.photoError.goalGone': 'Этой цели больше нет — возможно, она удалена.',
  'goalPlan.photoError.generic': 'С этим фото что-то пошло не так. Попробуйте снова.',
  'goalPlan.showDetails': 'Подробности',
  'goalPlan.hideDetails': 'Скрыть подробности',
  'goalPlan.detailsEmpty': 'У пункта нет описания, ссылок и файлов.',
  'goalPlan.expandNode': 'Развернуть {name}',
  'goalPlan.collapseNode': 'Свернуть {name}',
  'goalPlan.hiddenChildren': {
    one: 'Скрыт {count} пункт',
    few: 'Скрыто {count} пункта',
    many: 'Скрыто {count} пунктов',
    other: 'Скрыто {count} пункта',
  },
  'goalPlan.moveUpAria': 'Переместить {name} выше',
  'goalPlan.moveDownAria': 'Переместить {name} ниже',
  'goalPlan.moveTo': 'Перенести',
  'goalPlan.moveTitle': 'Перенести «{name}»',
  'goalPlan.moveParentLabel': 'Поместить внутрь',
  'goalPlan.moveToRoot': 'Верхний уровень плана',
  'goalPlan.moveHint':
    'Пункт переедет вместе со всем, что внутри, и встанет последним среди новых ' +
    'соседей — порядок меняется стрелками.',
  'goalPlan.moveConfirm': 'Перенести',
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

  // --- форма пункта плана ---------------------------------------------------
  'goalItemForm.newTitle': 'Новый пункт плана',
  'goalItemForm.editTitle': 'Изменить пункт плана',
  'goalItemForm.amount': 'Стоимость',
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
  'goalItemForm.convertedAuto': 'Вернуть автоматическую сумму',
  'goalItemForm.deadline': 'Срок',
  'goalItemForm.deadlineInheritHint':
    'Оставьте пустым — пункт унаследует срок цели, {date}',
  'goalItemForm.deadlineInheritMove': 'Сдвинете цель — сдвинется и он.',
  'goalItemForm.deadlineNoneHint':
    'У цели нет срока, поэтому пустое поле означает, что срока нет и у пункта.',
  'goalItemForm.remindLegend': 'Напомнить',
  'goalItemForm.remindNone': 'Не напоминать',
  'goalItemForm.remindOn': 'В конкретную дату',
  'goalItemForm.remindDays': 'За несколько дней до срока',
  'goalItemForm.remindPreview': 'Получается {date}',
  'goalItemForm.remindPreviewPending': 'Заполните поле — покажем дату.',
  'goalItemForm.remindNoDeadline':
    'Отсчитывать пока не от чего: срока нет, поэтому у напоминания нет даты. Задайте ' +
    'срок — и оно заработает.',
  'goalItemForm.description': 'Заметки',
  'goalItemForm.links': 'Ссылки',
  'goalItemForm.linksHint': 'По одной в строке — бронь, объявление, что угодно нужное.',
  'goalItemForm.error.nameRequired': 'Назовите пункт.',
  'goalItemForm.error.nameTooLong': 'Название — не длиннее {max} символов.',
  'goalItemForm.error.descriptionTooLong': 'Заметки — не длиннее {max} символов.',
  'goalItemForm.error.tooManyLinks': 'Не больше {max} ссылок.',
  'goalItemForm.error.linkTooLong': 'Ссылка — не длиннее {max} символов.',
  'goalItemForm.error.amountMalformed': 'Введите корректную сумму в {currency}.',
  'goalItemForm.error.amountNegative': 'Сумма не может быть отрицательной.',
  'goalItemForm.error.amountDecimals': 'Слишком много знаков после запятой для {currency}.',
  'goalItemForm.error.amountOverflow': 'Слишком большая сумма.',
  'goalItemForm.error.amountPositive': 'Введите сумму больше нуля.',
  'goalItemForm.error.badDate': 'Выберите корректную дату.',
  'goalItemForm.error.remindDateRequired': 'Выберите дату напоминания.',
  'goalItemForm.error.remindDaysRequired': 'Введите целое число дней, не больше {max}.',

  // --- импорт выписки (statement-import S4) ---------------------------------
  'imports.uploadTitle': 'Импорт выписки',
  'imports.uploadLede':
    'CSV-выписка Приорбанка, импорт в ОДИН счёт. Пока ничего не записывается: ' +
    'сначала будет предпросмотр по строкам.',
  'imports.uploadAccount': 'Счёт',
  'imports.uploadAccountHint':
    'Валюта выписки должна совпадать с валютой счёта — банк указывает её в файле.',
  'imports.uploadFile': 'Файл выписки (CSV)',
  'imports.upload': 'Разобрать выписку',
  'imports.uploading': 'Разбираем…',
  'imports.pickAccountFirst': 'Выберите счёт, к которому относится выписка.',
  'imports.pickFileFirst': 'Выберите CSV-файл, который выдал банк.',
  'imports.currencyMismatchNamed':
    'Выписка в {statement}, а счёт в {account}. Выберите тот счёт, к которому ' +
    'относится выписка.',

  'imports.title': 'Импорт выписки',
  'imports.loadFailed': 'Не удалось загрузить этот импорт.',
  'imports.backToAccounts': 'К счетам',
  'imports.period': '{from} — {to}',
  'imports.rowsTotal': {
    one: '{count} операция в файле',
    few: '{count} операции в файле',
    many: '{count} операций в файле',
    other: '{count} операции в файле',
  },
  'imports.rowsBlocked': {
    one: 'Пропущена {count} заблокированная сумма — ещё не проведена',
    few: 'Пропущено {count} заблокированные суммы — ещё не проведены',
    many: 'Пропущено {count} заблокированных сумм — ещё не проведены',
    other: 'Пропущено {count} заблокированной суммы — ещё не проведены',
  },
  'imports.rowsZeroSkipped': {
    one: 'Пропущена {count} строка с нулевой суммой',
    few: 'Пропущено {count} строки с нулевой суммой',
    many: 'Пропущено {count} строк с нулевой суммой',
    other: 'Пропущено {count} строки с нулевой суммой',
  },

  'imports.filterLegend': 'Фильтр по результату сверки',
  'imports.filterAll': 'Все',
  'imports.filterExact': 'Уже записано',
  'imports.filterSimilar': 'Похоже на моё',
  'imports.filterNew': 'Новое',
  'imports.similarHint':
    'Та же сумма, дата расходится на день-два с вашей записью. Именно эти строки ' +
    'стоит посмотреть: оставить своё или взять версию банка.',
  'imports.bulkLede': 'Все строки этого статуса ({count}):',
  'imports.bulkImport': 'Импортировать все',
  'imports.bulkSkip': 'Пропустить все',

  'imports.rowsLoadFailed': 'Не удалось загрузить строки выписки.',
  'imports.rowsEmpty':
    'Из этой выписки не разобрано ни одной операции. Счётчики выше говорят, что и ' +
    'почему пропущено, — отмените импорт и загрузите другой файл.',
  'imports.rowsEmptyFiltered': 'Строк с таким статусом нет. Выберите другой выше.',

  'imports.badgeExact': 'Уже записано',
  'imports.badgeSimilar': 'Похоже на моё',
  'imports.badgeNew': 'Новое',
  'imports.badgeSectionContract': 'Раздел счёта',
  'imports.badgeSectionCard': 'Раздел карты',
  'imports.badgeTransfer': 'Возможно, перевод',
  'imports.transferHint':
    'По выписке одного счёта вторую сторону не видно. Пропустите строку и создайте ' +
    'перевод вручную.',
  'imports.fee': 'Комиссия / money-back: {amount}',

  'imports.decisionLegend': 'Что сделать со строкой',
  'imports.decisionAria': 'Что сделать со строкой: {description}',
  'imports.categoryAria': 'Категория для строки: {description}',
  'imports.decisionImport': 'Импортировать',
  'imports.decisionSkip': 'Пропустить',
  'imports.decisionReplaceOwn': 'Заменить моё',

  'imports.categoryNone': 'Без категории',
  'imports.suggestedByMerchant': 'подсказка по месту, которое вы уже относили к категории',
  'imports.suggestedByBankCategory': 'подсказка по категории банка',
  'imports.showMine': {
    one: 'Показать мою запись',
    few: 'Показать мои {count} записи',
    many: 'Показать мои {count} записей',
    other: 'Показать мои {count} записи',
  },
  'imports.hideMine': 'Скрыть',
  'imports.candidateNoName': 'Без названия',
  'imports.candidateBest': 'Лучшее совпадение',
  'imports.categoryTitle': 'Выберите категорию',
  'imports.categorySearch': 'Поиск',
  'imports.categoryNoMatch': 'Подходящей категории нет.',

  'imports.apply': 'Выполнить решения',
  'imports.replace': 'Заменить с даты…',
  'imports.cancel': 'Отменить импорт',
  'imports.applyTitle': 'Выполнить импорт?',
  'imports.applyCreate': {
    one: 'Будет создана {count} операция.',
    few: 'Будет создано {count} операции.',
    many: 'Будет создано {count} операций.',
    other: 'Будет создано {count} операции.',
  },
  'imports.applySkip': {
    one: 'Будет пропущена {count} строка.',
    few: 'Будет пропущено {count} строки.',
    many: 'Будет пропущено {count} строк.',
    other: 'Будет пропущено {count} строки.',
  },
  'imports.applyReplace': {
    one: 'На {count} строке ваша запись будет заменена.',
    few: 'На {count} строках ваши записи будут заменены.',
    many: 'На {count} строках ваши записи будут заменены.',
    other: 'На {count} строках ваши записи будут заменены.',
  },
  'imports.applyNothing': 'Все строки помечены «пропустить» — ничего записано не будет.',
  'imports.applyIrreversibleNote':
    'Заменённые записи удаляются; созданные потом можно изменить или удалить.',
  'imports.applyConfirm': 'Импортировать',
  'imports.applyPending': 'Импортируем…',

  'imports.cancelTitle': 'Отменить импорт?',
  'imports.cancelMessage':
    'Предпросмотр и все решения по нему будут отброшены. Ваши записи не затрагиваются, ' +
    'выписку можно загрузить заново.',
  'imports.cancelConfirm': 'Отменить импорт',

  'imports.finishedLede':
    'Эта выписка уже импортирована, менять её строки нельзя.',
  'imports.openTransactions': 'Открыть эти операции',

  'imports.reportTitle': 'Выписка импортирована',
  'imports.reportReplaceTitle': 'Период заменён',
  'imports.reportCreated': {
    one: 'Создана {count} операция',
    few: 'Создано {count} операции',
    many: 'Создано {count} операций',
    other: 'Создано {count} операции',
  },
  'imports.reportSkipped': {
    one: 'Пропущена {count} строка',
    few: 'Пропущено {count} строки',
    many: 'Пропущено {count} строк',
    other: 'Пропущено {count} строки',
  },
  'imports.reportReplaced': {
    one: 'Заменена {count} ваша запись',
    few: 'Заменено {count} ваши записи',
    many: 'Заменено {count} ваших записей',
    other: 'Заменено {count} ваши записи',
  },
  'imports.reportAlreadyExisted': {
    one: '{count} строка была импортирована раньше',
    few: '{count} строки были импортированы раньше',
    many: '{count} строк были импортированы раньше',
    other: '{count} строки были импортированы раньше',
  },
  'imports.reportDeleted': {
    one: 'Удалена {count} операция',
    few: 'Удалено {count} операции',
    many: 'Удалено {count} операций',
    other: 'Удалено {count} операции',
  },

  'imports.replaceTitle': 'Замена с даты',
  'imports.replaceLede':
    'Всё, что записано по этому счёту с выбранной даты и до конца выписки, будет ' +
    'УДАЛЕНО, а на это место ляжет выписка. Переводы останутся. Отменить это нельзя.',
  'imports.replaceDate': 'Заменить всё начиная с',
  'imports.replaceDateHint': 'Дата между {from} и {to} — других дней в выписке нет.',
  'imports.replaceDateOutOfRange': 'Выберите дату между {from} и {to}.',
  'imports.previewLoading': 'Считаем, что будет удалено…',
  'imports.previewDeleted': 'Будет удалено',
  'imports.previewWithReceipt': '…из них с прикреплённым чеком',
  'imports.previewWithGoalItem': '…из них оплачивают пункт плана цели',
  'imports.previewWithTemplate': '…из них созданы по шаблону регулярной операции',
  'imports.previewTransfersKept': 'Переводы — останутся, они не удаляются',
  'imports.previewWillCreate': 'Будет создано из выписки',
  'imports.previewLinksNote':
    'Связи с чеками, пунктами плана и шаблонами исчезнут вместе с удалёнными ' +
    'операциями. Сами фото чеков останутся.',
  'imports.confirmLabel': 'Для подтверждения введите число удаляемых операций',
  'imports.confirmHint': 'Это число из строки «Будет удалено» выше.',
  'imports.confirmMismatch': 'Это не то число, что выше. Введите его точно.',
  'imports.replaceConfirm': 'Удалить и импортировать',
  'imports.replacePending': 'Заменяем…',
  'imports.replaceStaleNamed':
    'Пока вы подтверждали, данные изменились, поэтому НИЧЕГО не удалено: сейчас ' +
    'удалилось бы {actual} операций, а не {confirmed}. Посмотрите числа и ' +
    'подтвердите ещё раз.',
};
