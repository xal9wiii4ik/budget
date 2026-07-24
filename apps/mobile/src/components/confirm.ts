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
  destructive?: boolean;
  onConfirm: () => void;
}

export function confirmAction({
  title,
  message,
  confirmLabel,
  destructive = false,
  onConfirm,
}: ConfirmActionOptions): void {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
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
