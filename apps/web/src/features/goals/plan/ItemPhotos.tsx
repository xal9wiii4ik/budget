import { useRef, useState } from 'react';

import { Button } from '../../../components/Button';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { QueryStateNotice } from '../../../components/QueryStateNotice';
import { useDeleteGoalItemFile, useGoalItemFiles } from '../../../data/goalItems';
import { useLang, useT } from '../../../i18n/context';
import { queryPhase } from '../../../lib/queryPhase';
import { MAX_ITEM_FILES, goalItemFileErrorMessage } from './goalItemFileError';
import { useItemPhotoUpload } from './useItemPhotoUpload';
import styles from './ItemPhotos.module.css';

interface ItemPhotosProps {
  goalId: string;
  itemId: string;
  /** Archived goal: the photos stay readable, every write affordance is gone. */
  readOnly: boolean;
}

/**
 * The photos attached to one plan node — a ticket, a booking, a screenshot of a
 * price.
 *
 * The list is fetched WHEN THE NODE IS OPENED, never with the tree: `view_url`
 * is a presigned GET that the server mints per row, and minting one for every
 * node of a 500-item plan on every tree read is exactly what the tree's
 * `files_count` counter exists to avoid. It is also short-lived, which is the
 * second reason this query is not cached hard — and the reason a thumbnail can
 * go stale under a panel that has been open for a while. That case has its own
 * arm (`broken` below): a placeholder plus a refresh, never a screen of broken
 * image icons.
 *
 * A row with `uploaded: false` is a reservation whose bytes never landed. It is
 * shown, not hidden: it occupies one of the node's ten slots, so the user needs
 * to see it to delete it.
 */
export function ItemPhotos({ goalId, itemId, readOnly }: ItemPhotosProps) {
  const t = useT();
  const lang = useLang();
  const filesQuery = useGoalItemFiles(goalId, itemId);
  const upload = useItemPhotoUpload(goalId, itemId);
  const deleteFile = useDeleteGoalItemFile(goalId);
  const inputRef = useRef<HTMLInputElement>(null);
  // Thumbnails whose signed URL did not load. Cleared wholesale by a refresh,
  // which is the only thing that can produce fresh URLs.
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  const phase = queryPhase(filesQuery);
  const files = filesQuery.data ?? [];
  // The row being uploaded right now is already in the cache (the reservation
  // invalidates the family), and the progress tile below speaks for it — drawing
  // both would show one photo twice.
  const inFlightId = upload.state.status === 'busy' ? upload.state.fileId : null;
  const visible = files.filter((file) => file.id !== inFlightId);
  const atLimit = files.length >= MAX_ITEM_FILES;

  const refresh = () => {
    setBroken(new Set());
    void filesQuery.refetch();
  };

  const confirmDelete = async (fileId: string) => {
    setDeleteError(undefined);
    try {
      await deleteFile.mutateAsync({ itemId, fileId });
      setConfirmingId(null);
    } catch (error) {
      setDeleteError(goalItemFileErrorMessage(error, t, lang));
    }
  };

  return (
    <div className={styles.photos}>
      <p className={styles.title}>{t('goalPlan.photosTitle')}</p>

      {phase === 'loading' ? (
        <ul className={styles.grid} aria-hidden="true">
          <li className={styles.skeleton} />
          <li className={styles.skeleton} />
        </ul>
      ) : phase === 'error' || phase === 'unreachable' ? (
        <QueryStateNotice
          phase={phase}
          message={t('goalPlan.photosLoadFailed')}
          onRetry={() => void filesQuery.refetch()}
          compact
        />
      ) : (
        <ul className={styles.grid}>
          {visible.map((file, index) => (
            <li key={file.id} className={styles.tile}>
              {file.uploaded && file.view_url !== null && !broken.has(file.id) ? (
                <a
                  className={styles.thumbLink}
                  href={file.view_url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <img
                    className={styles.thumb}
                    src={file.view_url}
                    alt={t('goalPlan.photoAlt', { index: index + 1 })}
                    loading="lazy"
                    onError={() =>
                      setBroken((current) => new Set(current).add(file.id))
                    }
                  />
                </a>
              ) : (
                <div className={styles.placeholder}>
                  <span className={styles.placeholderText}>
                    {file.uploaded
                      ? t('goalPlan.photoUnavailable')
                      : t('goalPlan.photoUnfinished')}
                  </span>
                  {file.uploaded ? (
                    <button type="button" className={styles.linkButton} onClick={refresh}>
                      {t('goalPlan.photoRefresh')}
                    </button>
                  ) : null}
                </div>
              )}
              {readOnly ? null : (
                <button
                  type="button"
                  className={styles.remove}
                  // The visible word is the same on every tile, so the accessible
                  // name says WHICH photo it deletes.
                  aria-label={t('goalPlan.photoDeleteAria', { index: index + 1 })}
                  onClick={() => {
                    setDeleteError(undefined);
                    setConfirmingId(file.id);
                  }}
                >
                  {t('common.delete')}
                </button>
              )}
            </li>
          ))}

          {upload.state.status === 'busy' ? (
            <li className={`${styles.tile} ${styles.busy}`} role="status">
              <span className={styles.placeholderText}>
                {upload.state.step === 'preparing'
                  ? t('goalPlan.photoPreparing')
                  : upload.state.step === 'uploading'
                    ? t('goalPlan.photoUploading')
                    : t('goalPlan.photoConfirming')}
              </span>
            </li>
          ) : null}
        </ul>
      )}

      {phase === 'ready' && visible.length === 0 && upload.state.status !== 'busy' ? (
        <p className={styles.empty}>
          {readOnly
            ? t('goalPlan.photosEmptyReadOnly')
            : t('goalPlan.photosEmpty', { max: MAX_ITEM_FILES })}
        </p>
      ) : null}

      {upload.state.status === 'error' ? (
        <p className={styles.error} role="alert">
          {upload.state.message}{' '}
          <button type="button" className={styles.linkButton} onClick={upload.clearError}>
            {t('goalPlan.photoDismiss')}
          </button>
        </p>
      ) : null}

      {readOnly ? null : atLimit ? (
        <p className={styles.limit}>{t('goalPlan.photosAtLimit', { max: MAX_ITEM_FILES })}</p>
      ) : (
        <div className={styles.addRow}>
          <Button
            size="sm"
            onClick={() => inputRef.current?.click()}
            disabled={upload.state.status === 'busy'}
          >
            {t('goalPlan.photoAdd')}
          </Button>
          <span className={styles.hint}>
            {t('goalPlan.photosLeft', { count: MAX_ITEM_FILES - files.length })}
          </span>
          {/* display:none, not visually-hidden: the button above is the
              accessible control, and a focusable hidden input would only add a
              dead tab stop (the receipts dropzone precedent). */}
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className={styles.fileInput}
            onChange={(event) => {
              const file = event.target.files?.item(0);
              // Clear the input so picking the SAME file again still fires a
              // change — retrying after a failed upload is exactly that case.
              event.target.value = '';
              if (file) upload.start(file);
            }}
          />
        </div>
      )}

      {confirmingId !== null ? (
        <ConfirmDialog
          title={t('goalPlan.photoDeleteTitle')}
          message={t('goalPlan.photoDeleteMessage')}
          confirmLabel={t('common.delete')}
          pendingLabel={t('common.deleting')}
          destructive
          isPending={deleteFile.isPending}
          errorMessage={deleteError}
          onConfirm={() => void confirmDelete(confirmingId)}
          onCancel={() => setConfirmingId(null)}
        />
      ) : null}
    </div>
  );
}
