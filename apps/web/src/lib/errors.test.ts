import { describe, expect, it } from 'vitest';

import { createTranslate } from '../i18n/t';
import {
  describeCategoryError,
  describeContributionError,
  describeGoalError,
  describeReceiptError,
  describeAdvisorError,
  describeQaError,
  describeSearchError,
  describeStatsError,
  describeTransactionError,
  receiptErrorMessage,
} from './errors';
import { ApiError } from './query';

describe('describeCategoryError', () => {
  it('routes a 409 name conflict to the name field', () => {
    const result = describeCategoryError(
      new ApiError(409, { detail: 'CATEGORY_NAME_CONFLICT' }), 'en'
    );
    expect(result.field).toBe('name');
  });
});

describe('describeTransactionError', () => {
  it('routes CATEGORY_ARCHIVED to the category_id field', () => {
    const result = describeTransactionError(
      new ApiError(422, { detail: 'CATEGORY_ARCHIVED' }), 'en'
    );
    expect(result.field).toBe('category_id');
  });

  it('routes AMOUNT_REQUIRED to the form (unexpected-error fallback)', () => {
    const result = describeTransactionError(new ApiError(422, { detail: 'AMOUNT_REQUIRED' }), 'en');
    expect(result.field).toBe('form');
  });
});

describe('describeTransactionError (3.2 multi-currency codes)', () => {
  it('routes BASE_AMOUNT_WITHOUT_CURRENCY to the form, never to a field', () => {
    // The builder/schema make this unreachable — it is a bug signal, so it must
    // NOT be shown on the amount field as if the user mistyped something.
    const result = describeTransactionError(
      new ApiError(422, { detail: 'BASE_AMOUNT_WITHOUT_CURRENCY' }), 'en'
    );
    expect(result.field).toBe('form');
  });

  it('routes CURRENCY_REQUIRED to the form (same family)', () => {
    const result = describeTransactionError(
      new ApiError(422, { detail: 'CURRENCY_REQUIRED' }), 'en'
    );
    expect(result.field).toBe('form');
  });
});

describe('describeTransactionError (S6 confirm)', () => {
  it('maps RECEIPT_NOT_FOUND to its own form message, not the generic fallback', () => {
    // Same field ('form') as the generic case, so the message is what proves the
    // code is actually mapped — a create whose receipt vanished must say so.
    const result = describeTransactionError(new ApiError(422, { detail: 'RECEIPT_NOT_FOUND' }), 'en');
    const generic = describeTransactionError(new ApiError(422, { detail: 'UNMAPPED_CODE' }), 'en');
    expect(result.field).toBe('form');
    expect(result.message).toMatch(/receipt/i);
    expect(result.message).not.toBe(generic.message);
  });

  it('routes a 422 on merchant to the merchant input', () => {
    // The confirm form renders that input, so the server's complaint belongs on
    // it rather than in the form-level catch-all.
    const result = describeTransactionError(
      new ApiError(422, {
        detail: [{ loc: ['body', 'merchant'], msg: 'merchant must be at most 255 characters' }],
      }), 'en'
    );
    expect(result.field).toBe('merchant');
  });
});

describe('describeGoalError (3.2 W3)', () => {
  it('routes GOAL_NOT_FOUND to the form', () => {
    const result = describeGoalError(new ApiError(404, { detail: 'GOAL_NOT_FOUND' }), 'en');
    expect(result.field).toBe('form');
    expect(result.message).toMatch(/no longer exists/i);
  });

  it('routes a 422 field issue to the named goal field', () => {
    const result = describeGoalError(
      new ApiError(422, {
        detail: [{ loc: ['body', 'target_minor'], msg: 'Input should be >= 1' }],
      }), 'en'
    );
    expect(result.field).toBe('target_minor');
  });

  it('does NOT claim a contribution error as its own (no copy-paste catch-all)', () => {
    // CONTRIBUTION_EXCEEDS_SAVED belongs to describeContributionError and has no
    // goal field that could fix it; the goal helper must fall through to generic.
    const result = describeGoalError(
      new ApiError(422, { detail: 'CONTRIBUTION_EXCEEDS_SAVED' }), 'en'
    );
    expect(result.field).toBe('form');
    expect(result.message).not.toMatch(/saved/i);
  });
});

describe('describeContributionError (3.2 W4)', () => {
  it('routes CONTRIBUTION_EXCEEDS_SAVED to the amount field', () => {
    const result = describeContributionError(
      new ApiError(422, { detail: 'CONTRIBUTION_EXCEEDS_SAVED' }), 'en'
    );
    expect(result.field).toBe('amount_minor');
    expect(result.message).toMatch(/saved/i);
  });

  it('surfaces CONTRIBUTION_NOT_FOUND at row/dialog level, not on a field', () => {
    const result = describeContributionError(
      new ApiError(404, { detail: 'CONTRIBUTION_NOT_FOUND' }), 'en'
    );
    expect(result.field).toBe('form');
    expect(result.message).toMatch(/no longer exists/i);
  });
});

describe('receiptErrorMessage (S5 taxonomy)', () => {
  // The binding requirement (PM 2026-07-29): the local API deliberately runs
  // without an AI key, so this is the code the user meets FIRST. It must name the
  // real cause — an unconfigured server key — and it must not be the generic
  // message or a vague "not available right now".
  it('names the missing server AI key explicitly', () => {
    const message = receiptErrorMessage('AI_NOT_CONFIGURED', 'en');
    expect(message).toMatch(/\bAI\b/);
    expect(message).toMatch(/key/i);
    expect(message).toMatch(/server/i);
    expect(message).not.toBe(receiptErrorMessage('SOMETHING_ELSE', 'en'));
  });

  it('separates the model verdicts a user can act on differently', () => {
    // "not a receipt" (take a different route) vs "unreadable" (retake the same
    // photo better) are different instructions — a shared message would be a lie.
    const notAReceipt = receiptErrorMessage('NOT_A_RECEIPT', 'en');
    const unreadable = receiptErrorMessage('UNREADABLE_IMAGE', 'en');
    expect(notAReceipt).not.toBe(unreadable);
    expect(notAReceipt).toMatch(/manually/i);
    expect(unreadable).toMatch(/clearer/i);
  });

  it('falls back to the generic message for an unknown code', () => {
    // `receipt.error` is an untyped string on the contract, so an unmapped code
    // must degrade to something safe rather than render a raw server token.
    const unknown = receiptErrorMessage('SOME_FUTURE_CODE', 'en');
    expect(unknown).not.toMatch(/SOME_FUTURE_CODE/);
    expect(unknown).toBe(receiptErrorMessage('ANOTHER_UNMAPPED_CODE', 'en'));
  });
});

describe('describeStatsError', () => {
  it('treats PERIOD_ANCHOR_REQUIRED as a panel-level bug signal with a reset action', () => {
    // The period parser is total, so this code can only mean the client sent a
    // period it never should have. It must NOT surface the raw code, and it must
    // NOT be routed to a field — a read screen has none. What it DOES get is the
    // one action that provably restores a working screen.
    const result = describeStatsError(new ApiError(422, { detail: 'PERIOD_ANCHOR_REQUIRED' }), 'en');
    expect(result.canResetPeriod).toBe(true);
    expect(result.message).not.toMatch(/PERIOD_ANCHOR_REQUIRED/);
    expect(result).not.toHaveProperty('field');

    // Contrast: a network failure is not a period problem, so no reset offer.
    const offline = describeStatsError(new TypeError('Failed to fetch'), 'en');
    expect(offline.canResetPeriod).toBe(false);
    expect(offline.message).toMatch(/reach the server/i);
  });
});

describe('describeReceiptError', () => {
  it('extracts the code from an ApiError body and maps its message', () => {
    const result = describeReceiptError(new ApiError(409, { detail: 'RECEIPT_NOT_UPLOADED' }), 'en');
    expect(result.code).toBe('RECEIPT_NOT_UPLOADED');
    expect(result.message).toBe(receiptErrorMessage('RECEIPT_NOT_UPLOADED', 'en'));
  });

  it('reports the network failure of a raw storage PUT, with no code to retry on', () => {
    // The presigned PUT rejects with a TypeError, not an ApiError.
    const result = describeReceiptError(new TypeError('Failed to fetch'), 'en');
    expect(result.code).toBeUndefined();
    expect(result.message).toMatch(/reach the server/i);
  });

  it('does not invent a code for the 422 validation arm', () => {
    // The anyOf union's HTTPValidationError side has no string code: it is a bug
    // signal, so it must land on generic — and must NOT be mistaken for a
    // retryable receipt code.
    const result = describeReceiptError(
      new ApiError(422, { detail: [{ loc: ['path', 'receipt_id'], msg: 'not a valid uuid' }] }), 'en'
    );
    expect(result.code).toBeUndefined();
    expect(result.message).not.toMatch(/uuid/i);
  });
});

describe('describeAdvisorError', () => {
  it('17: renders the BINDING 503 copy byte-exactly, and the 429 with its own message', () => {
    // BINDING (task.md): a 503 {"detail":"AI_NOT_CONFIGURED"} renders exactly
    // this string. The assertion is a STRING EQUALITY on purpose — a copy edit
    // here must fail the build, not quietly ship a different promise.
    const unconfigured = describeAdvisorError(
      new ApiError(503, { detail: 'AI_NOT_CONFIGURED' }),
      'ru',
    );
    expect(unconfigured.message).toBe('AI недоступен — ключ не настроен');
    // Nothing was produced, so there is no partial answer to keep.
    expect(unconfigured.keepsPartialAnswer).toBe(false);

    // Contrast arm: the other pre-stream code has its own copy, so one table
    // entry cannot silently swallow the other.
    const limited = describeAdvisorError(new ApiError(429, { detail: 'RATE_LIMITED' }), 'ru');
    expect(limited.message).toBe('Слишком много запросов. Подождите и попробуйте снова.');

    // The mid-stream channel is a bare detail string (no HTTP status exists once
    // the 200 has been sent) and keeps whatever text already arrived.
    expect(describeAdvisorError('STREAM_INCOMPLETE', 'ru').keepsPartialAnswer).toBe(true);
    expect(describeAdvisorError('STREAM_MALFORMED', 'ru').keepsPartialAnswer).toBe(false);

    // S5: the table follows the CHOSEN language now — an English user gets an
    // English line under a Russian-only-until-now panel. The binding ru copy
    // above and this must not be the same string, or one of them is unrouted.
    const englishUnconfigured = describeAdvisorError(
      new ApiError(503, { detail: 'AI_NOT_CONFIGURED' }),
      'en',
    );
    expect(englishUnconfigured.message).not.toBe(unconfigured.message);
    expect(englishUnconfigured.message).toMatch(/\bAI\b/);
  });
});

describe('describeSearchError (rag Web A)', () => {
  const t = createTranslate('ru');

  it('tells a missing MODEL apart from a missing AI key, and from a rate limit', () => {
    // The two 503s a user can meet in this scope come from different causes with
    // different consequences — an absent artifact leaves the AI advisor working,
    // an absent key leaves the search working — so one sentence for both would
    // send the owner looking in the wrong place.
    const embeddings = describeSearchError(
      new ApiError(503, { detail: 'EMBEDDINGS_NOT_AVAILABLE' }),
      'ru',
      t,
    );
    expect(embeddings.kind).toBe('embeddings-off');
    expect(embeddings.message).not.toBe(
      describeAdvisorError(new ApiError(503, { detail: 'AI_NOT_CONFIGURED' }), 'ru').message,
    );

    const limited = describeSearchError(new ApiError(429, { detail: 'RATE_LIMITED' }), 'ru', t);
    expect(limited.kind).toBe('rate-limited');
    expect(limited.message).not.toBe(embeddings.message);
  });

  it('gives a blank-query 422 the generic line — it is a bug signal, not advice', () => {
    // The UI never commits a blank phrase, so reaching this code means something
    // else is wrong; there is no field to route it to and nothing to suggest.
    const blank = describeSearchError(
      new ApiError(422, { detail: 'SEARCH_QUERY_BLANK' }),
      'ru',
      t,
    );
    expect(blank.kind).toBe('other');
    expect(blank.message).toBe(describeSearchError(new ApiError(500, {}), 'ru', t).message);
  });

  it('calls a request that never left the browser a network failure', () => {
    expect(describeSearchError(new TypeError('Failed to fetch'), 'ru', t).kind).toBe('other');
    expect(describeSearchError(new TypeError('Failed to fetch'), 'ru', t).message).not.toBe(
      describeSearchError(new ApiError(500, {}), 'ru', t).message,
    );
  });
});

describe('describeQaError (rag Web A)', () => {
  const t = createTranslate('ru');

  it('gives each of the five codes its own sentence', () => {
    // Five codes, five different next steps: no provider (nothing to wait for),
    // the provider failed (wait), no embeddings (nothing to ground an answer
    // in), an unusable answer (rephrase), too many questions (slow down). A
    // shared "the AI is having trouble" line would hide all five.
    const cases = [
      ['AI_NOT_CONFIGURED', 'ai-off'],
      ['AI_UNAVAILABLE', 'ai-unavailable'],
      ['EMBEDDINGS_NOT_AVAILABLE', 'embeddings-off'],
      ['QA_FAILED', 'failed'],
      ['RATE_LIMITED', 'rate-limited'],
    ] as const;

    const messages = cases.map(([code, kind]) => {
      const failure = describeQaError(new ApiError(503, { detail: code }), 'ru', t);
      expect(failure.kind).toBe(kind);
      return failure.message;
    });
    expect(new Set(messages).size).toBe(cases.length);
  });

  it('falls back to generic for an unknown code and to network for a dead request', () => {
    const unknown = describeQaError(new ApiError(500, { detail: 'WHAT_IS_THIS' }), 'ru', t);
    expect(unknown.kind).toBe('other');
    const offline = describeQaError(new TypeError('Failed to fetch'), 'ru', t);
    expect(offline.kind).toBe('other');
    // Both are the catch-all KIND, but they must not be the same sentence: one
    // says the server refused, the other that nothing was ever sent.
    expect(offline.message).not.toBe(unknown.message);
  });
});
