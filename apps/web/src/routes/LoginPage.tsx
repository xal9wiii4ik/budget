import { zodResolver } from '@hookform/resolvers/zod';
import { loginFormSchema, type LoginFormValues } from '@budget/shared';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';

import { AuthLayout } from '../auth/AuthLayout';
import styles from '../auth/AuthLayout.module.css';
import { Button } from '../components/Button';
import { Field, Input } from '../components/Field';
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

  // mcp-remote W1: a brand-new Claude user arrives at /oauth/consent?req=…, is
  // bounced here with that path in `?next=`, and has no account yet — so the
  // "create one" link must CARRY the destination, or registering lands them on
  // /transactions and the pending request (10 minutes) is lost. Re-encoded
  // because the value read off the params is already decoded.
  const nextParam = searchParams.get('next');
  const registerTo = nextParam ? `/register?next=${encodeURIComponent(nextParam)}` : '/register';

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
          <Link className={styles.link} to={registerTo}>
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

        <Field label={t('auth.email')} htmlFor="login-email" error={errors.email?.message}>
          <Input
            id="login-email"
            type="email"
            autoComplete="email"
            aria-invalid={errors.email ? true : undefined}
            {...register('email')}
          />
        </Field>

        <Field
          label={t('auth.password')}
          htmlFor="login-password"
          error={errors.password?.message}
        >
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            aria-invalid={errors.password ? true : undefined}
            {...register('password')}
          />
        </Field>

        <Button className={styles.submit} variant="primary" type="submit" disabled={pending}>
          {t(pending ? 'auth.signingIn' : 'auth.signIn')}
        </Button>
      </form>
    </AuthLayout>
  );
}
