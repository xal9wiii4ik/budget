// FX preview data layer (mobile-catchup-2). ONE endpoint, read-only: GET
// /fx/convert is the server's conversion preview for the transaction form.
//
// The client never multiplies by a rate (D8): it encodes the typed amount into
// minor units (shared parseMoney, at the call site) and renders whatever the
// server returns. `converted_minor` / `rate` / `rate_as_of` are null TOGETHER when
// no rate exists — that is a degraded state, not an error.
//
// Copy of web data/fx.ts, `fxConvertQueryOptions` included since catch-up 3
// (line B): the settings screen converts IMPERATIVELY when the base currency
// changes, and it has to land in the same cache entry the form's preview uses
// rather than becoming a second, private way to call the endpoint.
import { throwOnError } from '@budget/api-client';
import { queryOptions, skipToken, useQuery } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { qk, type FxConvertParams } from './queryKeys';

export type { FxConvertParams };

// A stored rate is a daily row, so refetching on every re-render of the form
// would be pure waste. There is no invalidation path — every input is in the key.
const FX_STALE_TIME = 5 * 60_000;

/**
 * The shared definition of ONE conversion query: same key, same request, same
 * staleTime, whether it is subscribed to by a form or awaited by a settings
 * screen through `queryClient.fetchQuery`.
 */
export function fxConvertQueryOptions(params: FxConvertParams) {
  return queryOptions({
    queryKey: qk.fxConvert(params),
    queryFn: () =>
      throwOnError(
        apiClient.GET('/fx/convert', {
          params: {
            query: {
              amount_minor: params.amountMinor,
              // `from` is only ever an object key here, never a destructured
              // identifier (it is a reserved word).
              from: params.from,
              to: params.to,
              date: params.date,
            },
          },
        }),
      ),
    staleTime: FX_STALE_TIME,
    retry: false,
  });
}

/**
 * Preview `amountMinor` of `from` expressed in `to` on `date`. Pass `null` while
 * the inputs are incomplete (unparseable amount, same currency on both sides, no
 * date) — the query is skipped rather than fired with a guessed parameter.
 *
 * On mobile this drives ONE thing: the text estimate of what an account will be
 * charged for a foreign-currency operation whose charged field is still empty
 * (see features/transactions/chargePreview.ts for that decision). The result is
 * never written into a field.
 */
export function useFxPreview(params: FxConvertParams | null) {
  return useQuery(
    params === null
      ? {
          queryKey: qk.fxConvert(null),
          queryFn: skipToken,
          staleTime: FX_STALE_TIME,
          // A failed rate lookup is a hint on screen, not a blocker: one attempt,
          // and the field's copy tells the user they can type the amount.
          retry: false,
        }
      : fxConvertQueryOptions(params),
  );
}
