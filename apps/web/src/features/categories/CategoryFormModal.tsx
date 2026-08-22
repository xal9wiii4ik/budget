import { zodResolver } from '@hookform/resolvers/zod';
import { categoryFormSchema, HEX_COLOR_PATTERN, type CategoryFormValues } from '@budget/shared';
import type { components } from '@budget/api-client';
import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { useCreateCategory, useUpdateCategory } from '../../data/categories';
import { useLang } from '../../i18n/context';
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
        title={archiving ? 'Archive category' : 'Unarchive category'}
        message={
          archiving
            ? `Archive "${category.name}"? It stays on past transactions but won't be selectable for new ones.`
            : `Restore "${category.name}" so it can be used again?`
        }
        confirmLabel={archiving ? 'Archive' : 'Unarchive'}
        pendingLabel={archiving ? 'Archiving…' : 'Unarchiving…'}
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
    <Modal title={isEdit ? 'Edit category' : 'New category'} onClose={onClose} isDirty={isDirty}>
      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {errors.root?.message ? (
          <p className={styles.formError} role="alert">
            {errors.root.message}
          </p>
        ) : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="category-name">
            Name
          </label>
          <input
            id="category-name"
            className={errors.name ? `${styles.input} ${styles.inputError}` : styles.input}
            aria-invalid={errors.name ? true : undefined}
            {...register('name')}
          />
          {errors.name?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.name.message}
            </p>
          ) : null}
        </div>

        <fieldset className={styles.field}>
          <legend className={styles.label}>Type</legend>
          <div className={styles.kindGroup}>
            <label className={styles.kindOption}>
              <input type="radio" value="expense" {...register('kind')} />
              Expense
            </label>
            <label className={styles.kindOption}>
              <input type="radio" value="income" {...register('kind')} />
              Income
            </label>
          </div>
        </fieldset>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="category-icon">
            Icon <span className={styles.hint}>(optional)</span>
          </label>
          <input
            id="category-icon"
            className={styles.input}
            maxLength={16}
            {...register('icon')}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="category-color">
            Color <span className={styles.hint}>(optional, e.g. #3366FF)</span>
          </label>
          <div className={styles.colorRow}>
            <input
              id="category-color"
              className={errors.color ? `${styles.input} ${styles.inputError}` : styles.input}
              placeholder="#3366FF"
              aria-invalid={errors.color ? true : undefined}
              {...register('color')}
            />
            <span
              className={styles.swatch}
              style={{
                background: HEX_COLOR_PATTERN.test(colorPreview) ? colorPreview : '#e5e7eb',
              }}
              aria-hidden="true"
            />
          </div>
          {errors.color?.message ? (
            <p className={styles.fieldError} role="alert">
              {errors.color.message}
            </p>
          ) : null}
        </div>

        <div className={styles.actions}>
          {isEdit && category && !category.is_system ? (
            <button
              type="button"
              className={styles.archive}
              onClick={() => {
                setArchiveError(undefined);
                setConfirmingArchive(true);
              }}
            >
              {category.archived ? 'Unarchive' : 'Archive'}
            </button>
          ) : null}
          <span className={styles.spacer} />
          <button type="submit" className={styles.submit} disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
