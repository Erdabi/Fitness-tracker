import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { Button, Card, Screen, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { useProfile } from '@/features/profile/useProfile';
import { useSyncStatus } from '@/sync/useSyncStatus';
import { useTheme, useThemePreference, type ThemePreference } from '@/theme';

const THEME_OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export default function SettingsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { session, signOut } = useAuth();
  const { profile } = useProfile();
  const { preference, setPreference } = useThemePreference();
  const { pendingCount, syncNow } = useSyncStatus();

  const [signingOut, setSigningOut] = useState(false);

  function handleSignOut(): void {
    // Signing out clears local data, so unsent writes would be lost. Say so
    // rather than discarding them silently.
    const warning =
      pendingCount > 0
        ? `You have ${pendingCount} change${pendingCount === 1 ? '' : 's'} that have not synced yet. Signing out now will discard them.`
        : 'You can sign back in at any time.';

    Alert.alert('Sign out?', warning, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setSigningOut(true);
            const result = await signOut();
            setSigningOut(false);

            if (!result.ok) {
              Alert.alert('Could not sign out', result.error.message);
              return;
            }
            router.replace('/(auth)/sign-in');
          })();
        },
      },
    ]);
  }

  return (
    <Screen scrollable>
      <Card>
        <Text variant="overline" color="muted">
          Account
        </Text>
        <Text variant="body">{session?.user.email ?? 'Not signed in'}</Text>
        {profile?.time_zone ? (
          <Text variant="caption" color="muted">
            Days roll over in {profile.time_zone}
          </Text>
        ) : null}
      </Card>

      <Card>
        <Text variant="overline" color="muted">
          Appearance
        </Text>
        <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
          {THEME_OPTIONS.map((option) => (
            <Button
              key={option.value}
              label={option.label}
              variant={preference === option.value ? 'primary' : 'secondary'}
              fullWidth={false}
              style={{ flex: 1 }}
              onPress={() => setPreference(option.value)}
            />
          ))}
        </View>
      </Card>

      <Card>
        <Text variant="overline" color="muted">
          Sync
        </Text>
        <Text variant="body" color="secondary">
          {pendingCount > 0
            ? `${pendingCount} change${pendingCount === 1 ? '' : 's'} waiting to upload.`
            : 'Everything is synced.'}
        </Text>
        <Button label="Sync now" variant="secondary" onPress={syncNow} />
      </Card>

      <View style={{ flex: 1 }} />

      <Button
        label="Sign out"
        variant="danger"
        loading={signingOut}
        onPress={handleSignOut}
      />
    </Screen>
  );
}
