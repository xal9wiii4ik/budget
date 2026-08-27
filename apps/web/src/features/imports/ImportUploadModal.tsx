import { useState } from 'react';
import { useNavigate } from 'react-router';

import { Modal } from '../../components/Modal';
import type { AccountRead } from '../../data/accounts';
import { useUploadStatement } from '../../data/imports';
import { useLang, useT } from '../../i18n/context';
import { describeImportError, statementCurrencyMismatch } from '../../lib/errors';
import { selectableAccounts } from '../accounts/accountOptions';
import styles from './ImportUploadModal.module.css';

interface ImportUploadModalProps {
  accounts: AccountRead[];
  onClose: () => void;
}

/**
 * The entry to the whole flow: pick the account, pick the file, upload.
 *
 * Deliberately NOT react-hook-form + a shared zod schema, unlike every money
 * form in this app: there is no shared schema to reuse (mobile has no statement
 * client, and `File` is not a value a cross-platform schema can describe), and
 * the two "rules" here are "an account is selected" and "a file is selected" —
 * which the two controls answer by themselves. The receipts capture modal is the
 * same shape for the same reason.
 *
 * The file is handed to the mutation as bytes. Nothing is read, decoded or
 * validated in the browser: the statement is cp1251 and the parser that
 * understands it lives on the server, so a client-side "is this a statement?"
 * check could only be a worse copy of the 422 the server already gives.
 */
export function ImportUploadModal({ accounts, onClose }: ImportUploadModalProps) {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const upload = useUploadStatement();
  const options = selectableAccounts(accounts, null);
  const [accountId, setAccountId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  // Only for the two "you have not chosen yet" cases; every other message on
  // this screen comes from the server.
  const [localError, setLocalError] = useState<string | null>(null);

  // A refusal describes the account/file that WAS sent; the moment either
  // changes it is about nothing, so it is dropped rather than left on screen
  // next to the new choice.
  const resetOnChange = () => {
    setLocalError(null);
    if (upload.error !== null) upload.reset();
  };

  const failure = upload.error === null ? null : describeImportError(upload.error, lang);
  // The refusal that is unusable without its facts (§10.7): when the server named
  // both currencies, the message names them too.
  const mismatch =
    failure?.code === 'STATEMENT_CURRENCY_MISMATCH'
      ? statementCurrencyMismatch(upload.error)
      : null;
  const message =
    mismatch !== null
      ? t('imports.currencyMismatchNamed', {
          statement: mismatch.statementCurrency,
          account: mismatch.accountCurrency,
        })
      : (localError ?? failure?.message);

  const submit = () => {
    if (accountId === '') {
      setLocalError(t('imports.pickAccountFirst'));
      return;
    }
    if (file === null) {
      setLocalError(t('imports.pickFileFirst'));
      return;
    }
    setLocalError(null);
    upload.mutate(
      { accountId, file },
      {
        onSuccess: (created) => {
          void navigate(`/imports/${created.id}`);
        },
      },
    );
  };

  return (
    <Modal
      title={t('imports.uploadTitle')}
      onClose={onClose}
      closeDisabled={upload.isPending}
    >
      <div className={styles.panel}>
        <p className={styles.lede}>{t('imports.uploadLede')}</p>

        <label className={styles.label} htmlFor="import-account">
          {t('imports.uploadAccount')}
        </label>
        <select
          id="import-account"
          className={styles.select}
          value={accountId}
          disabled={upload.isPending}
          onChange={(event) => {
            setAccountId(event.target.value);
            resetOnChange();
          }}
        >
          <option value="">{t('accounts.choose')}</option>
          {options.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name} · {account.currency}
            </option>
          ))}
        </select>
        <p className={styles.hint}>{t('imports.uploadAccountHint')}</p>

        <div className={styles.file}>
          {/* A real labelled input, not a button opening a hidden one: a CSV
              comes off a disk, so there is no camera affordance to hide it
              behind, and the native control already announces the chosen file. */}
          <label className={styles.label} htmlFor="import-file">
            {t('imports.uploadFile')}
          </label>
          <input
            id="import-file"
            type="file"
            accept=".csv,text/csv"
            className={styles.fileInput}
            disabled={upload.isPending}
            onChange={(event) => {
              setFile(event.target.files?.item(0) ?? null);
              resetOnChange();
            }}
          />
        </div>

        {message !== undefined && message !== null ? (
          <p className={styles.error} role="alert">
            {message}
          </p>
        ) : null}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.cancel}
            onClick={onClose}
            disabled={upload.isPending}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={styles.submit}
            onClick={submit}
            disabled={upload.isPending}
          >
            {upload.isPending ? t('imports.uploading') : t('imports.upload')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
