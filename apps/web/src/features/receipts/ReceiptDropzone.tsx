import { useRef, useState, type DragEvent } from 'react';

import { useT } from '../../i18n/context';
import styles from './ReceiptCaptureModal.module.css';

interface ReceiptDropzoneProps {
  onFile: (file: File) => void;
}

/**
 * Hand-rolled drop target + file picker — no dropzone library (the project has no
 * UI dependencies and this is ~40 lines).
 *
 * Accessibility: the interactive element is a real <button> that opens the hidden
 * <input type="file">, so keyboard and screen-reader users get the picker without
 * any of the drag-and-drop affordances (which are mouse-only by nature and are
 * therefore an enhancement, never the only path).
 */
export function ReceiptDropzone({ onFile }: ReceiptDropzoneProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    // One receipt per flow: extra dropped files are ignored rather than queued.
    const file = event.dataTransfer.files.item(0);
    if (file) onFile(file);
  };

  return (
    <div
      className={dragging ? `${styles.dropzone} ${styles.dropzoneActive}` : styles.dropzone}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <p className={styles.dropzoneText}>{t('receipt.dropText')}</p>
      <button type="button" className={styles.choose} onClick={() => inputRef.current?.click()}>
        {t('receipt.choosePhoto')}
      </button>
      {/* display:none, not visually-hidden: the button above is the accessible
          control, and a focusable hidden input would only add a dead tab stop. */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className={styles.fileInput}
        onChange={(event) => {
          const file = event.target.files?.item(0);
          // Clear the input so picking the SAME file again still fires a change
          // (a retry after a failed upload is exactly that case).
          event.target.value = '';
          if (file) onFile(file);
        }}
      />
      <p className={styles.dropzoneHint}>{t('receipt.shrinkHint')}</p>
    </div>
  );
}
