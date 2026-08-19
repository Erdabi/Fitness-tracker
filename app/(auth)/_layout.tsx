import { Redirect, Stack } from 'expo-router';

import { LoadingState } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { useTheme } from '@/theme';

/** Auth routes. A signed-in user is bounced to the app. */
export default function AuthLayout() {
  const { status } = useAuth();
  const theme = useTheme();

  if (status === 'restoring') return <LoadingState label="Signing you in" />;
  if (status === 'signedIn') return <Redirect href="/(tabs)" />;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    />
  );
}
