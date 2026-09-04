import { zodResolver } from '@hookform/resolvers/zod';
import { loginFormSchema, type LoginFormValues } from '@budget/shared';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { Controller, useForm } from 'react-hook-form';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { describeAuthError } from '../../src/auth/errors';
import { safeNextRoute } from '../../src/auth/next';
import { useLogin } from '../../src/auth/useAuth';
import { FieldError } from '../../src/components/FieldError';
import { FormButton } from '../../src/components/FormButton';
import { KeyboardAwareForm } from '../../src/components/KeyboardAwareForm';
import { LabeledInput } from '../../src/components/LabeledInput';
import { colors, spacing } from '../../src/components/theme';
import { useT } from '../../src/i18n/context';

export default function LoginScreen() {
  const t = useT();
  const params = useLocalSearchParams<{
    next?: string;
    email?: string;
    notice?: string;
    reason?: string;
  }>();
  const login = useLogin();

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginFormSchema),
    defaultValues: { email: params.email ?? '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await login.mutateAsync(values);
      router.replace(safeNextRoute(params.next) as Href);
    } catch (error) {
      // describeAuthError is language-free and answers with a dictionary KEY;
      // the sentence is chosen here, in the language on screen.
      const { level, messageKey } = describeAuthError(error);
      setError(level === 'form' ? 'root' : level, { message: t(messageKey) });
    }
  });

  const pending = isSubmitting || login.isPending;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAwareForm>
        <View style={styles.header}>
          <Text style={styles.title}>{t('auth.signIn')}</Text>
          <Text style={styles.subtitle}>{t('auth.signInSubtitle')}</Text>
        </View>

        {params.reason === 'expired' ? (
          <Text style={styles.banner}>{t('auth.sessionExpired')}</Text>
        ) : null}
        {params.notice === 'created' ? (
          <Text style={styles.banner}>{t('auth.accountCreated')}</Text>
        ) : null}

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
              autoComplete="current-password"
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              error={errors.password?.message}
            />
          )}
        />

        <FormButton label={t('auth.signIn')} onPress={onSubmit} pending={pending} />

        <View style={styles.footer}>
          <Text style={styles.footerText}>{t('auth.noAccount')} </Text>
          <Text
            accessibilityRole="link"
            style={styles.link}
            onPress={() =>
              router.replace({
                pathname: '/register',
                params: params.next ? { next: params.next } : {},
              })
            }
          >
            {t('auth.createOne')}
          </Text>
        </View>
      </KeyboardAwareForm>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    gap: spacing.xs,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.text,
  },
  subtitle: {
    fontSize: 15,
    color: colors.textMuted,
  },
  banner: {
    backgroundColor: '#E7F1FD',
    color: colors.primary,
    padding: spacing.md,
    borderRadius: 8,
    fontSize: 14,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  footerText: {
    color: colors.textMuted,
    fontSize: 14,
  },
  link: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '600',
  },
});
