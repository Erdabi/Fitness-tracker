import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';

import { Button, EmptyState, Screen, Text } from '@/components/ui';
import { describeDay } from '@/features/diary/DayNavigator';
import { useToday } from '@/features/diary/useDiary';
import {
  useActiveWorkout,
  useWorkoutHistory,
  useWorkoutMutations,
} from '@/features/training/useTraining';
import { asLocalDay } from '@/lib/date';
import { formatDuration } from '@/lib/training';
import { useTheme } from '@/theme';

/**
 * The Train tab.
 *
 * One decision shapes it: **an open session outranks everything else.** A user
 * who opens this tab mid-workout is standing between sets, and anything they
 * have to scroll past to get back to it is in the way. So a session in
 * progress takes the top of the screen as a single large target, and starting
 * a new one is pushed below it.
 */
export default function TrainScreen() {
  const theme = useTheme();
  const router = useRouter();
  const today = useToday();

  const { workout: active } = useActiveWorkout();
  const { workouts, isLoading } = useWorkoutHistory(20);
  const { start } = useWorkoutMutations();

  const past = workouts.filter((workout) => workout.id !== active?.id);

  return (
    <Screen scrollable>
      <View style={{ paddingTop: theme.spacing.lg, gap: theme.spacing.xs }}>
        <Text variant="displayMedium">Train</Text>
        <Text variant="body" color="secondary">
          Everything here works without a connection.
        </Text>
      </View>

      {active ? (
        <Pressable
          onPress={() => router.push({ pathname: '/workout/[id]', params: { id: active.id } })}
          accessibilityRole="button"
          accessibilityLabel={`Resume ${active.name}, in progress`}
          accessibilityHint="Opens the session you are part-way through."
          style={({ pressed }) => ({
            padding: theme.spacing.lg,
            borderRadius: theme.radius.lg,
            borderWidth: 2,
            borderColor: theme.colors.accent,
            backgroundColor: pressed ? theme.colors.accentMuted : theme.colors.surface,
            gap: theme.spacing.xs,
            minHeight: 96,
          })}
        >
          <Text variant="overline" color="accent">
            In progress
          </Text>
          <Text variant="headline">{active.name}</Text>
          <Text variant="callout" color="secondary">
            Tap to carry on
          </Text>
        </Pressable>
      ) : (
        <Button
          label="Start a workout"
          onPress={() => {
            const workout = start('Workout');
            if (workout) {
              router.push({ pathname: '/workout/[id]', params: { id: workout.id } });
            }
          }}
        />
      )}

      <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
        <Button
          label="Browse exercises"
          variant="secondary"
          fullWidth={false}
          style={{ flex: 1 }}
          onPress={() => router.push('/exercises')}
        />
        <Button
          label="New exercise"
          variant="secondary"
          fullWidth={false}
          style={{ flex: 1 }}
          onPress={() => router.push('/exercises/new')}
        />
      </View>

      <View style={{ gap: theme.spacing.sm }}>
        <Text variant="overline" color="secondary">
          Recent workouts
        </Text>

        {isLoading ? null : past.length === 0 ? (
          <EmptyState
            title="Nothing recorded yet"
            description="Start a workout and add the exercises as you go. You can invent one on the spot if it is not in the list."
          />
        ) : (
          past.map((workout) => (
            <HistoryRow
              key={workout.id}
              name={workout.name}
              day={describeDay(asLocalDay(workout.local_date), today)}
              status={workout.status}
              durationSeconds={
                workout.completed_at !== null && workout.started_at !== null
                  ? Math.floor((workout.completed_at - workout.started_at) / 1000)
                  : null
              }
              onPress={() =>
                router.push({ pathname: '/workout/[id]', params: { id: workout.id } })
              }
            />
          ))
        )}
      </View>
    </Screen>
  );
}

function HistoryRow({
  name,
  day,
  status,
  durationSeconds,
  onPress,
}: {
  name: string;
  day: string;
  status: string;
  durationSeconds: number | null;
  onPress: () => void;
}) {
  const theme = useTheme();

  const detail = [
    day,
    durationSeconds !== null ? formatDuration(durationSeconds) : null,
    // Stated in words rather than only by styling: an abandoned session looks
    // like a completed one otherwise.
    status === 'abandoned' ? 'not finished' : null,
    status === 'planned' ? 'planned' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}. ${detail}.`}
      style={({ pressed }) => ({
        padding: theme.spacing.md,
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: pressed ? theme.colors.accentMuted : theme.colors.surface,
        gap: 2,
        minHeight: 64,
        justifyContent: 'center',
      })}
    >
      <Text variant="callout">{name}</Text>
      <Text variant="caption" color="muted">
        {detail}
      </Text>
    </Pressable>
  );
}
