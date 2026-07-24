// API base-URL resolution (plan §C/S6). The base URL is the ONLY config the client
// holds (plus the user's tokens) — no secrets in the bundle or app.json.
//
// Precedence:
//   1. EXPO_PUBLIC_API_URL (explicit override) always wins — dev override AND the
//      required production/EAS value.
//   2. Else in __DEV__, derive the host from Metro's hostUri (the dev machine's LAN
//      address Metro already serves from), and target the dev API port :8010. Both
//      an iOS simulator (shares the Mac network) and a physical Expo Go device on
//      the same Wi-Fi reach it.
//   3. Else throw a clear error at client construction (a release build with no
//      override) — mirrors web's VITE_API_URL guard.
//
// Honest failure modes: a device on a DIFFERENT network than the Mac, or a
// dev-client/tunnel config with no hostUri, hits case 3 — set EXPO_PUBLIC_API_URL.
import Constants from 'expo-constants';

const DEV_API_PORT = 8010;

function derivedDevBaseUrl(): string | null {
  const hostUri =
    Constants.expoConfig?.hostUri ??
    // Fallback for classic Expo Go debuggerHost shape.
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)?.debuggerHost;
  if (!hostUri) return null;
  const host = hostUri.split(':')[0];
  if (!host) return null;
  return `http://${host}:${DEV_API_PORT}`;
}

export function resolveBaseUrl(): string {
  const override = process.env.EXPO_PUBLIC_API_URL;
  if (override) return override;

  if (__DEV__) {
    const derived = derivedDevBaseUrl();
    if (derived) return derived;
  }

  throw new Error(
    'EXPO_PUBLIC_API_URL is not set and no Metro host could be derived. Set ' +
      'EXPO_PUBLIC_API_URL (e.g. http://<host>:8010) before building/running the ' +
      'mobile client.',
  );
}
