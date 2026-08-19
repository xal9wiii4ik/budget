import { Tabs } from 'expo-router';

import { LogoutButton } from '../../../src/components/LogoutButton';
import { colors } from '../../../src/components/theme';

// App shell: three peer destinations the user switches freely between (Tabs — the
// textbook case, mirrors web's persistent top-nav). Bottom inset is respected
// automatically by the tab bar.
//
// accounts-and-transfers MOB: Accounts is a THIRD tab rather than a settings hub
// with one screen in it — three is a normal bottom-tab count, and it mirrors the
// web navigation. The auth guard and the `next` deep-link machinery live one level
// up (app/(app)/_layout.tsx) and are untouched by this addition.
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        headerRight: () => <LogoutButton />,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
      }}
    >
      <Tabs.Screen name="transactions" options={{ title: 'Transactions' }} />
      <Tabs.Screen name="categories" options={{ title: 'Categories' }} />
      <Tabs.Screen name="accounts" options={{ title: 'Accounts' }} />
    </Tabs>
  );
}
