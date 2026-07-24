import { zodResolver } from '@hookform/resolvers/zod';
import { categoryFormSchema, type CategoryFormValues } from '@budget/shared';
import { buildCategoryPatch, emptyToNull } from '@budget/api-client';
import type { components } from '@budget/api-client';
import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { confirmAction } from '../../src/components/confirm';
import { FieldError } from '../../src/components/FieldError';
import { FormButton } from '../../src/components/FormButton';
import { HexSwatch } from '../../src/components/HexSwatch';
import { KeyboardAwareForm } from '../../src/components/KeyboardAwareForm';
import { KindSegmented } from '../../src/components/KindSegmented';
import { LabeledInput } from '../../src/components/LabeledInput';
import { colors, spacing } from '../../src/components/theme';
import { useCategories, useCreateCategory, useUpdateCategory } from '../../src/data/categories';
import { describeCategoryError } from '../../src/data/errors';

type CategoryRead = components['schemas']['CategoryRead'];

function toFormValues(category: CategoryRead): CategoryFormValues {
  return {
    name: category.name,
    kind: category.kind,
    icon: category.icon ?? '',
    color: category.color ?? '',
  };
}

const EMPTY_VALUES: CategoryFormValues = { name: '', kind: 'expense', icon: '', color: '' };

export default function CategoryFormScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id;
  const isEdit = id !== undefined;

  const categoriesQuery = useCategories();
  const category = isEdit ? categoriesQuery.data?.find((c) => c.id === id) : undefined;

  if (isEdit && categoriesQuery.isPending) {
    return (
      <Shell title="Edit category">
        <Text style={styles.notice}>Loading…</Text>
      </Shell>
    );
  }

  // Deep-link-safe: the category cache is the single source; a missing id (cold deep
  // link) shows unavailable + back rather than a broken form.
  if (isEdit && category === undefined) {
    return (
      <Shell title="Edit category">
        <Text accessibilityRole="alert" style={styles.unavailable}>
          This category is unavailable.
        </Text>
        <FormButton label="Go back" variant="secondary" onPress={() => router.back()} />
      </Shell>
    );
  }

  return <CategoryFormBody category={category} />;
}

function CategoryFormBody({ category }: { category: CategoryRead | undefined }) {
  const isEdit = category !== undefined;
  const initial = category ? toFormValues(category) : EMPTY_VALUES;

  const createCategory = useCreateCategory();
  const updateCategory = useUpdateCategory();
  const archiveCategory = useUpdateCategory();

  const {
    control,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<CategoryFormValues>({
    resolver: zodResolver(categoryFormSchema),
    defaultValues: initial,
  });

  const kind = useWatch({ control, name: 'kind' });
  const colorPreview = useWatch({ control, name: 'color' });

  const onSubmit = handleSubmit(async (values) => {
    try {
      if (isEdit && category) {
        const patch = buildCategoryPatch(values, initial);
        if (Object.keys(patch).length > 0) {
          await updateCategory.mutateAsync({ id: category.id, body: patch });
        }
      } else {
        await createCategory.mutateAsync({
          name: values.name,
          kind: values.kind,
          icon: emptyToNull(values.icon),
          color: emptyToNull(values.color),
        });
      }
      router.back();
    } catch (error) {
      const { field, message } = describeCategoryError(error);
      setError(field === 'form' ? 'root' : field, { message });
    }
  });

  const onArchiveToggle = () => {
    if (!category) return;
    const archiving = !category.archived;
    confirmAction({
      title: archiving ? 'Archive category' : 'Unarchive category',
      message: archiving
        ? `Archive "${category.name}"? It stays on past transactions but won't be selectable for new ones.`
        : `Restore "${category.name}" so it can be used again?`,
      confirmLabel: archiving ? 'Archive' : 'Unarchive',
      destructive: archiving,
      onConfirm: () => {
        archiveCategory.mutate(
          { id: category.id, body: { archived: archiving } },
          {
            onSuccess: () => router.back(),
            onError: (error) => {
              const { message } = describeCategoryError(error);
              setError('root', { message });
            },
          },
        );
      },
    });
  };

  const pending = isSubmitting || createCategory.isPending || updateCategory.isPending;
  // W9: is_system gates the archive affordance client-side (server 403 is backstop).
  const showArchive = isEdit && category !== undefined && !category.is_system;

  return (
    <Shell title={isEdit ? 'Edit category' : 'New category'}>
      <FieldError message={errors.root?.message} />

      <Controller
        control={control}
        name="name"
        render={({ field }) => (
          <LabeledInput
            label="Name"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.name?.message}
          />
        )}
      />

      <View style={styles.field}>
        <Text style={styles.label}>Type</Text>
        <KindSegmented value={kind} onChange={(next) => setValue('kind', next)} />
      </View>

      <Controller
        control={control}
        name="icon"
        render={({ field }) => (
          <LabeledInput
            label="Icon (optional)"
            maxLength={16}
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            error={errors.icon?.message}
          />
        )}
      />

      <View style={styles.field}>
        <Text style={styles.label}>Color (optional, e.g. #3366FF)</Text>
        <View style={styles.colorRow}>
          <View style={styles.colorInput}>
            <Controller
              control={control}
              name="color"
              render={({ field }) => (
                <LabeledInput
                  label=""
                  placeholder="#3366FF"
                  autoCapitalize="none"
                  value={field.value}
                  onChangeText={field.onChange}
                  onBlur={field.onBlur}
                  error={errors.color?.message}
                />
              )}
            />
          </View>
          <HexSwatch color={colorPreview} />
        </View>
      </View>

      <FormButton label="Save" onPress={onSubmit} pending={pending} />
      {showArchive ? (
        <FormButton
          label={category.archived ? 'Unarchive' : 'Archive'}
          variant="secondary"
          onPress={onArchiveToggle}
          pending={archiveCategory.isPending}
        />
      ) : null}
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>{title}</Text>
        <View style={styles.headerSpacer} />
      </View>
      <KeyboardAwareForm>{children}</KeyboardAwareForm>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.text,
  },
  cancel: {
    fontSize: 16,
    color: colors.primary,
    minWidth: 60,
  },
  headerSpacer: {
    minWidth: 60,
  },
  field: {
    gap: spacing.xs,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  notice: {
    color: colors.textMuted,
    fontSize: 14,
  },
  unavailable: {
    color: colors.danger,
    fontSize: 15,
  },
  colorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  colorInput: {
    flex: 1,
  },
});
