// A plan node's photos (mobile-catchup-3, line C) — the port of web's ItemPhotos
// + useItemPhotoUpload, on top of the receipts upload mechanism this client
// already has (data/receipts.ts `uploadToPresigned`).
//
// The list is fetched WHEN THE NODE IS OPENED and only then: the tree carries
// `files_count` precisely so a 500-node plan does not mint hundreds of presigned
// URLs. A node whose counter is 0 fetches nothing at all — there is nothing to
// list, and the affordance below does not need the answer to be drawn.
//
// The three legs, each able to fail on its own:
//   POST .../files              -> row + presigned PUT
//   PUT  <presigned url>        -> the picked image (RAW fetch, no bearer)
//   POST .../files/{id}/confirm -> the server HEADs the object and flips
//                                  `uploaded`; that flip is the ONLY thing that
//                                  can mint a `view_url`
// A retry restarts from the FIRST leg with the same picked asset: a reserved row
// whose object never arrived is one of the ten slots, and it is deletable.
//
// DELIBERATE GAP vs web: web downscales to 1500px with a canvas before measuring
// the bytes. This client has no `expo-image-manipulator` (adding a native module
// is not this scope's call), so it does what the shipped receipt attach does —
// the picker's own `quality: 0.6` re-encode plus the SAME 5 MB pre-check against
// the picked asset. An oversized original is therefore refused with a sentence
// instead of silently shrunk. Noted for follow-up.
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { confirmAction } from '../../../components/confirm';
import { FormButton } from '../../../components/FormButton';
import { colors, spacing, TOUCH_TARGET } from '../../../components/theme';
import {
  useConfirmGoalItemFile,
  useCreateGoalItemFile,
  useDeleteGoalItemFile,
  useGoalItemFiles,
} from '../../../data/goalItems';
import { uploadToPresigned } from '../../../data/receipts';
import { useLang, useT } from '../../../i18n/context';
import {
  goalItemFileErrorMessage,
  MAX_ITEM_FILES,
  MAX_PHOTO_BYTES,
  photoFailureMessage,
  type PhotoFailure,
} from './goalItemFileError';

interface ItemPhotosProps {
  goalId: string;
  itemId: string;
  /** The tree's counter — what gates the fetch. */
  filesCount: number;
  /** Archived goal: readable, nothing writable. */
  readOnly: boolean;
}

type Phase =
  | { status: 'idle' }
  | { status: 'busy' }
  // `message` is already translated; `retry` is null for the failures re-running
  // cannot fix (a denied permission, a file too large) — those get the Settings
  // link or nothing, never a button that would fail again identically.
  | { status: 'error'; message: string; retry: (() => void) | null };

export function ItemPhotos({ goalId, itemId, filesCount, readOnly }: ItemPhotosProps) {
  const t = useT();
  const lang = useLang();
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  // A view_url that expired (server-side GET presign TTL) or a file the device
  // cannot decode must never leave a broken image on screen.
  const [failedIds, setFailedIds] = useState<readonly string[]>([]);

  // The list is worth a request once something has been uploaded, or once THIS
  // session uploads something (the counter moves with the tree's invalidation).
  const files = useGoalItemFiles(goalId, itemId, filesCount > 0);
  const createFile = useCreateGoalItemFile(goalId);
  const confirmFile = useConfirmGoalItemFile(goalId);
  const deleteFile = useDeleteGoalItemFile(goalId);

  const rows = files.data ?? [];
  const atLimit = Math.max(filesCount, rows.length) >= MAX_ITEM_FILES;

  const fail = (reason: PhotoFailure, retry: (() => void) | null) =>
    setPhase({ status: 'error', message: photoFailureMessage(reason, t), retry });

  const upload = async (uri: string) => {
    setPhase({ status: 'busy' });
    try {
      const created = await createFile.mutateAsync({ itemId });
      const response = await fetch(uri);
      // `fetch(uri).blob()` is how a local file becomes a body in RN — there is
      // no Node-style stream here, and the presigned PUT wants the bytes.
      const blob = await response.blob();
      await uploadToPresigned(created.upload, blob);
      // Only the confirm can mint a view_url: without it the row stays a
      // reservation, visible and deletable, holding one of the ten slots.
      await confirmFile.mutateAsync({ itemId, fileId: created.id });
      setPhase({ status: 'idle' });
    } catch (error) {
      setPhase({
        status: 'error',
        message: goalItemFileErrorMessage(error, t, lang),
        retry: () => {
          void upload(uri);
        },
      });
    }
  };

  const pick = async (source: 'camera' | 'library') => {
    const permission =
      source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      // A denial is a state with a way out, not a dead end — and the way out is
      // the system Settings app, which nothing in this process can flip.
      fail(source === 'camera' ? 'camera-denied' : 'library-denied', null);
      return;
    }

    const result =
      source === 'camera'
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.6 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6 });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;

    // The server's own cap, checked here: learning after a slow mobile upload
    // that storage refused the file is the worst possible place to learn it.
    // `fileSize` is optional on the picker's contract — an unknown size is not
    // treated as a violation, the server still guards.
    if (asset.fileSize !== undefined && asset.fileSize > MAX_PHOTO_BYTES) {
      fail('too-large', null);
      return;
    }

    await upload(asset.uri);
  };

  const remove = (fileId: string) => {
    confirmAction({
      cancelLabel: t('common.cancel'),
      title: t('goalPhoto.deleteTitle'),
      message: t('goalPhoto.deleteMessage'),
      confirmLabel: t('common.delete'),
      destructive: true,
      onConfirm: () => {
        deleteFile.mutate(
          { itemId, fileId },
          {
            onError: (error) =>
              setPhase({
                status: 'error',
                message: goalItemFileErrorMessage(error, t, lang),
                retry: null,
              }),
          },
        );
      },
    });
  };

  const busy = phase.status === 'busy';

  return (
    <View style={styles.block}>
      <Text style={styles.title}>{t('goalPhoto.title')}</Text>

      {filesCount > 0 && files.isPending ? (
        <Text style={styles.muted}>{t('common.loading')}</Text>
      ) : null}
      {files.isError ? (
        <View style={styles.errorBox}>
          <Text accessibilityRole="alert" style={styles.error}>
            {t('goalPhoto.listFailed')}
          </Text>
          <FormButton
            label={t('common.retry')}
            variant="secondary"
            onPress={() => files.refetch()}
          />
        </View>
      ) : null}

      <View style={styles.tiles}>
        {rows.map((file) => {
          const broken = failedIds.includes(file.id);
          return (
            <View key={file.id} style={styles.tile}>
              {file.view_url !== null && !broken ? (
                <Image
                  accessibilityLabel={t('goalPhoto.alt')}
                  source={{ uri: file.view_url }}
                  style={styles.thumb}
                  onError={() => setFailedIds((ids) => [...ids, file.id])}
                />
              ) : (
                <View style={styles.placeholder}>
                  <Text style={styles.placeholderText}>
                    {/* An `uploaded: false` row is SHOWN, not hidden — it holds
                        one of the ten slots, and hiding it would make the limit
                        inexplicable. */}
                    {file.uploaded ? t('goalPhoto.expired') : t('goalPhoto.notUploadedTile')}
                  </Text>
                </View>
              )}
              <View style={styles.tileActions}>
                {broken ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      // A fresh list is a fresh presigned URL: the old one is not
                      // refreshable, it is re-signed.
                      setFailedIds((ids) => ids.filter((id) => id !== file.id));
                      void files.refetch();
                    }}
                    style={styles.tileAction}
                  >
                    <Text style={styles.tileActionText}>{t('common.retry')}</Text>
                  </Pressable>
                ) : null}
                {readOnly ? null : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: deleteFile.isPending }}
                    disabled={deleteFile.isPending}
                    onPress={() => remove(file.id)}
                    style={styles.tileAction}
                  >
                    <Text style={[styles.tileActionText, styles.destructive]}>
                      {t('common.delete')}
                    </Text>
                  </Pressable>
                )}
              </View>
            </View>
          );
        })}
      </View>

      {busy ? (
        <Text accessibilityRole="alert" style={styles.muted}>
          {t('photo.uploading')}
        </Text>
      ) : null}

      {phase.status === 'error' ? (
        <View style={styles.errorBox}>
          <Text accessibilityRole="alert" style={styles.error}>
            {phase.message}
          </Text>
          {phase.retry ? (
            <FormButton label={t('common.tryAgain')} variant="secondary" onPress={phase.retry} />
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void Linking.openSettings();
              }}
              style={styles.link}
            >
              <Text style={styles.linkText}>{t('photo.openSettings')}</Text>
            </Pressable>
          )}
        </View>
      ) : null}

      {readOnly || busy ? null : atLimit ? (
        // The cap, said instead of offered: a button here would collect a 422.
        <Text style={styles.muted}>{t('goalPhoto.limit', { max: MAX_ITEM_FILES })}</Text>
      ) : (
        <View style={styles.actions}>
          <FormButton
            label={t('photo.takePhoto')}
            variant="secondary"
            onPress={() => {
              void pick('camera');
            }}
            style={styles.action}
          />
          <FormButton
            label={t('photo.choosePhoto')}
            variant="secondary"
            onPress={() => {
              void pick('library');
            }}
            style={styles.action}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: spacing.sm,
    paddingTop: spacing.xs,
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  tile: {
    width: 110,
    gap: spacing.xs,
  },
  thumb: {
    width: 110,
    height: 110,
    borderRadius: 8,
    backgroundColor: colors.bg,
  },
  placeholder: {
    width: 110,
    height: 110,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xs,
  },
  placeholderText: {
    fontSize: 11,
    color: colors.textMuted,
    textAlign: 'center',
  },
  tileActions: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  tileAction: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  tileActionText: {
    fontSize: 13,
    color: colors.primary,
    fontWeight: '600',
  },
  destructive: {
    color: colors.danger,
  },
  muted: {
    fontSize: 12,
    color: colors.textMuted,
  },
  errorBox: {
    gap: spacing.sm,
  },
  error: {
    fontSize: 13,
    color: colors.danger,
  },
  link: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
  },
  linkText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.primary,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  action: {
    flex: 1,
  },
});
