import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '../../components/Button';
import { Input } from '../../components/Field';
import { useT } from '../../i18n/context';
import { apiClient } from '../../lib/api';
import { throwOnError } from '../../lib/query';
import styles from './SettingsSections.module.css';

// The server's own rule (auth.py MIN_PASSWORD_LENGTH = 8, the same one register
// enforces); repeated here only so a short password is refused before a request.
const passwordSchema = z.object({ password: z.string().min(8) });
type PasswordValues = z.infer<typeof passwordSchema>;

/**
 * Change the sign-in password: one field, then PATCH /users/me.
 *
 * DELIBERATELY minimal for now (the user's call, with a follow-up card to harden
 * it): no current-password check and no e-mail confirmation — anyone holding an
 * open session can set a new password. What it does NOT do either: end the other
 * sessions. A signed-in browser elsewhere stays signed in until its token expires,
 * and the success line says so rather than implying a sign-out everywhere.
 *
 * A show/hide toggle instead of a "repeat password" field: it guards the typo that
 * would lock the user out again, without a second confirmation step.
 */
export function PasswordSection() {
  const t = useT();
  const [visible, setVisible] = useState(false);
  const [done, setDone] = useState(false);
  const change = useMutation({
    mutationFn: (password: string) =>
      throwOnError(apiClient.PATCH('/users/me', { body: { password } })),
  });
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { password: '' },
  });

  const onSubmit = handleSubmit(async ({ password }) => {
    setDone(false);
    try {
      await change.mutateAsync(password);
      reset({ password: '' });
      setVisible(false);
      setDone(true);
    } catch {
      // The message is rendered from `change.isError` below; nothing else to do.
    }
  });

  return (
    <section className={styles.section} id="settings-password">
      <h2 className={styles.title}>{t('settings.password.title')}</h2>
      <p className={styles.lede}>{t('settings.password.lede')}</p>

      <form onSubmit={onSubmit} noValidate>
        <div className={styles.row}>
          <label className={styles.label} htmlFor="settings-password-input">
            {t('settings.password.label')}
          </label>
          <Input
            id="settings-password-input"
            type={visible ? 'text' : 'password'}
            autoComplete="new-password"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby="settings-password-hint"
            {...register('password', { onChange: () => setDone(false) })}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={visible}
            onClick={() => setVisible((shown) => !shown)}
          >
            {t(visible ? 'settings.password.hide' : 'settings.password.show')}
          </Button>
          <Button type="submit" variant="primary" loading={change.isPending}>
            {t('settings.password.submit')}
          </Button>
        </div>
        <p className={styles.note} id="settings-password-hint">
          {t('auth.passwordHint')}
        </p>
        {errors.password ? (
          <p className={styles.error} role="alert">
            {t('auth.passwordHint')}
          </p>
        ) : null}
        {change.isError ? (
          <p className={styles.error} role="alert">
            {t('settings.password.failed')}
          </p>
        ) : null}
        {done ? (
          <p className={styles.status} role="status">
            {t('settings.password.done')}
          </p>
        ) : null}
      </form>
    </section>
  );
}
