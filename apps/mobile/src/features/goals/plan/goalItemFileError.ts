// What went wrong with a plan-item attachment, in words (mobile-catchup-3, line C).
//
// A copy of web's features/goals/plan/goalItemFileError.ts: the codes are the
// server's, but the COPY is a dictionary key, and the two clients' dictionaries
// are disjoint key sets — which is exactly why these sentences are not in
// @budget/shared's ERROR_MESSAGES on either side.
//
// Two families of failure meet here and both must end in a sentence the user can
// act on — a raw code on screen is not an explanation:
//   LOCAL  — refused before anything left the phone (a file too big, a denied
//            permission, an upload that never landed). There is no HTTP status to
//            read those off, hence the `PhotoFailure` union.
//   SERVER — the per-node cap, the archived goal, the confirm probe's three
//            outcomes (missing object / oversized object / storage down) and the
//            two no-oracle 404s.
import { ApiError, getErrorCode } from '@budget/api-client';
import type { Lang } from '@budget/shared';

import { networkMessage } from '../../../data/errors';
import type { Translate } from '../../../i18n/t';

/**
 * The server's per-node cap (`settings.goal_item_files_max_per_item`), mirrored
 * so the button can disappear at ten instead of offering a 422 — the same
 * interface-guard duplication `MAX_PLAN_DEPTH` makes for the depth limit.
 */
export const MAX_ITEM_FILES = 10;

/**
 * The server's byte ceiling (`settings.receipt_max_bytes`), mirrored for the same
 * reason: a photo is refused with a sentence before a slow mobile upload that
 * confirm would then reject.
 */
export const MAX_PHOTO_BYTES = 5_000_000;

/** A failure that never became a request. */
export type PhotoFailure = 'too-large' | 'upload-failed' | 'camera-denied' | 'library-denied';

export function photoFailureMessage(reason: PhotoFailure, t: Translate): string {
  switch (reason) {
    case 'too-large':
      return t('goalPhoto.tooLarge');
    case 'upload-failed':
      return t('goalPhoto.uploadFailed');
    case 'camera-denied':
      return t('photo.cameraDenied');
    case 'library-denied':
      return t('photo.libraryDenied');
  }
}

export function goalItemFileErrorMessage(error: unknown, t: Translate, lang: Lang): string {
  // Includes the raw PUT to storage: a rejected fetch is exactly "we could not
  // reach it", and storage answers XML rather than our {detail: CODE} envelope,
  // so there is never a code to read off that leg.
  if (!(error instanceof ApiError)) return networkMessage(lang);

  switch (getErrorCode(error.body)) {
    case 'GOAL_ITEM_FILES_LIMIT_EXCEEDED':
      return t('goalPhoto.limit', { max: MAX_ITEM_FILES });
    // The row is there, the bytes are not: the PUT never landed. The row stays
    // unconfirmed on purpose, so the tile it produces is deletable.
    case 'FILE_NOT_UPLOADED':
      return t('goalPhoto.notUploaded');
    case 'FILE_NOT_FOUND':
      return t('goalPhoto.fileGone');
    case 'IMAGE_TOO_LARGE':
      return t('goalPhoto.tooLarge');
    case 'STORAGE_UNAVAILABLE':
      return t('goalPhoto.storageUnavailable');
    // The screen hides every write affordance on an archived goal, so this takes
    // a stale screen — the copy still names the way out.
    case 'GOAL_ARCHIVED':
      return t('goalPhoto.archived');
    case 'GOAL_ITEM_NOT_FOUND':
      return t('goalPhoto.itemGone');
    case 'GOAL_NOT_FOUND':
      return t('goalPhoto.goalGone');
    default:
      return t('goalPhoto.generic');
  }
}
