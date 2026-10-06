// Which ONE thing the notifications section says on this device (web-push W1).
//
// PURE: every environment fact arrives as an argument, so the whole decision is
// testable under vitest's node environment. The hook's `readPushEnvironment()`
// is the only place that touches `navigator` / `window`.

export type NotificationsArm =
  | 'ios-not-installed'
  | 'unsupported'
  | 'server-off'
  | 'denied'
  | 'on'
  | 'off';

/** The arms decided by the DEVICE alone — rendered before the server answers. */
export type DeviceArm = Extract<NotificationsArm, 'ios-not-installed' | 'unsupported'>;

export interface DeviceFacts {
  /** Service worker + PushManager + Notification in a secure context. */
  supported: boolean;
  isIOS: boolean;
  /** Running as a Home-Screen install (standalone display mode). */
  standalone: boolean;
}

export interface NotificationsInput extends DeviceFacts {
  permission: NotificationPermission;
  /** The server has VAPID keys (`enabled` AND a public key). */
  serverEnabled: boolean;
  /** The browser holds a push subscription. */
  subscribed: boolean;
}

/**
 * The device-only arms, or `null` when the device can do push and the answer
 * depends on the server and the permission.
 *
 * `ios-not-installed` comes FIRST: iOS Safari in a tab exposes neither
 * `PushManager` nor `Notification` (push is for Home-Screen web apps only), so
 * with `unsupported` first every iPhone in a tab would get a dead end instead of
 * the one instruction that helps. An installed iOS < 16.4 app is standalone and
 * correctly falls through to `unsupported`.
 */
export function deviceArm({ supported, isIOS, standalone }: DeviceFacts): DeviceArm | null {
  if (isIOS && !standalone) return 'ios-not-installed';
  if (!supported) return 'unsupported';
  return null;
}

/**
 * Precedence: `ios-not-installed → unsupported → server-off → denied → on|off`.
 *
 * `server-off` outranks `denied`: nothing the user does on the device helps
 * while the server has no keys, so sending them to the OS settings first would
 * be a wasted trip. `on` needs BOTH a subscription and a granted permission — a
 * subscription whose permission was revoked is `denied`, by the order above.
 */
export function notificationsState(input: NotificationsInput): NotificationsArm {
  const early = deviceArm(input);
  if (early !== null) return early;
  if (!input.serverEnabled) return 'server-off';
  if (input.permission === 'denied') return 'denied';
  return input.subscribed && input.permission === 'granted' ? 'on' : 'off';
}

export interface PushEnvironmentFlags {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  secureContext: boolean;
}

export function supportsPush(env: PushEnvironmentFlags): boolean {
  return env.hasServiceWorker && env.hasPushManager && env.hasNotification && env.secureContext;
}

/**
 * iPhone / iPod / iPad. iPadOS Safari sends a DESKTOP Mac user agent, so an iPad
 * is told apart from a Mac by touch: `MacIntel` with more than one touch point.
 * A real Mac must NOT get the install arm — desktop Safari pushes from a tab.
 */
export function isIOSDevice({
  userAgent,
  platform,
  maxTouchPoints,
}: {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  return platform === 'MacIntel' && maxTouchPoints > 1;
}

/** Either signal is enough: iOS sets `navigator.standalone`, others the media query. */
export function isStandalone({
  navigatorStandalone,
  displayModeStandalone,
}: {
  navigatorStandalone: boolean;
  displayModeStandalone: boolean;
}): boolean {
  return navigatorStandalone || displayModeStandalone;
}
