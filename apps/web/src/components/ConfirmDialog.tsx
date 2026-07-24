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
  return (
    <Modal title={title} onClose={isPending ? () => {} : onCancel} closeDisabled={isPending}>
      <p className={styles.message}>{message}</p>
      {errorMessage ? (
        <p className={styles.error} role="alert">
          {errorMessage}
        </p>
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.cancel}
          onClick={onCancel}
          disabled={isPending}
        >
          Cancel
        </button>
        <button
          type="button"
          className={destructive ? `${styles.confirm} ${styles.destructive}` : styles.confirm}
          onClick={onConfirm}
          disabled={isPending}
        >
          {isPending ? (pendingLabel ?? 'Working…') : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
