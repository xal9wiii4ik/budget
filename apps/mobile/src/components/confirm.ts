// Native confirm helper (plan §E): Alert.alert with a two-button layout, plus an
// expo-haptics success notification on confirm (the key confirmation, agent UX
// baseline). Zero custom UI — native, accessible. `destructive` styles the confirm
// button red (delete / archive); a reversible action (unarchive) leaves it default.
import * as Haptics from 'expo-haptics';
import { Alert } from 'react-native';

interface ConfirmActionOptions {
  title: string;
  message: string;
  confirmLabel: string;
  /**
   * D-4: the cancel button used to be a hardcoded English word sitting in an
   * otherwise Russian dialog. It is a REQUIRED option rather than a defaulted one,
   * because this module has no access to the i18n context (it is called from
   * handlers, not rendered) and a default here could only be one language again —
   * every caller passes `t('common.cancel')`.
   */
  cancelLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}

export function confirmAction({
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive = false,
  onConfirm,
}: ConfirmActionOptions): void {
  Alert.alert(title, message, [
    { text: cancelLabel, style: 'cancel' },
    {
      text: confirmLabel,
      style: destructive ? 'destructive' : 'default',
      onPress: () => {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onConfirm();
      },
    },
  ]);
}
