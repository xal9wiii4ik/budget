import { zodResolver } from '@hookform/resolvers/zod';
import { registerFormSchema, type RegisterFormValues } from '@budget/shared';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';

import { AuthLayout } from '../auth/AuthLayout';
import styles from '../auth/AuthLayout.module.css';
import { Button } from '../components/Button';
import { Field, Input } from '../components/Field';
import { describeAuthError, RegisterLoginFailedError } from '../auth/errors';
import { safeNextPath } from '../auth/next';
import { useIsAuthenticated, useRegister } from '../auth/useAuth';
import { useT } from '../i18n/context';

export function RegisterPage() {
  const t = useT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const registerMutation = useRegister();
  const isAuthenticated = useIsAuthenticated();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(registerFormSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await registerMutation.mutateAsync(values);
      navigate(safeNextPath(searchParams.get('next')), { replace: true });
    } catch (error) {
      if (error instanceof RegisterLoginFailedError) {
        // Account exists — hand off to /login prefilled via location state (AM-8),
        // never re-register. Preserve the intended destination.
        const nextParam = searchParams.get('next');
        navigate(nextParam ? `/login?next=${encodeURIComponent(nextParam)}` : '/login', {
          replace: true,
          state: { email: error.email, notice: 'created' },
        });
        return;
      }
      const { level, messageKey } = describeAuthError(error);
      setError(level === 'form' ? 'root' : level, { message: t(messageKey) });
    }
  });

  const pending = isSubmitting || registerMutation.isPending;

  // A2: an already-authenticated visitor never sees the register form — bounce to
  // the intended destination (default /transactions via safeNextPath).
  if (isAuthenticated) {
    return <Navigate to={safeNextPath(searchParams.get('next'))} replace />;
  }

  return (
    <AuthLayout
      title={t('auth.createAccount')}
      subtitle={t('auth.createSubtitle')}
      footer={
        <>
          {t('auth.haveAccount')}{' '}
          <Link className={styles.link} to="/login">
            {t('auth.signIn')}
          </Link>
        </>
      }
    >
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {errors.root?.message ? (
          <p className={styles.formError} role="alert">
            {errors.root.message}
          </p>
        ) : null}

        <Field label={t('auth.email')} htmlFor="register-email" error={errors.email?.message}>
          <Input
            id="register-email"
            type="email"
            autoComplete="email"
            aria-invalid={errors.email ? true : undefined}
            {...register('email')}
          />
        </Field>

        <Field
          label={t('auth.password')}
          htmlFor="register-password"
          hint={t('auth.passwordHint')}
          hintId="register-password-hint"
          error={errors.password?.message}
        >
          <Input
            id="register-password"
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby="register-password-hint"
            {...register('password')}
          />
        </Field>

        <Button className={styles.submit} variant="primary" type="submit" disabled={pending}>
          {t(pending ? 'auth.creatingAccount' : 'auth.createAccount')}
        </Button>
      </form>
    </AuthLayout>
  );
}
