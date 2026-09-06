import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import type { ColorValue } from 'react-native';

import { LogoutButton } from '../../../src/components/LogoutButton';
import { colors } from '../../../src/components/theme';
import { useT } from '../../../src/i18n/context';

// ICONS (defect: the bar shipped with expo-router's placeholder triangles and five
// words). `@expo/vector-icons` is the set Expo ships with — no new native module, it
// is JS + a font, and Expo Go carries it. Each tab names a FILLED glyph when it is
// the active one and its outline twin otherwise, which is the iOS convention; the
// colour comes from `tabBarActiveTintColor` / `tabBarInactiveTintColor` above, so
// there is exactly one place that decides the accent. The label stays: an icon alone
// would make "Ещё" and "Цели" guesswork.
//
// App shell: three peer destinations the user switches freely between (Tabs — the
// textbook case, mirrors web's persistent top-nav). Bottom inset is respected
// automatically by the tab bar.
//
// accounts-and-transfers MOB: Accounts is a THIRD tab rather than a settings hub
// with one screen in it — three is a normal bottom-tab count, and it mirrors the
// web navigation. The auth guard and the `next` deep-link machinery live one level
// up (app/(app)/_layout.tsx) and are untouched by this addition.
type IoniconName = ComponentProps<typeof Ionicons>['name'];

const ICON_SIZE = 24;

/**
 * One tab's icon, in both states. `focused` picks the filled glyph, `color` is the
 * bar's own active/inactive tint — nothing here decides a colour of its own.
 */
function tabIcon(active: IoniconName, inactive: IoniconName) {
  return function TabBarIcon({ focused, color }: { focused: boolean; color: ColorValue }) {
    return <Ionicons name={focused ? active : inactive} size={ICON_SIZE} color={color} />;
  };
}

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
      <Tabs.Screen
        name="transactions"
        options={{
          title: t('tabs.transactions'),
          // The two arrows web's nav uses for the same destination: money moving.
          tabBarIcon: tabIcon('swap-horizontal', 'swap-horizontal-outline'),
        }}
      />
      <Tabs.Screen
        name="categories"
        options={{
          title: t('tabs.categories'),
          tabBarIcon: tabIcon('pricetags', 'pricetags-outline'),
        }}
      />
      <Tabs.Screen
        name="accounts"
        options={{ title: t('tabs.accounts'), tabBarIcon: tabIcon('card', 'card-outline') }}
      />
      {/* --- goals (catch-up 3, line C) ---
          Goals is a peer destination, like web's nav item, and it sits BEFORE
          "More": "More" is the overflow and must stay last. */}
      <Tabs.Screen
        name="goals"
        options={{ title: t('tabs.goals'), tabBarIcon: tabIcon('flag', 'flag-outline') }}
      />
      {/* --- recurring / settings (catch-up 3, line B) ---
          "More" is LAST, the platform convention for the overflow destination: it
          holds the way into recurring templates and the three profile settings
          (language, base currency, declared income). Log out stays in the header
          above it — it belongs to every screen, not to one tab. */}
      <Tabs.Screen
        name="more"
        options={{
          title: t('tabs.more'),
          // The platform's own overflow glyph — the one thing "More" can be drawn as
          // without claiming to be a destination of its own.
          tabBarIcon: tabIcon('ellipsis-horizontal', 'ellipsis-horizontal-outline'),
        }}
      />
    </Tabs>
  );
}
