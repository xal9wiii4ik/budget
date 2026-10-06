import { describe, expect, it } from 'vitest';

import { isIOSDevice, notificationsState, type NotificationsInput } from './notificationsState';

// A desktop browser that can do everything, with the server configured and the
// permission not asked yet — each row below changes only what it is about.
const base: NotificationsInput = {
  supported: true,
  isIOS: false,
  standalone: false,
  permission: 'default',
  serverEnabled: true,
  subscribed: false,
};

describe('notificationsState', () => {
  it('reaches every arm', () => {
    const rows: [Partial<NotificationsInput>, string][] = [
      [{ isIOS: true, supported: false }, 'ios-not-installed'],
      [{ supported: false }, 'unsupported'],
      [{ serverEnabled: false }, 'server-off'],
      [{ permission: 'denied' }, 'denied'],
      [{ permission: 'granted', subscribed: true }, 'on'],
      [{}, 'off'],
      // Granted but no subscription (or subscribed with the prompt never
      // answered) is not "on": the Enable button is what fixes it.
      [{ permission: 'granted' }, 'off'],
      [{ subscribed: true }, 'off'],
      // An installed iPhone app on iOS < 16.4 has no PushManager: unsupported,
      // not the install instruction it has already followed.
      [{ isIOS: true, standalone: true, supported: false }, 'unsupported'],
    ];
    for (const [overrides, arm] of rows) {
      expect(notificationsState({ ...base, ...overrides }), JSON.stringify(overrides)).toBe(arm);
    }
  });

  it('puts server-off before denied, and the iOS install arm before unsupported', () => {
    // Nothing the user can do on the device helps while the server has no keys.
    expect(notificationsState({ ...base, serverEnabled: false, permission: 'denied' })).toBe(
      'server-off',
    );
    // iOS Safari in a tab exposes no PushManager — the tab must still be told how
    // to install, not that push is impossible.
    expect(
      notificationsState({ ...base, isIOS: true, standalone: false, supported: false, serverEnabled: false }),
    ).toBe('ios-not-installed');
  });

  it('treats an iPad (desktop UA + touch) as iOS and a Mac as not', () => {
    const desktopSafariUA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/17.4 Safari/605.1.15';
    expect(isIOSDevice({ userAgent: desktopSafariUA, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(
      true,
    );
    expect(isIOSDevice({ userAgent: desktopSafariUA, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(
      false,
    );
  });
});
