import { zodResolver } from '@hookform/resolvers/zod';
import { loginFormSchema, type LoginFormValues } from '@budget/shared';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';

import { AuthLayout } from '../auth/AuthLayout';
import styles from '../auth/AuthLayout.module.css';
import { describeAuthError } from '../auth/errors';
import { safeNextPath } from '../auth/next';
import { useIsAuthenticated, useLogin } from '../auth/useAuth';
import { useT } from '../i18n/context';

interface LoginLocationState {
  email?: string;
  notice?: 'created';
}

export function LoginPage() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const login = useLogin();
  const isAuthenticated = useIsAuthenticated();

  const state = (location.state ?? null) as LoginLocationState | null;
  const sessionExpired = searchParams.get('reason') === 'expired';
  const accountCreated = state?.notice === 'created';

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginFormSchema),
    defaultValues: { email: state?.email ?? '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await login.mutateAsync(values);
      navigate(safeNextPath(searchParams.get('next')), { replace: true });
    } catch (error) {
      const { level, messageKey } = describeAuthError(error);
      setError(level === 'form' ? 'root' : level, { message: t(messageKey) });
    }
  });

  const pending = isSubmitting || login.isPending;

  // A2: an already-authenticated visitor never sees the login form — bounce to the
  // intended destination (honoring a safe ?next=), reusing the open-redirect guard.
  if (isAuthenticated) {
    return <Navigate to={safeNextPath(searchParams.get('next'))} replace />;
  }

  return (
    <AuthLayout
      title={t('auth.signIn')}
      subtitle={t('auth.signInSubtitle')}
      footer={
        <>
          {t('auth.noAccount')}{' '}
          <Link className={styles.link} to="/register">
            {t('auth.createOne')}
          </Link>
        </>
      }
    >
      {sessionExpired ? (
        <p className={styles.banner} role="status">
          {t('auth.sessionExpired')}
        </p>
      ) : null}
      {accountCreated ? (
        <p className={styles.banner} role="status">
          {t('auth.accountCreated')}
        </p>
      ) : null}

      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {errors.root?.message ? (
          <p className={styles.formError} role="alert">
            {errors.root.message}
          </p>
        ) : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="login-email">
            {t('auth.email')}
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            className={errors.email ? `${styles.input} ${styles.inputError}` : styles.input}
            aria-invalid={errors.email ? true : undefined}
            {...register('email')}
          />
          {errors.email?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.email.message}
            </p>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="login-password">
            {t('auth.password')}
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            className={errors.password ? `${styles.input} ${styles.inputError}` : styles.input}
            aria-invalid={errors.password ? true : undefined}
            {...register('password')}
          />
          {errors.password?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.password.message}
            </p>
          ) : null}
        </div>

        <button className={styles.button} type="submit" disabled={pending}>
          {t(pending ? 'auth.signingIn' : 'auth.signIn')}
        </button>
      </form>
    </AuthLayout>
  );
}
