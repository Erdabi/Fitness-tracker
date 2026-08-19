import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { Button, Card, Screen, Skeleton, Text } from '@/components/ui';
import { useAuth } from '@/features/auth/AuthProvider';
import { useProfile } from '@/features/profile/useProfile';
import { todayIn } from '@/lib/date';
import { useSyncStatus } from '@/sync/useSyncStatus';
import { useTheme } from '@/theme';

/**
 * Home dashboard — Phase 0 shell.
 *
 * Real content arrives in Phase 1 (calorie ring, macro bars, water, training
 * status). What exists now is the structure those cards will occupy, plus the
 * two things that are genuinely working: the profile read from SQLite, and
 * live sync status.
 */
export default function HomeScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { userId } = useAuth();
  const { profile, isLoading } = useProfile();
  const syncStatus = useSyncStatus();

  const today = profile ? todayIn(profile.time_zone) : null;

  return (
    <Screen scrollable>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          marginTop: theme.spacing.xl,
          gap: theme.spacing.md,
        }}
      >
        <View style={{ flex: 1, gap: theme.spacing.xs }}>
          <Text variant="overline" color="muted">
            {today ?? 'Today'}
          </Text>
          {isLoading ? (
            <Skeleton height={34} width="70%" />
          ) : (
            <Text variant="displayMedium">
              {profile?.display_name ? `Hi, ${profile.display_name}` : 'Welcome'}
            </Text>
          )}
        </View>

        <Button
          label="Settings"
          variant="ghost"
          fullWidth={false}
          onPress={() => router.push('/settings')}
        />
      </View>

      <Card>
        <Text variant="overline" color="muted">
          Today
        </Text>
        <Text variant="body" color="secondary">
          Calories, macros, water and training will appear here once food logging lands in
          Phase 1.
        </Text>
      </Card>

      <Card>
        <Text variant="overline" color="muted">
          Foundation status
        </Text>
        <StatusRow label="Signed in" value={userId ? 'Yes' : 'No'} />
        <StatusRow
          label="Local database"
          value={isLoading ? 'Opening' : profile ? 'Ready' : 'Empty'}
        />
        <StatusRow
          label="Sync"
          value={describeSync(syncStatus.phase, syncStatus.pendingCount)}
        />
        {syncStatus.lastError ? (
          <Text variant="caption" color="warning">
            Last sync failed — it will retry automatically.
          </Text>
        ) : null}
      </Card>

      <Text variant="caption" color="muted">
        Phase 0 · foundation only. Food, training, scanning and AI are not built yet.
      </Text>
    </Screen>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      <Text variant="callout" color="secondary">
        {label}
      </Text>
      <Text variant="callout" tabular>
        {value}
      </Text>
    </View>
  );
}

function describeSync(phase: string, pending: number): string {
  if (phase === 'pushing') return 'Sending…';
  if (phase === 'pulling') return 'Fetching…';
  return pending > 0 ? `${pending} pending` : 'Up to date';
}
