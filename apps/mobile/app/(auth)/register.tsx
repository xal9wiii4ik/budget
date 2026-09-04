import { zodResolver } from '@hookform/resolvers/zod';
import { registerFormSchema, type RegisterFormValues } from '@budget/shared';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { Controller, useForm } from 'react-hook-form';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { describeAuthError, RegisterLoginFailedError } from '../../src/auth/errors';
import { safeNextRoute } from '../../src/auth/next';
import { useRegister } from '../../src/auth/useAuth';
import { FieldError } from '../../src/components/FieldError';
import { FormButton } from '../../src/components/FormButton';
import { KeyboardAwareForm } from '../../src/components/KeyboardAwareForm';
import { LabeledInput } from '../../src/components/LabeledInput';
import { colors, spacing } from '../../src/components/theme';
import { useT } from '../../src/i18n/context';

export default function RegisterScreen() {
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
