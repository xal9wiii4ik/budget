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

// A stored rate is a daily row, so refetching on every re-render of the modal
// would be pure waste. There is no invalidation path — every input is in the key
// (a base-currency switch is therefore a NEW key, not a stale one).
const FX_STALE_TIME = 5 * 60_000;

/**
 * The one place `GET /fx/convert` is described. It is shared by the hook below and
 * by the ONE imperative caller (the settings base-currency switch, which needs a
 * single conversion at a moment in time rather than a subscription) — so both land
 * in the same `['fx','convert', params]` cache entry with the same staleTime,
 * instead of the fetch being retyped next to a `queryClient.fetchQuery` call.
 */
export function fxConvertQueryOptions(params: FxConvertParams) {
  return {
    queryKey: qk.fxConvert(params),
    queryFn: () =>
      throwOnError(
        apiClient.GET('/fx/convert', {
          params: {
            query: {
              amount_minor: params.amountMinor,
              // T2: `from` is only ever an object key here, never a destructured
              // identifier (it is a reserved word).
              from: params.from,
              to: params.to,
              date: params.date,
            },
          },
        }),
      ),
    staleTime: FX_STALE_TIME,
  };
}

/**
 * Preview `amountMinor` of `from` expressed in `to` on `date`. Pass `null` while
 * the inputs are incomplete (unparseable amount, base currency selected, no
 * date) — the query is skipped rather than fired with a guessed parameter.
 *
 * `staleTime` (5 minutes) and the request itself come from
 * `fxConvertQueryOptions`; this hook only adds the skipped-state arm.
 */
export function useFxPreview(params: FxConvertParams | null) {
  return useQuery({
    ...(params === null
      ? { queryKey: qk.fxConvert(null), queryFn: skipToken }
      : fxConvertQueryOptions(params)),
    staleTime: FX_STALE_TIME,
  });
}
