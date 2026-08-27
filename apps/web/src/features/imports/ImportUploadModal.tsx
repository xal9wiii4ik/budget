import { useState } from 'react';
import { useNavigate } from 'react-router';

import { Modal } from '../../components/Modal';
import { QueryStateNotice } from '../../components/QueryStateNotice';
import type { AccountRead } from '../../data/accounts';
import { useStatementFormats, useUploadStatement } from '../../data/imports';
import { useLang, useT } from '../../i18n/context';
import { describeImportError, statementCurrencyMismatch } from '../../lib/errors';
import { queryPhase } from '../../lib/queryPhase';
import { selectableAccounts } from '../accounts/accountOptions';
import { statementFormatLabel } from './statementFormatLabel';
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
 *
 * The BANK picker (bank-format-from-server) offers exactly what the server's
 * parser registry reports; the format is never guessed from the file, because two
 * banks export `.csv` and only the server knows which layout it can read.
 */
export function ImportUploadModal({ accounts, onClose }: ImportUploadModalProps) {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const upload = useUploadStatement();
  const options = selectableAccounts(accounts, null);
  const [accountId, setAccountId] = useState('');
  const [file, setFile] = useState<File | null>(null);

  // The formats the server can parse. Server state, so it stays in the Query
  // cache and only the user's PICK is component state.
  const formatsQuery = useStatementFormats();
  const formats = formatsQuery.data ?? [];
  const formatsPhase = queryPhase(formatsQuery);
  const [pickedFormat, setPickedFormat] = useState<string | null>(null);
  // DERIVED at render, not synced by an effect: the pick if it is still on
  // offer, otherwise the registry's first entry. That is what preselects the
  // only format when there is one (no clicking through a one-item list) and the
  // first when there are several — and it also means a refetch that dropped the
  // picked format cannot leave the box pointing at something the server no
  // longer parses.
  const format =
    pickedFormat !== null && formats.includes(pickedFormat) ? pickedFormat : (formats[0] ?? '');
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
    if (format === '') {
      // Unreachable through the button (it is disabled without a format), but
      // the request must not be constructible without one either way.
      setLocalError(t('imports.pickFormatFirst'));
      return;
    }
    if (file === null) {
      setLocalError(t('imports.pickFileFirst'));
      return;
    }
    setLocalError(null);
    upload.mutate(
      { accountId, file, format },
      {
        onSuccess: (created) => {
          void navigate(`/imports/${created.id}`);
        },
      },
    );
  };

  // A format the server offers but this build has no copy for is shown BY ITS
  // ID: hiding it would make a working import unreachable (statementFormatLabel).
  const formatLabel = (id: string) => {
    const label = statementFormatLabel(id);
    return label.kind === 'known' ? t(label.labelKey) : label.label;
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

        {/* The label is rendered WITH the control it names: in the failed and
            empty arms there is no `#import-format` for it to point at, and a
            `for` aimed at nothing is worse than no label. */}
        {formatsPhase === 'error' || formatsPhase === 'unreachable' ? (
          <QueryStateNotice
            phase={formatsPhase}
            message={t('imports.formatsLoadFailed')}
            onRetry={() => {
              void formatsQuery.refetch();
            }}
            compact
          />
        ) : formats.length === 0 && formatsPhase === 'ready' ? (
          // A server with an empty registry: an empty disabled box would say
          // nothing, so the arm says what happened and what to do instead.
          <p className={styles.hint}>{t('imports.formatsEmpty')}</p>
        ) : (
          <>
            <label className={styles.label} htmlFor="import-format">
              {t('imports.uploadFormat')}
            </label>
            <select
              id="import-format"
              className={styles.select}
              value={format}
              // While the list is loading the control keeps its place and its
              // height (one placeholder option) instead of appearing later and
              // pushing the file input down.
              disabled={upload.isPending || formatsPhase === 'loading'}
              onChange={(event) => {
                setPickedFormat(event.target.value);
                resetOnChange();
              }}
            >
              {formatsPhase === 'loading' ? (
                <option value="">{t('imports.uploadFormatLoading')}</option>
              ) : null}
              {formats.map((id) => (
                <option key={id} value={id}>
                  {formatLabel(id)}
                </option>
              ))}
            </select>
            <p className={styles.hint}>{t('imports.uploadFormatHint')}</p>
          </>
        )}

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
            // No format, no upload: the request has a required `format` field and
            // there is nothing honest to put in it until the list has answered.
            disabled={upload.isPending || format === ''}
          >
            {upload.isPending ? t('imports.uploading') : t('imports.upload')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
