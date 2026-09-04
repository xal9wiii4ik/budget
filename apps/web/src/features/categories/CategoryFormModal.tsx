import { zodResolver } from '@hookform/resolvers/zod';
import { categoryFormSchema, HEX_COLOR_PATTERN, type CategoryFormValues } from '@budget/shared';
import type { components } from '@budget/api-client';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Field, Input } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { useCreateCategory, useUpdateCategory } from '../../data/categories';
import { useLang, useT } from '../../i18n/context';
import { describeCategoryError } from '../../lib/errors';
import { buildCategoryPatch, emptyToNull } from '@budget/api-client';
import styles from './CategoryFormModal.module.css';

type CategoryRead = components['schemas']['CategoryRead'];

interface CategoryFormModalProps {
  // `undefined` = create mode; a category = edit mode.
  category?: CategoryRead;
  onClose: () => void;
}

function toFormValues(category: CategoryRead): CategoryFormValues {
  return {
    name: category.name,
    kind: category.kind,
    icon: category.icon ?? '',
    color: category.color ?? '',
  };
}

const EMPTY_VALUES: CategoryFormValues = { name: '', kind: 'expense', icon: '', color: '' };

export function CategoryFormModal({ category, onClose }: CategoryFormModalProps) {
  const lang = useLang();
  const t = useT();
  const isEdit = category !== undefined;
  const initial = category ? toFormValues(category) : EMPTY_VALUES;

  const createCategory = useCreateCategory();
  const updateCategory = useUpdateCategory();
  const archiveCategory = useUpdateCategory();
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archiveError, setArchiveError] = useState<string | undefined>(undefined);

  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<CategoryFormValues>({
    resolver: zodResolver(categoryFormSchema),
    defaultValues: initial,
  });

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
      onClose();
    } catch (error) {
      const { field, message } = describeCategoryError(error, lang);
      setError(field === 'form' ? 'root' : field, { message });
    }
  });

  const confirmArchive = async () => {
    if (!category) return;
    setArchiveError(undefined);
    try {
      await archiveCategory.mutateAsync({
        id: category.id,
        body: { archived: !category.archived },
      });
      onClose();
    } catch (error) {
      setArchiveError(describeCategoryError(error, lang).message);
    }
  };

  if (confirmingArchive && category) {
    const archiving = !category.archived;
    return (
      <ConfirmDialog
        title={t(archiving ? 'categoryForm.archiveTitle' : 'categoryForm.unarchiveTitle')}
        message={t(
          archiving ? 'categoryForm.archiveMessage' : 'categoryForm.unarchiveMessage',
          { name: category.name },
        )}
        confirmLabel={t(archiving ? 'common.archive' : 'common.unarchive')}
        pendingLabel={t(archiving ? 'common.archiving' : 'common.unarchiving')}
        destructive={archiving}
        isPending={archiveCategory.isPending}
        errorMessage={archiveError}
        onConfirm={confirmArchive}
        onCancel={() => setConfirmingArchive(false)}
      />
    );
  }

  const pending = isSubmitting || createCategory.isPending || updateCategory.isPending;

  return (
    <Modal
      title={t(isEdit ? 'categoryForm.editTitle' : 'categoryForm.newTitle')}
      onClose={onClose}
      isDirty={isDirty}
    >
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {errors.root?.message ? (
          <p className={styles.formError} role="alert">
            {errors.root.message}
          </p>
        ) : null}

        <Field label={t('common.name')} htmlFor="category-name" error={errors.name?.message}>
          <Input
            id="category-name"
            aria-invalid={errors.name ? true : undefined}
            {...register('name')}
          />
        </Field>

        <fieldset className={styles.field}>
          <legend className={styles.label}>{t('common.type')}</legend>
          <div className={styles.kindGroup}>
            <label className={styles.kindOption}>
              <input type="radio" value="expense" {...register('kind')} />
              {t('common.expense')}
            </label>
            <label className={styles.kindOption}>
              <input type="radio" value="income" {...register('kind')} />
              {t('common.income')}
            </label>
          </div>
        </fieldset>

        <Field
          label={
            <>
              {t('categoryForm.icon')} <span className={styles.hint}>{t('common.optional')}</span>
            </>
          }
          htmlFor="category-icon"
        >
          <Input id="category-icon" maxLength={16} {...register('icon')} />
        </Field>

        <Field
          label={
            <>
              {t('categoryForm.color')}{' '}
              <span className={styles.hint}>{t('categoryForm.colorHint')}</span>
            </>
          }
          htmlFor="category-color"
          error={errors.color?.message}
        >
          <div className={styles.colorRow}>
            <Input
              id="category-color"
              // COPY, not a colour the app paints with: it shows the shape of the
              // value this field wants.
              placeholder="#3366FF"
              aria-invalid={errors.color ? true : undefined}
              {...register('color')}
            />
            <span
              className={styles.swatch}
              // What the user typed goes in verbatim; the "not a colour yet"
              // fallback is the app's and reads a token, so it follows the theme.
              style={{
                background: HEX_COLOR_PATTERN.test(colorPreview)
                  ? colorPreview
                  : 'var(--color-surface-muted)',
              }}
              aria-hidden="true"
            />
          </div>
        </Field>

        <div className={styles.actions}>
          {isEdit && category && !category.is_system ? (
            <Button
              onClick={() => {
                setArchiveError(undefined);
                setConfirmingArchive(true);
              }}
            >
              {t(category.archived ? 'common.unarchive' : 'common.archive')}
            </Button>
          ) : null}
          <span className={styles.spacer} />
          <Button type="submit" variant="primary" loading={pending}>
            {t(pending ? 'common.saving' : 'common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
