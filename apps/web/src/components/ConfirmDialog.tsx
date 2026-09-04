import { useT } from '../i18n/context';
import { Button } from './Button';
import { Modal } from './Modal';
import styles from './ConfirmDialog.module.css';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  pendingLabel?: string;
  destructive?: boolean;
  isPending?: boolean;
  errorMessage?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Destructive-action confirmation (obligation C6) built on Modal. The parent owns
 * open state and the mutation; this dialog shows the pending spinner label and any
 * routed error, and never self-closes — it stays open until the parent unmounts it
 * on success.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  pendingLabel,
  destructive = false,
  isPending = false,
  errorMessage,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useT();
  return (
    <Modal title={title} onClose={isPending ? () => {} : onCancel} closeDisabled={isPending}>
      <p className={styles.message}>{message}</p>
      {errorMessage ? (
        <p className={styles.error} role="alert">
          {errorMessage}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={onCancel} disabled={isPending}>
          {t('common.cancel')}
        </Button>
        <Button
          variant={destructive ? 'danger' : 'primary'}
          onClick={onConfirm}
          disabled={isPending}
        >
          {isPending ? (pendingLabel ?? t('common.working')) : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
