import { Tabs } from 'expo-router';

import { LogoutButton } from '../../../src/components/LogoutButton';
import { colors } from '../../../src/components/theme';

// App shell: two peer destinations the user switches freely between (Tabs — the
// textbook case, mirrors web's persistent top-nav). Bottom inset is respected
// automatically by the tab bar.
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
    </Tabs>
  );
}
