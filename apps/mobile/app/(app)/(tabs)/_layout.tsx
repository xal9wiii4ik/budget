import { Tabs } from 'expo-router';

import { LogoutButton } from '../../../src/components/LogoutButton';
import { colors } from '../../../src/components/theme';
import { useT } from '../../../src/i18n/context';

// App shell: three peer destinations the user switches freely between (Tabs — the
// textbook case, mirrors web's persistent top-nav). Bottom inset is respected
// automatically by the tab bar.
//
// accounts-and-transfers MOB: Accounts is a THIRD tab rather than a settings hub
// with one screen in it — three is a normal bottom-tab count, and it mirrors the
// web navigation. The auth guard and the `next` deep-link machinery live one level
// up (app/(app)/_layout.tsx) and are untouched by this addition.
export default function TabsLayout() {
  const t = useT();

  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        headerRight: () => <LogoutButton />,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
      }}
    >
      <Tabs.Screen name="transactions" options={{ title: t('tabs.transactions') }} />
      <Tabs.Screen name="categories" options={{ title: t('tabs.categories') }} />
      <Tabs.Screen name="accounts" options={{ title: t('tabs.accounts') }} />
      {/* --- goals (catch-up 3, line C) ---
          Goals is a peer destination, like web's nav item, and it sits BEFORE
          "More": "More" is the overflow and must stay last. */}
      <Tabs.Screen name="goals" options={{ title: t('tabs.goals') }} />
      {/* --- recurring / settings (catch-up 3, line B) ---
          "More" is LAST, the platform convention for the overflow destination: it
          holds the way into recurring templates and the three profile settings
          (language, base currency, declared income). Log out stays in the header
          above it — it belongs to every screen, not to one tab. */}
      <Tabs.Screen name="more" options={{ title: t('tabs.more') }} />
    </Tabs>
  );
}
