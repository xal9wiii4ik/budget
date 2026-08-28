import { describe, expect, it } from 'vitest';

import { createTranslate } from '../../i18n/t';
import { bankTextUntranslated, translateBankText } from './bankPhrases';

// The real bound translators, not a stub: half the point of this module is that
// the phrase keys EXIST in both dictionaries and that switching the language
// switches the words the user reads.
const en = createTranslate('en');
const ru = createTranslate('ru');

describe('translateBankText', () => {
  it('translates an Operation value by exact match, in the chosen language', () => {
    expect(translateBankText('საბარათე ოპერაცია', en)).toEqual({
      text: 'Card operation',
      untranslated: false,
    });
    expect(translateBankText('საბარათე ოპერაცია', ru)).toEqual({
      text: 'Операция по карте',
      untranslated: false,
    });
  });

  it('translates the description prefix and copies the rest of the line verbatim', () => {
    // The tail is the merchant and the "spent" pair — data. Touching it would
    // mean the row no longer says what the bank said.
    expect(translateBankText('გადახდა - YANDEX.EDA 56.10 BYN 01.08.2026', en)).toEqual({
      text: 'Payment - YANDEX.EDA 56.10 BYN 01.08.2026',
      untranslated: false,
    });
    expect(translateBankText('განაღდება - ATM SHOP "N26 ZHIVINKA"', ru)).toEqual({
      text: 'Снятие наличных - ATM SHOP "N26 ZHIVINKA"',
      untranslated: false,
    });
  });

  it('keeps a Georgian phrase it has no copy for and reports the gap', () => {
    // A phrase from a statement month this dictionary was not built on: shown as
    // the file has it, and FLAGGED — that flag is the metric behind the
    // "move the dictionary into the database" decision.
    const unknown = translateBankText('პროცენტის დარიცხვა', en);
    expect(unknown).toEqual({ text: 'პროცენტის დარიცხვა', untranslated: true });
    expect(bankTextUntranslated('პროცენტის დარიცხვა')).toBe(true);
  });

  it('leaves a line with no Georgian in it alone', () => {
    // Every Priorbank row is this case: the module must be a no-op for the bank
    // that shipped before it existed.
    expect(translateBankText('BLR MINSK SHOP "SANTA-362" BAPB', en)).toEqual({
      text: 'BLR MINSK SHOP "SANTA-362" BAPB',
      untranslated: false,
    });
    expect(bankTextUntranslated('BLR MINSK SHOP "SANTA-362" BAPB')).toBe(false);
  });

  it('flags a known prefix whose tail is still Georgian', () => {
    // The prefix alone is not "translated": what follows it here is a Georgian
    // payee, so the row still needs the badge — contrast with the merchant tail
    // above, which is clean.
    expect(translateBankText('გადახდა - ვალერია ბენიაშ', en)).toEqual({
      text: 'Payment - ვალერია ბენიაშ',
      untranslated: true,
    });
  });
});
