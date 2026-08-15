// FX preview data layer (3.2 WD-3). ONE endpoint, read-only: GET /fx/convert is
// the server's conversion preview for the transaction form's converted section.
//
// The client never multiplies by a rate (D8): it encodes the typed amount into
// minor units (shared parseMoney, at the call site) and renders whatever the
// server returns. `converted_minor` / `rate` / `rate_as_of` are null TOGETHER when
// no rate exists — that is a degraded state, not an error.
import { skipToken, useQuery } from '@tanstack/react-query';

import { apiClient } from '../lib/api';
import { throwOnError } from '../lib/query';
import { qk, type FxConvertParams } from './queryKeys';

export type { FxConvertParams };

/**
 * Preview `amountMinor` of `from` expressed in `to` on `date`. Pass `null` while
 * the inputs are incomplete (unparseable amount, base currency selected, no
 * date) — the query is skipped rather than fired with a guessed parameter.
 *
 * `staleTime` is 5 minutes: a stored rate is a daily row, so refetching on every
 * re-render of the modal would be pure waste. There is no invalidation path —
 * every input is in the key.
 */
export function useFxPreview(params: FxConvertParams | null) {
  return useQuery({
    queryKey: qk.fxConvert(params),
    queryFn:
      params === null
        ? skipToken
        : () =>
            throwOnError(
              apiClient.GET('/fx/convert', {
                params: {
                  query: {
                    amount_minor: params.amountMinor,
                    // T2: `from` is only ever an object key here, never a
                    // destructured identifier (it is a reserved word).
                    from: params.from,
                    to: params.to,
                    date: params.date,
                  },
                },
              }),
            ),
    staleTime: 5 * 60_000,
  });
}
