import { Redirect, Tabs } from 'expo-router';

import { LoadingState } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { useTheme } from '@/theme';

/**
 * Main navigation.
 *
 * Five tabs, as approved: Home, Diary, Scan, Train, Progress. "Diary" rather
 * than "Food" because the tab is a day view.
 *
 * Scan is a real route in Phase 0 so the tab bar is complete; Phase 3 converts
 * it to a sheet that opens the camera directly, since landing on a hub screen
 * of four buttons wastes a tap on the app's most-used shortcut.
 *
 * Icons arrive with the design pass — text labels keep the tab bar readable
 * and accessible until then.
 */
export default function TabsLayout() {
  const { status } = useAuth();
  const theme = useTheme();

  if (status === 'restoring') return <LoadingState label="Loading your day" />;
  if (status === 'signedOut') return <Redirect href="/(auth)/sign-in" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        sceneStyle: { backgroundColor: theme.colors.background },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="diary" options={{ title: 'Diary' }} />
      <Tabs.Screen name="scan" options={{ title: 'Scan' }} />
      <Tabs.Screen name="train" options={{ title: 'Train' }} />
      <Tabs.Screen name="progress" options={{ title: 'Progress' }} />
    </Tabs>
  );
}
