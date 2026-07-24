import { zodResolver } from '@hookform/resolvers/zod';
import { registerFormSchema, type RegisterFormValues } from '@budget/shared';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { AuthLayout } from '../auth/AuthLayout';
import styles from '../auth/AuthLayout.module.css';
import { describeAuthError, RegisterLoginFailedError } from '../auth/errors';
import { safeNextPath } from '../auth/next';
import { useRegister } from '../auth/useAuth';

export function RegisterPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const registerMutation = useRegister();

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
      const { level, message } = describeAuthError(error);
      setError(level === 'form' ? 'root' : level, { message });
    }
  });

  const pending = isSubmitting || registerMutation.isPending;

  return (
    <AuthLayout
      title="Create account"
      subtitle="Start tracking your budget."
      footer={
        <>
          Already have an account?{' '}
          <Link className={styles.link} to="/login">
            Sign in
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

        <div className={styles.field}>
          <label className={styles.label} htmlFor="register-email">
            Email
          </label>
          <input
            id="register-email"
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
          <label className={styles.label} htmlFor="register-password">
            Password
          </label>
          <input
            id="register-password"
            type="password"
            autoComplete="new-password"
            className={errors.password ? `${styles.input} ${styles.inputError}` : styles.input}
            aria-invalid={errors.password ? true : undefined}
            aria-describedby="register-password-hint"
            {...register('password')}
          />
          <p id="register-password-hint" className={styles.hint}>
            At least 8 characters.
          </p>
          {errors.password?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.password.message}
            </p>
          ) : null}
        </div>

        <button className={styles.button} type="submit" disabled={pending}>
          {pending ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthLayout>
  );
}
