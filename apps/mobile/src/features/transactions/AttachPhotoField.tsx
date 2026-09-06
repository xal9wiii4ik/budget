// "Attach a photo" inside the transaction form (mobile-catchup-2).
//
// The one thing this control must never do is drag AI into a photo. Attaching and
// READING are separate features: the presign has no AI gate, and this field stops
// at the upload — it never calls `/receipts/{id}/parse`. On a server with no AI
// key it works exactly the same, with no 503 anywhere.
//
// Three steps, in order, and each one can fail on its own:
//   1. pick        — expo-image-picker (camera or library), permission first;
//   2. create      — POST /receipts, which answers with the presigned PUT;
//   3. upload      — a RAW fetch straight to object storage (data/receipts.ts).
// The retry restarts from step 2 with the SAME picked asset, because that is the
// step that failed on a flaky network — re-opening the camera would be a punishment.
//
// The state is a small union in this component rather than a reducer or a hook:
// four states, three transitions, all owned by two handlers.
//
// Showing the photo BACK is where the server is currently short: `view_url` is
// non-null only for a receipt whose upload the server considers proven
// (processing/parsed/failed), and nothing here can prove it — there is no
// upload-confirm endpoint for receipts, so a photo attached from this screen
// stays `pending` and reads back with `view_url: null` forever. Hence the same
// shape as web: the picked asset's LOCAL uri is the preview for this session,
// `view_url` covers the receipts that were scanned on the web, and only with
// neither does the field fall back to a text line. Follow-up (not this scope):
// a receipts upload-confirm endpoint would make `view_url` real for everyone.
//
// Detaching removes the LINK only. The stored file is not deleted — there is no
// delete endpoint and this scope adds none — so the copy says the photo stays
// with the operation and this only unlinks it. It asks first, through the NATIVE
// confirm the form's Delete uses: the inline confirm this field had before opened
// under the pinned footer, so its buttons were unreachable at the offset from
// which Remove itself was tapped (mobile-QA D-2). An Alert cannot be covered.
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Image, Linking, Text, View } from 'react-native';

import { confirmAction } from '../../components/confirm';
import { FormButton } from '../../components/FormButton';
import { themedStyles } from '../../theme/themedStyles';
import {
  RECEIPT_MAX_BYTES,
  useCreateReceipt,
  uploadToPresigned,
  useReceipt,
} from '../../data/receipts';
import { useT } from '../../i18n/context';

type Phase =
  | { status: 'idle' }
  | { status: 'busy'; step: 'creating' | 'uploading' }
  // `message` is already translated, chosen where the failure happened; `retry`
  // is null for the failures that re-running the upload cannot fix (a denied
  // permission, a file that is too large) — those get the Settings link or
  // nothing, never a button that would fail again identically.
  | { status: 'error'; message: string; retry: (() => void) | null };

interface AttachPhotoFieldProps {
  /** The receipt this operation is linked to, or null. Owned by the form. */
  receiptId: string | null;
  onChange: (receiptId: string | null) => void;
  /** True while the transaction is being saved — no re-linking mid-flight. */
  disabled?: boolean;
}

export function AttachPhotoField({
  receiptId,
  onChange,
  disabled = false,
}: AttachPhotoFieldProps) {
  const t = useT();
  const styles = useStyles();
  const createReceipt = useCreateReceipt();
  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  // The attached receipt's own row. Its `view_url` is a per-read presigned GET
  // (TTL 300 s), and it is non-null only once the upload is proven — i.e. for a
  // receipt scanned on the web. An error here is not the user's problem: the
  // link is stored on the transaction either way, so it degrades to the plain
  // "photo attached" line.
  const receipt = useReceipt(receiptId);
  // The picked asset, kept as the in-session preview: for a photo attached here
  // it is the ONLY thing that can be rendered (see the note at the top). Set on
  // a successful upload, so a failed replace leaves the previous one on screen.
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  // A view_url that 403s (expired) or a device that cannot decode the file must
  // NEVER leave a broken image on screen; one failed load switches to the text.
  const [imageFailed, setImageFailed] = useState(false);

  // Steps 2-3. Kept separate from the picking so the retry can re-run exactly
  // this much with the asset already in hand.
  const upload = async (uri: string) => {
    setPhase({ status: 'busy', step: 'creating' });
    try {
      const created = await createReceipt.mutateAsync();
      setPhase({ status: 'busy', step: 'uploading' });
      // `fetch(uri).blob()` is how a local file becomes a body in RN — there is
      // no Node-style stream here, and the presigned PUT wants the bytes.
      const response = await fetch(uri);
      const blob = await response.blob();
      await uploadToPresigned(created.upload, blob);
      setLocalPreview(uri);
      setImageFailed(false);
      setPhase({ status: 'idle' });
      // Only NOW is the row worth linking: a receipt id whose object never
      // arrived would be a link to nothing.
      onChange(created.id);
    } catch {
      setPhase({
        status: 'error',
        message: t('photo.uploadFailed'),
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
      // in the system Settings app, which nothing in this process can flip.
      setPhase({
        status: 'error',
        message: t(source === 'camera' ? 'photo.cameraDenied' : 'photo.libraryDenied'),
        retry: null,
      });
      return;
    }

    const result =
      source === 'camera'
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.6 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6 });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;

    // The server's own cap (`receipt_max_bytes`), checked here: finding out after
    // a slow mobile upload that storage refused the file is the worst possible
    // place to learn it. `fileSize` is optional on the contract of the picker —
    // an unknown size is not treated as a violation, the server still guards.
    if (asset.fileSize !== undefined && asset.fileSize > RECEIPT_MAX_BYTES) {
      setPhase({ status: 'error', message: t('photo.tooLarge'), retry: null });
      return;
    }

    await upload(asset.uri);
  };

  const removePhoto = () => {
    confirmAction({
      cancelLabel: t('common.cancel'),
      title: t('photo.removeTitle'),
      message: t('photo.removeQuestion'),
      confirmLabel: t('common.remove'),
      destructive: true,
      onConfirm: () => {
        setLocalPreview(null);
        setImageFailed(false);
        setPhase({ status: 'idle' });
        onChange(null);
      },
    });
  };

  const busy = phase.status === 'busy';
  // Local first: it is the freshest, needs no network and never expires. The
  // presigned view_url is the fallback for a receipt this session did not pick.
  const shownUri = localPreview ?? receipt.data?.view_url ?? null;
  const showsImage = shownUri !== null && !imageFailed;

  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        {t('photo.label')} <Text style={styles.hint}>{t('common.optional')}</Text>
      </Text>

      {receiptId !== null ? (
        <View style={styles.attached}>
          {showsImage ? (
            <Image
              accessibilityLabel={t('photo.alt')}
              source={{ uri: shownUri }}
              style={styles.thumb}
              onError={() => setImageFailed(true)}
            />
          ) : null}
          <Text style={styles.attachedTitle}>{t('photo.attached')}</Text>
          <Text style={styles.hint}>
            {receipt.isError
              ? t('photo.detailsFailed')
              : showsImage
                ? t('photo.stays')
                : // The row (and with it a possible view_url) is still on its way;
                  // "cannot be shown yet" would be premature while it loads.
                  receipt.isPending
                  ? t('common.loading')
                  : t('photo.unavailable')}
          </Text>
          <FormButton
            label={t('common.remove')}
            variant="secondary"
            onPress={removePhoto}
            disabled={disabled || busy}
          />
        </View>
      ) : null}

      {busy ? (
        <Text accessibilityRole="alert" style={styles.progress}>
          {phase.step === 'creating' ? t('photo.gettingReady') : t('photo.uploading')}
        </Text>
      ) : null}

      {phase.status === 'error' ? (
        <View style={styles.errorBox}>
          <Text accessibilityRole="alert" style={styles.error}>
            {phase.message}
          </Text>
          {phase.retry ? (
            <FormButton
              label={t('common.tryAgain')}
              variant="secondary"
              onPress={phase.retry}
            />
          ) : (
            // Only for the permission arm: nothing in the app can grant it.
            <FormButton
              label={t('photo.openSettings')}
              variant="ghost"
              onPress={() => {
                void Linking.openSettings();
              }}
              style={styles.settingsLink}
            />
          )}
        </View>
      ) : null}

      {!busy ? (
        <View style={styles.actions}>
          <FormButton
            label={t('photo.takePhoto')}
            variant="secondary"
            onPress={() => {
              void pick('camera');
            }}
            disabled={disabled}
            style={styles.action}
          />
          <FormButton
            label={t(receiptId === null ? 'photo.choosePhoto' : 'photo.replace')}
            variant="secondary"
            onPress={() => {
              void pick('library');
            }}
            disabled={disabled}
            style={styles.action}
          />
        </View>
      ) : null}
    </View>
  );
}

const useStyles = themedStyles((t) => ({
  field: {
    gap: t.spacing.sm,
  },
  label: {
    fontSize: t.type.sm,
    fontWeight: '600',
    color: t.colors.text,
  },
  hint: {
    fontSize: t.type.xs,
    fontWeight: '400',
    color: t.colors.textMuted,
  },
  attached: {
    gap: t.spacing.sm,
    padding: t.spacing.md,
    borderRadius: t.radius.md,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
  },
  attachedTitle: {
    fontSize: t.type.md,
    fontWeight: '600',
    color: t.colors.text,
  },
  thumb: {
    width: '100%',
    height: 180,
    borderRadius: t.radius.sm,
    // The tone BEHIND a photo that has not decoded yet — a muted surface, not the
    // screen background, so the frame reads as a placeholder.
    backgroundColor: t.colors.surfaceMuted,
  },
  progress: {
    fontSize: t.type.sm,
    color: t.colors.textMuted,
  },
  errorBox: {
    gap: t.spacing.sm,
  },
  error: {
    fontSize: t.type.sm,
    color: t.colors.danger,
  },
  // A ghost button already carries the accent label and the >= 44pt target the
  // hand-rolled link used to declare; only the left edge has to come back.
  settingsLink: {
    alignSelf: 'flex-start',
    paddingHorizontal: 0,
  },
  actions: {
    flexDirection: 'row',
    gap: t.spacing.sm,
  },
  action: {
    flex: 1,
  },
}));
