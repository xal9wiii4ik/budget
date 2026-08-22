// The RUSSIAN dictionary. `Dictionary` is a mapped type over dict.en.ts, so this
// object MUST cover every key with the matching shape — a missing key or a plural
// entry written as a bare string is a typecheck failure, not a runtime surprise.
import type { Dictionary } from './t';

export const ru: Dictionary = {
  'settings.language.title': 'Язык',
  'settings.language.lede':
    'Задаёт язык интерфейса, а также формат дат и чисел. Выбор сохраняется в ' +
    'профиле, поэтому мобильное приложение использует его же.',
  'settings.language.label': 'Язык интерфейса',
  'settings.language.saving': 'Сохраняем…',
  'settings.language.saveFailed':
    'Не удалось сохранить выбор в профиле — на этом устройстве он всё равно применён.',

  transactionCount: {
    one: '{count} операция',
    few: '{count} операции',
    many: '{count} операций',
    // Fractions ("1,5 операции") — a category en does not have at all.
    other: '{count} операции',
  },
};
