import { describe, expect, it } from 'vitest';

import { OTHER_CURRENCY_OPTION, spendCurrencyView } from './spendCurrencyView';

describe('spendCurrencyView', () => {
  it('keeps an exotic stored currency selected instead of snapping to the list', () => {
    // Editing a JPY purchase made on a BYN card: JPY reaches the control through
    // `spendCurrencyOptions({ current })`, and a picker that only knew the
    // account currencies would silently rewrite the operation on open.
    const view = spendCurrencyView(['BYN', 'EUR', 'JPY'], 'JPY', false);

    expect(view.selectValue).toBe('JPY');
    expect(view.showOther).toBe(false);
    expect(view.options).toEqual(['BYN', 'EUR', 'JPY']);
  });

  it('never lets a half-typed code become an option, and keeps the field open', () => {
    // Mid-typing in the free-text field the form holds "J", which comes back in
    // as a suggestion. Both halves matter: no junk option, and the field the
    // user is typing in does not close under them.
    const view = spendCurrencyView(['BYN', 'EUR', 'J'], 'J', true);

    expect(view.options).toEqual(['BYN', 'EUR']);
    expect(view.selectValue).toBe(OTHER_CURRENCY_OPTION);
    expect(view.showOther).toBe(true);
  });

  it('switches into and back out of the free-text field on the same value', () => {
    const suggestions = ['BYN', 'EUR', 'JPY'];

    const asking = spendCurrencyView(suggestions, 'JPY', true);
    expect(asking.showOther).toBe(true);
    expect(asking.selectValue).toBe(OTHER_CURRENCY_OPTION);
    // The code being typed is already visible in its own field; a duplicate,
    // unselected copy of it in the list would read as a second currency.
    expect(asking.options).toEqual(['BYN', 'EUR']);

    // Picking a real option again closes the field with nothing lost.
    const back = spendCurrencyView(suggestions, 'JPY', false);
    expect(back.showOther).toBe(false);
    expect(back.selectValue).toBe('JPY');
  });

  it('opens the free-text field for a value no option could stand for', () => {
    // Not reachable from the form today (the current value is always suggested),
    // but this is the invariant the select depends on: it never renders a value
    // it has no <option> for, which browsers resolve by picking the first one.
    const view = spendCurrencyView(['BYN', 'EUR'], 'MXN', false);

    expect(view.showOther).toBe(true);
    expect(view.selectValue).toBe(OTHER_CURRENCY_OPTION);
  });
});
