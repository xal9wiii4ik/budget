import { zodResolver } from '@hookform/resolvers/zod';
import { registerFormSchema, type RegisterFormValues } from '@budget/shared';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { Controller, useForm } from 'react-hook-form';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { describeAuthError, RegisterLoginFailedError } from '../../src/auth/errors';
import { safeNextRoute } from '../../src/auth/next';
import { useRegister } from '../../src/auth/useAuth';
import { FieldError } from '../../src/components/FieldError';
import { FormButton } from '../../src/components/FormButton';
import { KeyboardAwareForm } from '../../src/components/KeyboardAwareForm';
import { LabeledInput } from '../../src/components/LabeledInput';
import { useT } from '../../src/i18n/context';
import { themedStyles } from '../../src/theme/themedStyles';

export default function RegisterScreen() {
  const styles = useStyles();
  const t = useT();
  const params = useLocalSearchParams<{ next?: string }>();
  const registerMutation = useRegister();

  const {
    control,
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
      router.replace(safeNextRoute(params.next) as Href);
    } catch (error) {
      if (error instanceof RegisterLoginFailedError) {
        // Account exists — hand off to /login prefilled, never re-register. Preserve
        // the intended destination.
        router.replace({
          pathname: '/login',
          params: {
            email: error.email,
            notice: 'created',
            ...(params.next ? { next: params.next } : {}),
          },
        });
        return;
      }
      const { level, messageKey } = describeAuthError(error);
      setError(level === 'form' ? 'root' : level, { message: t(messageKey) });
    }
  });

  const pending = isSubmitting || registerMutation.isPending;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAwareForm>
        <View style={styles.header}>
          <Text style={styles.title}>{t('auth.createAccount')}</Text>
          <Text style={styles.subtitle}>{t('auth.createSubtitle')}</Text>
        </View>

        <FieldError message={errors.root?.message} />

        <Controller
          control={control}
          name="email"
          render={({ field }) => (
            <LabeledInput
              label={t('auth.email')}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              error={errors.email?.message}
            />
          )}
        />

        <Controller
          control={control}
          name="password"
          render={({ field }) => (
            <LabeledInput
              label={t('auth.password')}
              secureTextEntry
              autoComplete="new-password"
              hint={t('auth.passwordHint')}
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              error={errors.password?.message}
            />
          )}
        />

        <FormButton label={t('auth.createAccount')} onPress={onSubmit} pending={pending} />

        <View style={styles.footer}>
          <Text style={styles.footerText}>{t('auth.haveAccount')} </Text>
          <Text
            accessibilityRole="link"
            style={styles.link}
            onPress={() =>
              router.replace({
                pathname: '/login',
                params: params.next ? { next: params.next } : {},
              })
            }
          >
            {t('auth.signIn')}
          </Text>
        </View>
      </KeyboardAwareForm>
    </SafeAreaView>
  );
}

const useStyles = themedStyles((t) => ({
  safe: {
    flex: 1,
    backgroundColor: t.colors.bg,
  },
  header: {
    gap: t.spacing.xs,
  },
  title: {
    fontSize: t.type.xxl,
    fontWeight: '700',
    color: t.colors.text,
  },
  subtitle: {
    fontSize: t.type.md,
    color: t.colors.textMuted,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  footerText: {
    color: t.colors.textMuted,
    fontSize: t.type.sm,
  },
  link: {
    color: t.colors.accent,
    fontSize: t.type.sm,
    fontWeight: '600',
  },
}));
