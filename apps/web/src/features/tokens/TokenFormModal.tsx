import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Modal } from '../../components/Modal';
import { useCreateToken } from '../../data/tokens';
import { useLang, useT } from '../../i18n/context';
import { describeTokenError } from '../../lib/errors';
import { TokenCreatedPanel } from './TokenCreatedPanel';
import { NAME_MAX, tokenFormSchema, type TokenFormValues } from './tokenFormSchema';
import styles from './TokenFormModal.module.css';

interface TokenFormModalProps {
  onClose: () => void;
}

const EMPTY_VALUES: TokenFormValues = { name: '', scope: 'read' };

/**
 * Create-token modal, in two acts inside ONE dialog: the form, then the
 * one-time plaintext panel.
 *
 * The plaintext lives in this component's state and nowhere else — not in the
 * Query cache (see data/tokens.ts), not in the URL, not in storage. Unmounting
 * this modal is what destroys it, which is why the second act takes over the
 * dialog's close channels: with the panel up, Esc / backdrop / × do nothing and
 * the panel's own "Done" is the single, deliberate way out (the shipped
 * ConfirmDialog technique — a dialog that must not close neutralizes its own
 * `onClose` and disables the ×).
 */
export function TokenFormModal({ onClose }: TokenFormModalProps) {
  const lang = useLang();
  const t = useT();
  const createToken = useCreateToken();
  // The single copy of the plaintext, for as long as this modal is mounted.
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<TokenFormValues>({
    resolver: zodResolver(tokenFormSchema(t)),
    defaultValues: EMPTY_VALUES,
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const result = await createToken.mutateAsync({
        name: values.name,
        scope: values.scope,
      });
      setCreated({ token: result.token, name: result.name });
      // TanStack keeps a mutation's `data` in the MutationCache until gc — which
      // would leave a second copy of the plaintext in the query client, exactly
      // the thing data/tokens.ts refuses to do. `reset()` drops it, so the only
      // copy left is the `created` state above.
      createToken.reset();
    } catch (error) {
      const { field, message } = describeTokenError(error, lang);
      setError(field === 'form' ? 'root' : field, { message });
    }
  });

  if (created) {
    return (
      <Modal title={t('tokenForm.createdTitle')} onClose={() => {}} closeDisabled>
        <TokenCreatedPanel token={created.token} name={created.name} onDone={onClose} />
      </Modal>
    );
  }

  const pending = isSubmitting || createToken.isPending;

  return (
    <Modal
      title={t('tokens.new')}
      // An in-flight create must not be abandoned: the response would carry a
      // plaintext with nowhere to go, and the user would own a token whose string
      // can never be seen again. `closeDisabled` alone does NOT stop Esc or a
      // backdrop click (it only disables the × and, by design, skips the discard
      // prompt), so the close callback is neutralized too — the ConfirmDialog
      // technique.
      onClose={pending ? () => {} : onClose}
      isDirty={isDirty}
      closeDisabled={pending}
    >
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {errors.root?.message ? (
          <p className={styles.formError} role="alert">
            {errors.root.message}
          </p>
        ) : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="token-name">
            {t('common.name')}
          </label>
          <input
            id="token-name"
            className={errors.name ? `${styles.input} ${styles.inputError}` : styles.input}
            maxLength={NAME_MAX}
            placeholder={t('tokenForm.namePlaceholder')}
            aria-invalid={errors.name ? true : undefined}
            {...register('name')}
          />
          <p className={styles.hint}>{t('tokenForm.nameHint')}</p>
          {errors.name?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.name.message}
            </p>
          ) : null}
        </div>

        <fieldset className={styles.field}>
          <legend className={styles.label}>{t('tokenForm.scopeLegend')}</legend>
          {/* Plain language on purpose: this is the screen where a user hands an
              outside program access to their money data, and "read/full scope"
              tells them nothing about what they are agreeing to. */}
          <div className={styles.scopeGroup}>
            <label className={styles.scopeOption}>
              <input type="radio" value="read" {...register('scope')} />
              <span className={styles.scopeText}>
                <span className={styles.scopeTitle}>{t('tokens.scopeRead')}</span>
                <span className={styles.scopeBody}>{t('tokenForm.scopeReadBody')}</span>
              </span>
            </label>
            <label className={styles.scopeOption}>
              <input type="radio" value="full" {...register('scope')} />
              <span className={styles.scopeText}>
                <span className={styles.scopeTitle}>{t('tokens.scopeFull')}</span>
                <span className={styles.scopeBody}>{t('tokenForm.scopeFullBody')}</span>
              </span>
            </label>
          </div>
          {errors.scope?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.scope.message}
            </p>
          ) : null}
        </fieldset>

        <div className={styles.actions}>
          <span className={styles.spacer} />
          <button type="submit" className={styles.submit} disabled={pending}>
            {t(pending ? 'tokenForm.creating' : 'tokenForm.create')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
