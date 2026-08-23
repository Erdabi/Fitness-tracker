import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Screen,
  Text,
  TextField,
} from '@/components/ui';
import { getDatabase } from '@/db/client';
import { useAuth } from '@/features/auth/AuthProvider';
import { useDiaryTimeZone } from '@/features/diary/useDiary';
import { useGoalMutations } from '@/features/goals/useGoals';
import { WeightChart } from '@/features/progress/WeightChart';
import { loadProgress } from '@/features/progress/progressService';
import { useProfile } from '@/features/profile/useProfile';
import { validateWeight } from '@/lib/bodyInputs';
import { todayIn } from '@/lib/date';
import { formatWeight } from '@/lib/units';
import { formatWater } from '@/lib/water';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from '@/theme';

/**
 * Progress.
 *
 * Three summaries over a window, all computed on the device from rows it
 * already holds. Every figure is stated in words as well as drawn, because a
 * chart is not a reading of the data for everybody.
 */

const WINDOWS = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const;

export default function ProgressScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { userId } = useAuth();
  const { profile } = useProfile();
  const timeZone = useDiaryTimeZone();
  const today = todayIn(timeZone);
  const system = profile?.unit_system ?? 'metric';

  const [days, setDays] = useState<number>(30);
  const [isAdding, setIsAdding] = useState(false);
  const [draft, setDraft] = useState('');

  const { saveWeight } = useGoalMutations();
  const weightResult = validateWeight(draft, system);

  const query = useQuery({
    queryKey: ['progress', userId ?? 'anonymous', today, days],
    enabled: userId !== null,
    queryFn: () => (userId ? loadProgress(userId, today, days, getDatabase()) : null),
  });

  if (query.isLoading) return <LoadingState label="Loading progress" />;

  if (query.error || !query.data) {
    return (
      <Screen>
        <ErrorState
          title="Could not load progress"
          description="Your data is still on this device. Try again."
          onRetry={() => void query.refetch()}
        />
      </Screen>
    );
  }

  const { weight, calories, water } = query.data;

  return (
    <Screen scrollable keyboardAvoiding>
      <View style={{ paddingTop: theme.spacing.lg, gap: theme.spacing.sm }}>
        <Text variant="displayMedium">Progress</Text>
        <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
          {WINDOWS.map((window) => (
            <Button
              key={window.days}
              label={window.label}
              variant={days === window.days ? 'primary' : 'secondary'}
              fullWidth={false}
              style={{ flex: 1 }}
              onPress={() => setDays(window.days)}
            />
          ))}
        </View>
      </View>

      {/* ---------------------------------------------------------- weight */}

      <Card>
        <Text variant="overline" color="secondary">
          Weight
        </Text>

        {!weight.current ? (
          <View style={{ paddingVertical: theme.spacing.md }}>
            <EmptyState
              title="No weight entries yet"
              description="Record one to start tracking how it moves."
              actionLabel="Add a weight"
              onAction={() => setIsAdding(true)}
            />
          </View>
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
              <Figure
                label="Current"
                value={formatWeight(weight.current.weight_kg, system)}
              />
              {weight.starting && weight.starting.id !== weight.current.id ? (
                <Figure
                  label="Starting"
                  value={formatWeight(weight.starting.weight_kg, system)}
                />
              ) : null}
              {weight.changeKg !== null ? (
                <Figure
                  label="Change"
                  value={`${weight.changeKg > 0 ? '+' : weight.changeKg < 0 ? '−' : '±'}${formatWeight(
                    Math.abs(weight.changeKg),
                    system,
                  )}`}
                  tone={weight.changeKg < 0 ? 'success' : weight.changeKg > 0 ? 'warning' : 'muted'}
                />
              ) : null}
            </View>

            <WeightChart entries={weight.entries} system={system} />

            <Text variant="caption" color="muted">
              {weight.weeklyRateKg === null
                ? `One reading in the last ${days} days.`
                : `${weight.entries.length} readings in the last ${days} days, averaging ${
                    weight.weeklyRateKg > 0 ? '+' : weight.weeklyRateKg < 0 ? '−' : '±'
                  }${formatWeight(Math.abs(weight.weeklyRateKg), system)} a week.`}
            </Text>
          </>
        )}

        {isAdding ? (
          <View style={{ gap: theme.spacing.sm }}>
            <TextField
              label="Weight today"
              value={draft}
              onChangeText={setDraft}
              keyboardType="decimal-pad"
              hint={system === 'metric' ? 'kg' : 'lb'}
              error={
                draft.length > 0 && !weightResult.ok
                  ? weightResult.errors[0]!.message
                  : undefined
              }
            />
            <Text variant="caption" color="muted">
              A weight entry is a measurement, not a goal — recording it never changes
              a calorie or water target you already set.
            </Text>
            <Button
              label="Save"
              disabled={!weightResult.ok}
              onPress={() => {
                if (!weightResult.ok) return;
                saveWeight({ measuredOn: today, weightKg: weightResult.value });
                setDraft('');
                setIsAdding(false);
                void query.refetch();
              }}
            />
            <Button label="Cancel" variant="ghost" onPress={() => setIsAdding(false)} />
          </View>
        ) : weight.current ? (
          <Button
            label="Record today's weight"
            variant="secondary"
            onPress={() => setIsAdding(true)}
          />
        ) : null}
      </Card>

      {/* -------------------------------------------------------- calories */}

      <Card>
        <Text variant="overline" color="secondary">
          Calories
        </Text>

        {calories.daysLogged === 0 ? (
          <Text variant="body" color="secondary">
            No food logged in the last {days} days.
          </Text>
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
              <Figure
                label="Daily average"
                value={`${calories.averageKcal.toLocaleString()} kcal`}
              />
              <Figure
                label="Days logged"
                value={`${calories.daysLogged} / ${calories.daysInRange}`}
              />
            </View>

            <Text variant="caption" color="muted">
              {calories.daysWithGoal === 0
                ? 'No calorie goal was set during this period.'
                : `On target on ${calories.daysOnTarget} of the ${calories.daysWithGoal} days that had a goal, counting anything within 10% of it. Each day is measured against the goal that applied that day.`}
            </Text>
          </>
        )}
      </Card>

      {/* ----------------------------------------------------------- water */}

      <Card>
        <Text variant="overline" color="secondary">
          Water
        </Text>

        {water.daysLogged === 0 ? (
          <Text variant="body" color="secondary">
            No water logged in the last {days} days.
          </Text>
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
              <Figure label="Daily average" value={formatWater(water.averageMl, system)} />
              <Figure
                label="Goal met"
                value={`${water.daysGoalMet} / ${water.daysInRange}`}
              />
            </View>

            <Text variant="caption" color="muted">
              Logged on {water.daysLogged} of {water.daysInRange} days. The average is
              over the whole period, so days with nothing recorded count as zero.
            </Text>
          </>
        )}

        <Button
          label="Water history"
          variant="secondary"
          onPress={() => router.push('/water')}
        />
      </Card>
    </Screen>
  );
}

function Figure({
  label,
  value,
  tone = 'primary',
}: {
  label: string;
  value: string;
  tone?: 'primary' | 'success' | 'warning' | 'muted';
}) {
  return (
    <View style={{ gap: 2 }} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text variant="title" color={tone} tabular>
        {value}
      </Text>
      <Text variant="overline" color="muted">
        {label}
      </Text>
    </View>
  );
}
