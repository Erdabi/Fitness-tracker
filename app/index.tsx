import { Redirect } from 'expo-router';

import { LoadingState } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';

/**
 * Route guard.
 *
 * The three-state auth status matters here: while `restoring` we render a
 * loading state rather than redirecting, because sending someone to sign-in
 * for one frame before restoring their session is a visible flash and, on a
 * slow device, a genuine wrong turn.
 */
export default function Index() {
  const { status } = useAuth();

  if (status === 'restoring') {
    return <LoadingState label="Signing you in" />;
  }

  return status === 'signedIn' ? (
    <Redirect href="/(tabs)" />
  ) : (
    <Redirect href="/(auth)/sign-in" />
  );
}
