// The notifications section's flows (web-push W1).
//
// Two sources of truth, kept apart: the server's push CONFIG is a Query read
// (data/push.ts); the browser's SUBSCRIPTION is browser state, read from
// `pushManager.getSubscription()` and held here in component state — never in
// the Query cache, never in Zustand.
//
// Three rules this file exists to keep:
//   - Reading never uses `serviceWorker.ready`: it never settles while nothing
//     is registered (every `vite dev` session before the first Enable), which
//     would be an eternal skeleton. `getRegistration()` answers `undefined`.
//   - The permission prompt is requested ONLY inside the Enable click handler,
//     and FIRST there — before any `await` — iOS refuses it anywhere else and
//     needs the gesture's transient activation, which a first-time service
//     worker install could burn. A prompt on page load is hostile anyway.
//   - `on` never lies: if the server did not take the subscription, the browser
//     subscription is rolled back.
//
// Enable order: `Notification.requestPermission()` → (granted only)
// `register('/sw.js')` → `serviceWorker.ready` → `pushManager.subscribe` →
// POST, rolling the browser subscription back if the POST fails.
import { useEffect, useRef, useState } from 'react';

import {
  usePushConfig,
  useSendTestPush,
  useSubscribePush,
  useUnsubscribePush,
  type PushSubscriptionCreate,
} from '../../data/push';
import { useLang, useT } from '../../i18n/context';
import { describePushError } from '../../lib/errors';
import { queryPhase } from '../../lib/queryPhase';
import {
  deviceArm,
  isIOSDevice,
  isStandalone,
  notificationsState,
  supportsPush,
  type NotificationsArm,
} from './notificationsState';
import { sameServerKey, urlBase64ToUint8Array } from './pushKeys';

interface PushEnvironment {
  supported: boolean;
  isIOS: boolean;
  standalone: boolean;
  permission: NotificationPermission;
}

// The only reader of the globals; everything it feeds is pure.
function readPushEnvironment(): PushEnvironment {
  const hasNotification = 'Notification' in window;
  const supported = supportsPush({
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification,
    secureContext: window.isSecureContext,
  });
  // An `in`-narrowing, not a cast: `navigator.standalone` is iOS-only and not in
  // the DOM lib.
  const navigatorStandalone = 'standalone' in navigator && navigator.standalone === true;
  const displayModeStandalone = window.matchMedia('(display-mode: standalone)').matches;
  return {
    supported,
    isIOS: isIOSDevice({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    }),
    standalone: isStandalone({ navigatorStandalone, displayModeStandalone }),
    permission: hasNotification ? Notification.permission : 'default',
  };
}

async function readSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  return registration ? registration.pushManager.getSubscription() : null;
}

/** The POST body, or `null` when the browser handed back an incomplete subscription. */
function subscriptionBody(
  subscription: PushSubscription,
  lang: PushSubscriptionCreate['lang'],
): PushSubscriptionCreate | null {
  const json = subscription.toJSON();
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
    return null;
  }
  return {
    endpoint,
    keys: { p256dh, auth },
    lang,
    // The column is String(255); the server only keeps it to tell rows apart.
    user_agent: navigator.userAgent.slice(0, 255),
  };
}

type LocalSubscription =
  | { status: 'checking' }
  | { status: 'ready'; subscription: PushSubscription | null };

export type NotificationsView =
  | { status: 'loading' }
  | { status: 'config-error'; phase: 'error' | 'unreachable'; retry: () => void }
  | { status: 'ready'; arm: NotificationsArm };

/** A `role="status"` line: what just happened, in the section's own words. */
export type NotificationsOutcome =
  | { kind: 'test-sent'; sent: number; removed: number }
  /**
   * `{sent: 0, removed > 0}`: the push service said this device is gone; it was
   * unsubscribed here too, so the Enable button is back on screen.
   */
  | { kind: 'test-lost' }
  /**
   * `{sent: 0, removed: 0}`: nothing delivered, nothing removed — a transient
   * push-service failure or a row the server lost. The device is kept and
   * re-registered (idempotent upsert), never unsubscribed.
   */
  | { kind: 'test-none' }
  /** Off on this device, but the server was not told (it drops the row itself). */
  | { kind: 'server-not-told' }
  /** The server's VAPID key changed; the old subscription was dropped. */
  | { kind: 'key-rotated' };

type Busy = null | 'enabling' | 'disabling' | 'testing';

export function useNotifications() {
  const t = useT();
  const lang = useLang();
  const [env] = useState(readPushEnvironment);
  const early = deviceArm(env);

  const configQuery = usePushConfig({ enabled: early === null });
  const config = configQuery.data;
  // `enabled` with no key would be a server bug; it reads as server-off.
  const serverKey = config?.enabled && config.public_key ? config.public_key : null;

  const [local, setLocal] = useState<LocalSubscription>(() =>
    env.supported ? { status: 'checking' } : { status: 'ready', subscription: null },
  );
  const [permission, setPermission] = useState<NotificationPermission>(env.permission);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [outcome, setOutcome] = useState<NotificationsOutcome | undefined>(undefined);

  const { mutateAsync: postSubscription, mutate: resyncSubscription } = useSubscribePush();
  const { mutateAsync: postUnsubscribe, mutate: forgetSubscription } = useUnsubscribePush();
  const { mutateAsync: postTest } = useSendTestPush();

  // Read what this browser already holds. A real external read, hence an effect;
  // the state is set only when it answers.
  useEffect(() => {
    if (!env.supported) return;
    let cancelled = false;
    readSubscription().then(
      (subscription) => {
        if (!cancelled) setLocal({ status: 'ready', subscription });
      },
      () => {
        if (!cancelled) setLocal({ status: 'ready', subscription: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [env.supported]);

  // Re-sync (arch §7), once per mount of the section: re-POST the subscription
  // (an idempotent upsert that heals a row the server deleted), unless it was
  // made with a key the server no longer has — then it is dead at the push
  // service and re-POSTing cannot fix it, so it is dropped on both sides and the
  // section shows `off`. No silent re-subscribe: Safari needs a gesture for it.
  // The ref keeps React 19 StrictMode's double effect to ONE request (refs
  // survive the dev double-invoke).
  const resynced = useRef(false);
  const subscription = local.status === 'ready' ? local.subscription : null;
  useEffect(() => {
    if (resynced.current) return;
    if (serverKey === null || subscription === null) return;
    if (permission !== 'granted') return;
    resynced.current = true;

    if (!sameServerKey(subscription.options.applicationServerKey, serverKey)) {
      const endpoint = subscription.endpoint;
      void subscription
        .unsubscribe()
        .catch(() => false)
        .then(() => {
          setLocal({ status: 'ready', subscription: null });
          setOutcome({ kind: 'key-rotated' });
          forgetSubscription({ endpoint });
        });
      return;
    }

    const body = subscriptionBody(subscription, lang);
    if (body !== null) resyncSubscription(body);
  }, [serverKey, subscription, permission, lang, resyncSubscription, forgetSubscription]);

  const configPhase = queryPhase(configQuery);
  let view: NotificationsView;
  if (early !== null) {
    view = { status: 'ready', arm: early };
  } else if (configPhase === 'error' || configPhase === 'unreachable') {
    view = {
      status: 'config-error',
      phase: configPhase,
      retry: () => {
        void configQuery.refetch();
      },
    };
  } else if (configPhase === 'loading' || config === undefined || local.status === 'checking') {
    view = { status: 'loading' };
  } else {
    view = {
      status: 'ready',
      arm: notificationsState({
        ...env,
        permission,
        serverEnabled: serverKey !== null,
        subscribed: subscription !== null,
      }),
    };
  }

  // An arm change caused by a click UNMOUNTS the button that was clicked (off →
  // on, off → denied, on → off after Disable or a lost test), which would drop
  // a keyboard user on <body>. The section's heading exists in every arm, so it
  // takes focus. `armAtBegin` is set only by a user action, so neither the mount
  // nor the mount re-sync (key rotation → off) ever moves focus.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const armAtBegin = useRef<NotificationsArm | null | undefined>(undefined);
  const currentArm = view.status === 'ready' ? view.arm : null;
  useEffect(() => {
    if (busy !== null || armAtBegin.current === undefined) return;
    const before = armAtBegin.current;
    armAtBegin.current = undefined;
    if (currentArm !== before) headingRef.current?.focus();
  }, [busy, currentArm]);

  const begin = (next: Exclude<Busy, null>) => {
    // A user action supersedes the mount re-sync (Enable would otherwise be
    // followed by a second POST of the subscription it just created).
    resynced.current = true;
    armAtBegin.current = currentArm;
    setBusy(next);
    setError(undefined);
    setOutcome(undefined);
  };

  const enable = async () => {
    if (!serverKey) return;
    begin('enabling');
    try {
      let created: PushSubscription;
      try {
        // FIRST, before any await: the prompt must ride the click's transient
        // activation (iOS), which a first-time SW install could outlast.
        const answer = await Notification.requestPermission();
        setPermission(answer);
        // 'denied' flips the arm; 'default' (prompt dismissed) stays off, quietly.
        if (answer !== 'granted') return;
        await navigator.serviceWorker.register('/sw.js');
        const registration = await navigator.serviceWorker.ready;
        created = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(serverKey),
        });
      } catch {
        setError(t('settings.notifications.enableFailed'));
        return;
      }

      const body = subscriptionBody(created, lang);
      if (body === null) {
        await created.unsubscribe().catch(() => false);
        setError(t('settings.notifications.enableFailed'));
        return;
      }

      try {
        await postSubscription(body);
      } catch (failure) {
        // Rollback: a subscription the server does not know would read as `on`
        // and never receive anything.
        await created.unsubscribe().catch(() => false);
        setLocal({ status: 'ready', subscription: null });
        const described = describePushError(failure, lang, t);
        if (described.kind !== 'server-off') setError(described.message);
        return;
      }
      setLocal({ status: 'ready', subscription: created });
    } finally {
      setBusy(null);
    }
  };

  const disable = async () => {
    if (subscription === null) return;
    begin('disabling');
    const endpoint = subscription.endpoint;
    try {
      try {
        await subscription.unsubscribe();
      } catch {
        setError(t('settings.notifications.disableFailed'));
        return;
      }
      setLocal({ status: 'ready', subscription: null });
      try {
        await postUnsubscribe({ endpoint });
      } catch {
        // It IS off on this device; the server drops the row by itself on the
        // next send (the push service answers 410 for it).
        setOutcome({ kind: 'server-not-told' });
      }
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    begin('testing');
    try {
      const result = await postTest();
      if (result.sent === 0 && result.removed === 0 && subscription !== null) {
        // Same answer as a transient push-service failure (a `failed` send keeps
        // the row) or a row the server lost: never drop a possibly healthy
        // device. Re-POST it instead — an idempotent upsert heals a lost row.
        const body = subscriptionBody(subscription, lang);
        if (body !== null) resyncSubscription(body);
        setOutcome({ kind: 'test-none' });
        return;
      }
      if (result.sent === 0 && result.removed > 0 && subscription !== null) {
        // The push service said this device is gone. Drop it here too, so the
        // Enable button the copy points at is actually on screen.
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe().catch(() => false);
        setLocal({ status: 'ready', subscription: null });
        setOutcome({ kind: 'test-lost' });
        forgetSubscription({ endpoint });
        return;
      }
      setOutcome({ kind: 'test-sent', sent: result.sent, removed: result.removed });
    } catch (failure) {
      const described = describePushError(failure, lang, t);
      if (described.kind !== 'server-off') setError(described.message);
    } finally {
      setBusy(null);
    }
  };

  return {
    view,
    isIOS: env.isIOS,
    busy,
    error,
    outcome,
    headingRef,
    enable,
    disable,
    sendTest,
  };
}
