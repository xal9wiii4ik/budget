// What went wrong with an attachment, in words.
//
// Two families of failure meet here and both must end in a sentence the user can
// act on — a raw code on screen is not an explanation:
//
//   LOCAL   — refused before anything left the browser (not an image, a file too
//             big to even decode, an encode that failed). These are the reason
//             the flow has its own `PhotoFailure` union: there is no HTTP status
//             to read them off.
//   SERVER  — the codes of `routers/goal_item_files.py`: the per-node cap, the
//             archived goal, the confirm probe's three outcomes (missing object /
//             oversized object / storage down) and the two no-oracle 404s.
//
// The copy lives in the WEB dictionary rather than in `@budget/shared`'s
// ERROR_MESSAGES (which is the usual home for server-code copy) for one reason:
// mobile is frozen and has no attachment client, so there is no second consumer —
// the same call the `tokenFormSchema` scope made. This module takes `t` and stays
// otherwise language-free (the `periodicityLabel` precedent).
import { getErrorCode } from '@budget/api-client';
import type { Lang } from '@budget/shared';

import type { Translate } from '../../../i18n/t';
import { networkMessage } from '../../../lib/errors';
import { ApiError } from '../../../lib/query';

/**
 * The server's per-node cap (`settings.goal_item_files_max_per_item`), mirrored
 * so the button can disappear at ten instead of offering a 422 — the same
 * interface-guard duplication `MAX_PLAN_DEPTH` makes for the depth limit.
 */
export const MAX_ITEM_FILES = 10;

/**
 * The server's byte ceiling (`settings.receipt_max_bytes`), mirrored for the
 * same reason: it is checked against the DOWNSCALED blob, so a photo is refused
 * with a sentence before an object is uploaded that confirm would then reject.
 */
export const MAX_PHOTO_BYTES = 5_000_000;

/** A failure that never became a request. */
export type PhotoFailure =
  | 'not-an-image'
  | 'source-too-large'
  | 'too-large'
  | 'prepare-failed'
  | 'upload-failed';

export function photoFailureMessage(reason: PhotoFailure, t: Translate): string {
  switch (reason) {
    case 'not-an-image':
      return t('goalPlan.photoError.notAnImage');
    case 'source-too-large':
    case 'too-large':
      return t('goalPlan.photoError.tooLarge');
    case 'prepare-failed':
      return t('goalPlan.photoError.prepareFailed');
    case 'upload-failed':
      return t('goalPlan.photoError.uploadFailed');
  }
}

export function goalItemFileErrorMessage(error: unknown, t: Translate, lang: Lang): string {
  // Includes the raw PUT to storage: a rejected fetch is exactly "we could not
  // reach it", and storage answers XML rather than our {detail: CODE} envelope,
  // so there is never a code to read off that leg.
  if (!(error instanceof ApiError)) return networkMessage(lang);

  switch (getErrorCode(error.body)) {
    case 'GOAL_ITEM_FILES_LIMIT_EXCEEDED':
      return t('goalPlan.photoError.limit', { max: MAX_ITEM_FILES });
    // The row is there, the bytes are not: the PUT never landed. The row stays
    // unconfirmed on purpose, so the tile it produces is deletable.
    case 'FILE_NOT_UPLOADED':
      return t('goalPlan.photoError.notUploaded');
    case 'FILE_NOT_FOUND':
      return t('goalPlan.photoError.fileGone');
    case 'IMAGE_TOO_LARGE':
      return t('goalPlan.photoError.tooLarge');
    case 'STORAGE_UNAVAILABLE':
      return t('goalPlan.photoError.storageUnavailable');
    // The screen hides every write affordance on an archived goal, so this takes
    // a stale tab — the copy still names the way out.
    case 'GOAL_ARCHIVED':
      return t('goalPlan.photoError.archived');
    case 'GOAL_ITEM_NOT_FOUND':
      return t('goalPlan.photoError.itemGone');
    case 'GOAL_NOT_FOUND':
      return t('goalPlan.photoError.goalGone');
    default:
      return t('goalPlan.photoError.generic');
  }
}
