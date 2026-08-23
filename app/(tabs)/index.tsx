import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { Button, Card, ErrorState, Screen, Text } from '@/components/ui';
import { formatFullDay } from '@/features/diary/DayNavigator';
import { SyncNotice } from '@/features/diary/SyncNotice';
import { CalorieCard, CalorieCardSkeleton } from '@/features/dashboard/CalorieCard';
import { DashboardSection } from '@/features/dashboard/DashboardSection';
import { WaterCard, WaterCardSkeleton } from '@/features/dashboard/WaterCard';
import { WeightCard, WeightCardSkeleton } from '@/features/dashboard/WeightCard';
import { useDashboard } from '@/features/dashboard/useDashboard';
import { useProfile } from '@/features/profile/useProfile';
import { useWaterMutations, useSuggestedWaterTarget } from '@/features/water/useWater';
import { asLocalDay } from '@/lib/date';
import { useSyncStatus } from '@/sync/useSyncStatus';
import { useTheme } from '@/theme';

/**
 * The dashboard.
 *
 * A summary, not a source of truth: every figure comes from the repository
 * that owns it, through one composed read. Nothing here recalculates what the
 * diary already computed.
 *
 * It reads entirely from SQLite, so it renders with the radio off and a glass
 * of water logged on a plane appears immediately. Sync appears as a note, not
 * as a blocker — the server is never treated as authoritative for what the
 * device already knows.
 */
export default function HomeScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { profile } = useProfile();
  const { summary, today, isLoading, error, refetch } = useDashboard();
  const { addWater, setWaterGoal } = useWaterMutations();
  const { targetMl: suggestedMl, weightKg } = useSuggestedWaterTarget();
  const syncStatus = useSyncStatus();

  const system = profile?.unit_system ?? 'metric';

  return (
    <Screen scrollable>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          marginTop: theme.spacing.lg,
          gap: theme.spacing.md,
        }}
      >
        <View style={{ flex: 1, gap: theme.spacing.xs }}>
          <Text variant="overline" color="muted">
            {formatFullDay(asLocalDay(today))}
          </Text>
          <Text variant="displayMedium">
            {profile?.display_name ? `Hi, ${profile.display_name}` : 'Today'}
          </Text>
        </View>

        <Button
          label="Settings"
          variant="ghost"
          fullWidth={false}
          onPress={() => router.push('/settings')}
        />
      </View>

      <SyncNotice status={syncStatus} />

      {error ? (
        /*
         * The whole summary is one read, so one failure means the whole card
         * stack has nothing to show — but it must not take the screen down.
         * The header, sync notice and navigation above stay usable.
         */
        <Card>
          <ErrorState
            title="Could not load today"
            description="Your data is still on this device. Try again."
            onRetry={refetch}
          />
        </Card>
      ) : isLoading || !summary ? (
        <View style={{ gap: theme.spacing.md }}>
          <CalorieCardSkeleton />
          <WaterCardSkeleton />
          <WeightCardSkeleton />
        </View>
      ) : (
        <View style={{ gap: theme.spacing.md }}>
          {/*
            Each card is isolated: a render fault in one leaves the others,
            the header and the navigation working.
          */}
          <DashboardSection name="Calories">
            <CalorieCard
              totals={summary.food}
              goal={summary.calorieGoal}
              progress={summary.calories}
              onPress={() => router.push('/goals')}
            />
          </DashboardSection>

          <DashboardSection name="Water">
            <WaterCard
              water={summary.water}
              system={system}
              onAdd={addWater}
              onSetGoal={() =>
                setWaterGoal({
                  targetMl: suggestedMl,
                  recommendedMl: suggestedMl,
                  weightKg,
                })
              }
              onOpenHistory={() => router.push('/water')}
            />
          </DashboardSection>

          <DashboardSection name="Weight">
            <WeightCard
              trend={summary.weight}
              system={system}
              onPress={() => router.push('/(tabs)/progress')}
            />
          </DashboardSection>

          <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
            <View style={{ flex: 1 }}>
              <Button
                label="Log food"
                variant="secondary"
                onPress={() => router.push('/(tabs)/diary')}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                label="Progress"
                variant="secondary"
                onPress={() => router.push('/(tabs)/progress')}
              />
            </View>
          </View>
        </View>
      )}

      <Text
        variant="caption"
        color="muted"
        align="center"
        style={{ paddingVertical: theme.spacing.xl }}
      >
        Totals are for your local day, in {profile?.time_zone ?? 'your timezone'}.
      </Text>
    </Screen>
  );
}
