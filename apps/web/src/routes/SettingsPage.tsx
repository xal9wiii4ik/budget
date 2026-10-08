import { isLang } from '@budget/shared';
import { useMemo, useState, type ChangeEvent } from 'react';
import { useSearchParams } from 'react-router';

import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { Select } from '../components/Field';
import { QueryStateNotice } from '../components/QueryStateNotice';
import { useProfile, useUpdateProfile } from '../data/profile';
import { useRevokeToken, useTokens, type TokenRead } from '../data/tokens';
import { BaseCurrencySection } from '../features/settings/BaseCurrencySection';
import { MonthlyIncomeSection } from '../features/settings/MonthlyIncomeSection';
import { NotificationsSection } from '../features/settings/NotificationsSection';
import { PasswordSection } from '../features/settings/PasswordSection';
import type { IncomeHandoff } from '../features/settings/incomeHandoff';
import { ConnectedAppsSection } from '../features/oauth/ConnectedAppsSection';
import { TokenFormModal } from '../features/tokens/TokenFormModal';
import { TokenRow } from '../features/tokens/TokenRow';
import { useI18n, useLang, useT } from '../i18n/context';
import { describeTokenError } from '../lib/errors';
import { queryPhase } from '../lib/queryPhase';
import styles from './SettingsPage.module.css';

type ModalState =
  | { type: 'closed' }
  | { type: 'create' }
  | { type: 'revoke'; token: TokenRead };

/**
 * Settings — the profile (language, base currency, declared monthly income) and
 * the personal access tokens that let an MCP client into this account.
 *
 * The screen owns no server state of its own: the lists are the Query cache, and
 * the only two values that live outside it never touch it on purpose — a new
 * token's plaintext (which dies with the create modal) and the income HANDOFF
 * below, which is a suggestion the user has not saved yet.
 */
export function SettingsPage() {
  const lang = useLang();
  const t = useT();
  const tokensQuery = useTokens();
  const phase = queryPhase(tokensQuery);
  const revokeToken = useRevokeToken();

  const [modal, setModal] = useState<ModalState>({ type: 'closed' });
  const [revokeError, setRevokeError] = useState<string | undefined>(undefined);

  // ONE profile query for both profile sections, so a failed read is ONE notice
  // and not two competing ones.
  const profileQuery = useProfile();
  const profilePhase = queryPhase(profileQuery);

  // The base-currency switch clears the declared income server-side (A1), so it
  // hands the income field a converted suggestion. Genuine client state: an
  // unsaved draft, deliberately NOT in the Query cache. `seq` makes two switches
  // in a row two distinct handovers.
  const [handoff, setHandoff] = useState<IncomeHandoff | null>(null);

  // The `/goals` deep link (`?focus=income`). Read during render — a search param
  // is data, not an effect.
  const [searchParams] = useSearchParams();
  const focusIncome = searchParams.get('focus') === 'income';

  // The server sends `created_at desc, id`; the only thing the screen adds is
  // pushing revoked tokens below the active ones, order preserved within each
  // group. Derived during render — nothing is stored.
  const items = tokensQuery.data?.items;
  const ordered = useMemo(() => {
    if (!items) return [];
    return [
      ...items.filter((token) => token.revoked_at === null),
      ...items.filter((token) => token.revoked_at !== null),
    ];
  }, [items]);

  const confirmRevoke = async (token: TokenRead) => {
    setRevokeError(undefined);
    try {
      await revokeToken.mutateAsync({ id: token.id });
      setModal({ type: 'closed' });
    } catch (error) {
      setRevokeError(describeTokenError(error, lang).message);
    }
  };

  return (
    <section className={styles.page}>
      <h1 className={styles.title}>{t('settings.title')}</h1>

      <LanguageSection />

      <PasswordSection />

      <NotificationsSection />

      {profilePhase === 'error' || profilePhase === 'unreachable' ? (
        <QueryStateNotice
          phase={profilePhase}
          message={t('settings.baseCurrency.loadFailed')}
          onRetry={() => {
            void profileQuery.refetch();
          }}
        />
      ) : (
        <>
          <BaseCurrencySection
            profile={profileQuery.data}
            onIncomeHandoff={(next) =>
              setHandoff((previous) => ({ ...next, seq: (previous?.seq ?? 0) + 1 }))
            }
          />
          <MonthlyIncomeSection
            profile={profileQuery.data}
            handoff={handoff}
            deepLinkFocus={focusIncome}
            onHandoffConsumed={() => setHandoff(null)}
          />
        </>
      )}

      {/* mcp-remote W1: the connector is the primary way to attach an AI app
          now, so it comes BEFORE the hand-made tokens below, which are the
          fallback. Independent of the profile read above on purpose — a failed
          profile must not hide it. */}
      <ConnectedAppsSection />

      <section>
        <header className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>{t('tokens.heading')}</h2>
          <Button variant="primary" onClick={() => setModal({ type: 'create' })}>
            {t('tokens.new')}
          </Button>
        </header>

        <p className={styles.lede}>{t('tokens.lede')}</p>

        {phase === 'loading' ? (
          <div className={styles.skeletons} aria-hidden="true">
            <div className={styles.skeletonRow} />
            <div className={styles.skeletonRow} />
            <div className={styles.skeletonRow} />
          </div>
        ) : phase === 'error' || phase === 'unreachable' ? (
          <QueryStateNotice
            phase={phase}
            message={t('tokens.loadFailed')}
            onRetry={() => {
              void tokensQuery.refetch();
            }}
          />
        ) : ordered.length === 0 ? (
          <EmptyState
            title={t('tokens.emptyTitle')}
            description={t('tokens.emptyBody')}
            actions={
              <Button variant="primary" onClick={() => setModal({ type: 'create' })}>
                {t('tokens.new')}
              </Button>
            }
          />
        ) : (
          <ul className={styles.list}>
            {ordered.map((token) => (
              <TokenRow
                key={token.id}
                token={token}
                isRevokePending={
                  revokeToken.isPending &&
                  modal.type === 'revoke' &&
                  modal.token.id === token.id
                }
                onRevoke={(target) => {
                  setRevokeError(undefined);
                  setModal({ type: 'revoke', token: target });
                }}
              />
            ))}
          </ul>
        )}
      </section>

      {modal.type === 'create' ? (
        <TokenFormModal onClose={() => setModal({ type: 'closed' })} />
      ) : null}
      {modal.type === 'revoke' ? (
        <ConfirmDialog
          title={t('tokens.revokeTitle')}
          message={t('tokens.revokeMessage', { name: modal.token.name })}
          confirmLabel={t('tokens.revoke')}
          pendingLabel={t('tokens.revoking')}
          destructive
          isPending={revokeToken.isPending}
          errorMessage={revokeError}
          onConfirm={() => {
            void confirmRevoke(modal.token);
          }}
          onCancel={() => setModal({ type: 'closed' })}
        />
      ) : null}
    </section>
  );
}

/**
 * The language switcher (S5).
 *
 * Applying it and SAVING it are two different things on purpose: `setLang` takes
 * effect immediately and is cached locally (so a reload, a logged-out screen and
 * an offline session all keep the choice), while the PATCH publishes it to the
 * profile that the mobile client reads. If the PATCH fails the choice STAYS —
 * the message says only that the profile copy did not get updated, which is
 * exactly what happened; rolling the UI back would be a lie about what the user
 * asked for.
 *
 * The two option labels are each written in their OWN language and are therefore
 * not translated: "Русский" is what a Russian speaker looks for even when the UI
 * is currently English.
 */
function LanguageSection() {
  const { lang, setLang, t } = useI18n();
  const updateProfile = useUpdateProfile();

  const onChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    if (!isLang(next) || next === lang) return;
    setLang(next);
    updateProfile.mutate({ language: next });
  };

  return (
    <section className={styles.languageSection}>
      <h2 className={styles.sectionTitle}>{t('settings.language.title')}</h2>
      <p className={styles.lede}>{t('settings.language.lede')}</p>

      <div className={styles.languageRow}>
        <label className={styles.languageLabel} htmlFor="settings-language">
          {t('settings.language.label')}
        </label>
        <Select id="settings-language" value={lang} onChange={onChange}>
          <option value="ru">Русский</option>
          <option value="en">English</option>
        </Select>
        {updateProfile.isPending ? (
          <span className={styles.languageStatus}>{t('settings.language.saving')}</span>
        ) : null}
      </div>

      {updateProfile.isError ? (
        <p className={styles.languageError} role="alert">
          {t('settings.language.saveFailed')}
        </p>
      ) : null}
    </section>
  );
}
