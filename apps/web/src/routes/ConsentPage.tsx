import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import { useMe } from '../auth/useMe';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { QueryStateNotice } from '../components/QueryStateNotice';
import { useOAuthDecision, useOAuthRequest } from '../data/oauthRequest';
import type { PatScope } from '../data/tokens';
import { isAllowedRedirect } from '../features/oauth/redirectGuard';
import { LanguageToggle } from '../i18n/LanguageToggle';
import { useLang, useT } from '../i18n/context';
import { describeOAuthError } from '../lib/errors';
import { queryPhase } from '../lib/queryPhase';
import { ThemeToggle } from '../theme/ThemeToggle';
import styles from './ConsentPage.module.css';

/**
 * `/oauth/consent?req=<uuid>` — the page where the user hands an AI app access
 * to their budget (mcp-remote W1).
 *
 * Deliberately OUTSIDE the nav shell: this is a dialogue a third party opened
 * mid-flow, and a sidebar inviting the user off to /stats while they are granting
 * access is the wrong page. It still needs the session, so the route is wrapped
 * in `<RequireAuth>` (App.tsx) — whose `?next=` carries `?req=` through the login
 * and register screens.
 *
 * Not `AuthLayout`: that component hardcodes the brand/title/subtitle/footer
 * grammar of a sign-in FORM. This page borrows its precedent (centred card, the
 * toggles in a corner) off the same tokens instead.
 *
 * No money is rendered anywhere on this page, by nature of what it decides.
 */
export function ConsentPage() {
  const t = useT();
  const [searchParams] = useSearchParams();
  // A search param is DATA, read during render — never copied into state.
  const requestId = searchParams.get('req');

  return (
    <ConsentShell>
      {requestId === null ? (
        // Reachable only by hand-editing the URL (the AS always appends `?req=`),
        // and it is still a dead end that must say where to go.
        <p className={styles.alert} role="alert">
          {t('consent.missingRequest')}
        </p>
      ) : (
        <ConsentDialogue requestId={requestId} />
      )}
    </ConsentShell>
  );
}

/**
 * The card and the two toggles. The toggles are reachable here for the same
 * reason they are on the sign-in screen: this may be the first Budget page a
 * brand-new Claude user ever sees, and it is a page they have to READ.
 */
function ConsentShell({ children }: { children: ReactNode }) {
  const t = useT();
  const me = useMe();

  return (
    <main className={styles.page}>
      <div className={styles.corner}>
        <LanguageToggle />
        <ThemeToggle />
      </div>
      <section className={styles.card}>
        <span className={styles.brand}>Budget</span>
        {children}
        {/* WHICH budget is being connected — someone with two accounts has no
            other way to tell. Muted, below the decision, and with no account
            switcher in v1: switching here would mean discarding the request. */}
        {me.data ? (
          <p className={styles.signedIn}>{t('consent.signedInAs', { email: me.data.email })}</p>
        ) : null}
      </section>
    </main>
  );
}

/** What happened after the decision, when the browser did NOT leave this page. */
type DoneState = { decision: 'allow' | 'deny'; redirectRefused: boolean };

function ConsentDialogue({ requestId }: { requestId: string }) {
  const lang = useLang();
  const t = useT();
  const requestQuery = useOAuthRequest(requestId);
  const phase = queryPhase(requestQuery);
  const decision = useOAuthDecision(requestId);

  // The mode the user is granting. Local state, not react-hook-form: one radio
  // group and two buttons is not a form, there is no schema to share with
  // mobile, and `read` is the default on purpose — the narrower grant is the one
  // a user who clicks straight through should end up with.
  const [mode, setMode] = useState<PatScope>('read');
  const [done, setDone] = useState<DoneState | null>(null);

  const submit = (choice: 'allow' | 'deny') => {
    decision.mutate(
      { decision: choice, scope: mode },
      {
        // The navigation lives HERE, in onSuccess, and never in an effect: under
        // StrictMode an effect body runs twice, which would call
        // `location.replace` twice and could re-post a single-use decision.
        onSuccess: (result) => {
          if (isAllowedRedirect(result.redirect_to)) {
            window.location.replace(result.redirect_to);
            // `replace` can be refused (an extension, a sandboxed tab). The page
            // then stays, so it must say what already happened server-side.
            setDone({ decision: choice, redirectRefused: false });
            return;
          }
          // Belt-and-braces refusal (redirectGuard.ts): the decision IS recorded,
          // we simply refuse to be the thing that points the browser at an
          // address we do not trust.
          setDone({ decision: choice, redirectRefused: true });
        },
      },
    );
  };

  if (done !== null) {
    return (
      <>
        <h1 className={styles.title}>
          {t(done.decision === 'allow' ? 'consent.doneAllowed' : 'consent.doneDenied')}
        </h1>
        {done.redirectRefused ? (
          <p className={styles.alert} role="alert">
            {t('consent.redirectRefused')}
          </p>
        ) : null}
      </>
    );
  }

  if (phase === 'loading') {
    // Shaped and sized like the loaded card (heading, two meta lines, two option
    // cards, a button row) so the dialogue does not jump under the user's cursor.
    return (
      <div className={styles.skeleton} aria-hidden="true">
        <div className={styles.skeletonTitle} />
        <div className={styles.skeletonLine} />
        <div className={styles.skeletonLine} />
        <div className={styles.skeletonOption} />
        <div className={styles.skeletonOption} />
        <div className={styles.skeletonActions} />
      </div>
    );
  }

  // A grant is NEVER offered on data we could not read: both failing arms render
  // the notice and no Allow/Deny at all.
  if (phase === 'unreachable') {
    return (
      <QueryStateNotice
        phase={phase}
        message={t('consent.loadFailed')}
        onRetry={() => {
          void requestQuery.refetch();
        }}
      />
    );
  }

  if (phase === 'error') {
    const failure = describeOAuthError(requestQuery.error, lang, t);
    // A consumed or expired request cannot come back, so that arm gets copy that
    // says where to go instead of a Retry that can only 404 again.
    return failure.kind === 'request-gone' ? (
      <p className={styles.alert} role="alert">
        {failure.message}
      </p>
    ) : (
      <QueryStateNotice
        phase={phase}
        message={failure.message}
        onRetry={() => {
          void requestQuery.refetch();
        }}
      />
    );
  }

  const request = requestQuery.data;
  if (!request) return null;

  // The app's own self-declared name, rendered as TEXT (React escapes it; there
  // is no dangerouslySetInnerHTML anywhere near this page) under a line that says
  // whose claim it is — so a hostile `client_name` cannot borrow our authority.
  const appName = request.client_name ?? t('consent.unknownApp');
  const pending = decision.isPending;
  // WHICH button is in flight, so only its own label flips (both are disabled):
  // the mutation's variables are the honest source for that, no second state.
  const pendingChoice = pending ? decision.variables?.decision : undefined;
  const failure = decision.isError ? describeOAuthError(decision.error, lang, t) : null;

  return (
    <>
      <h1 className={styles.title}>{t('consent.title', { app: appName })}</h1>
      <p className={styles.disclaimer}>{t('consent.nameDeclared')}</p>

      <p className={styles.meta}>
        {t('consent.redirectHost')} <span className={styles.host}>{request.redirect_host}</span>
      </p>
      {request.loopback ? (
        <p className={styles.loopback}>
          <Badge tone="warning">{t('consent.loopbackBadge')}</Badge>
          {t('consent.loopbackBody')}
        </p>
      ) : null}

      <fieldset className={styles.field} disabled={pending}>
        <legend className={styles.legend}>{t('consent.modeLegend')}</legend>
        {/* Plain language, and the same two labels the tokens section uses — the
            two screens must never name one mode differently. */}
        <div className={styles.modeGroup}>
          <label className={styles.modeOption}>
            <input
              type="radio"
              name="consent-mode"
              value="read"
              checked={mode === 'read'}
              onChange={() => setMode('read')}
            />
            <span className={styles.modeText}>
              <span className={styles.modeTitle}>{t('tokens.scopeRead')}</span>
              <span className={styles.modeBody}>{t('consent.modeReadBody')}</span>
            </span>
          </label>
          <label className={styles.modeOption}>
            <input
              type="radio"
              name="consent-mode"
              value="full"
              checked={mode === 'full'}
              onChange={() => setMode('full')}
            />
            <span className={styles.modeText}>
              <span className={styles.modeTitle}>{t('tokens.scopeFull')}</span>
              <span className={styles.modeBody}>{t('consent.modeFullBody')}</span>
            </span>
          </label>
        </div>
      </fieldset>

      {failure ? (
        <p className={styles.alert} role="alert">
          {failure.message}
        </p>
      ) : null}

      <div className={styles.actions}>
        <Button variant="ghost" onClick={() => submit('deny')} disabled={pending}>
          {t(pendingChoice === 'deny' ? 'consent.denying' : 'consent.deny')}
        </Button>
        <Button variant="primary" onClick={() => submit('allow')} disabled={pending}>
          {t(pendingChoice === 'allow' ? 'consent.allowing' : 'consent.allow')}
        </Button>
      </div>
    </>
  );
}
