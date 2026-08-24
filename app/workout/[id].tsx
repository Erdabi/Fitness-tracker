import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';

import { Button, LoadingState, Screen, Text, TextField } from '@/components/ui';
import { useProfile } from '@/features/profile/useProfile';
import { ExerciseSection } from '@/features/training/ExerciseSection';
import {
  usePreviousPerformance,
  useWorkoutDetail,
  useWorkoutMutations,
} from '@/features/training/useTraining';
import { describeDuration, elapsedSeconds, formatDuration, type WeightUnit } from '@/lib/training';
import { useTheme } from '@/theme';

/**
 * The active session.
 *
 * Optimised for the twenty seconds between sets: the elapsed timer at the top,
 * the exercise list below it, and one large tick per set. Adding a set copies
 * the previous one's numbers, because the second set of an exercise is usually
 * the same as the first and typing it again is the single most common wasted
 * interaction in a gym app.
 */
export default function WorkoutScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const router = useRouter();

  const { detail, isLoading } = useWorkoutDetail(id ?? null);
  const mutations = useWorkoutMutations();
  const { profile } = useProfile();

  const unit: WeightUnit = profile?.unit_system === 'imperial' ? 'lb' : 'kg';

  const [now, setNow] = useState(() => Date.now());
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  const isRunning = detail?.workout.status === 'in_progress';

  /*
   * A one-second tick, only while the session is running. A finished session
   * has a fixed duration, and leaving the interval alive would re-render the
   * whole screen every second for a number that never changes.
   */
  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isRunning]);

  if (isLoading) return <LoadingState label="Loading workout" />;

  if (!detail) {
    return (
      <Screen>
        <Text variant="headline">This workout is no longer here.</Text>
        <Button label="Back to Train" onPress={() => router.replace('/(tabs)/train')} />
      </Screen>
    );
  }

  const { workout, exercises } = detail;

  const seconds =
    workout.started_at === null
      ? 0
      : detail.durationSeconds ?? elapsedSeconds(workout.started_at, now);

  return (
    <Screen scrollable keyboardAvoiding>
      <View style={{ paddingTop: theme.spacing.lg, gap: theme.spacing.xs }}>
        {editingName ? (
          <TextField
            label="Workout name"
            value={nameDraft}
            autoFocus
            onChangeText={setNameDraft}
            onBlur={() => {
              if (nameDraft.trim()) mutations.rename(workout.id, nameDraft);
              setEditingName(false);
            }}
          />
        ) : (
          <Pressable
            onPress={() => {
              setNameDraft(workout.name);
              setEditingName(true);
            }}
            accessibilityRole="button"
            accessibilityLabel={`${workout.name}. Rename this workout.`}
          >
            <Text variant="displayMedium">{workout.name}</Text>
          </Pressable>
        )}

        {/*
          The timer reads as digits but announces as words: "4:09" is read
          "four hundred nine" by some screen readers, which is not a duration.
        */}
        <Text
          variant="headline"
          color={isRunning ? 'accent' : 'secondary'}
          accessibilityLabel={`${isRunning ? 'Elapsed' : 'Took'} ${describeDuration(seconds)}`}
          accessibilityLiveRegion="none"
        >
          {formatDuration(seconds)}
        </Text>

        <Text variant="caption" color="muted">
          {detail.totalSets} set{detail.totalSets === 1 ? '' : 's'}
          {detail.totalVolumeKg !== null
            ? ` · ${Math.round(detail.totalVolumeKg)} kg total volume`
            : ''}
        </Text>
      </View>

      {exercises.map((exercise, index) => (
        <ExerciseSectionWithHistory
          key={exercise.id}
          exercise={exercise}
          index={index}
          total={exercises.length}
          workoutId={workout.id}
          unit={unit}
          mutations={mutations}
          allIds={exercises.map((entry) => entry.id)}
        />
      ))}

      <Button
        label="Add an exercise"
        variant="secondary"
        onPress={() =>
          router.push({ pathname: '/exercises', params: { workoutId: workout.id } })
        }
      />

      <TextField
        label="Notes"
        value={workout.notes ?? ''}
        placeholder="How it went, what to change next time…"
        multiline
        onChangeText={(value) => mutations.setNotes(workout.id, value || null)}
      />

      {isRunning ? (
        <>
          <Button
            label="Finish workout"
            onPress={() => {
              mutations.finish(workout.id);
              router.replace('/(tabs)/train');
            }}
          />
          <Button
            label="Abandon"
            variant="ghost"
            onPress={() => {
              mutations.abandon(workout.id);
              router.replace('/(tabs)/train');
            }}
          />
        </>
      ) : (
        <Button
          label="Repeat this workout"
          onPress={() => {
            const repeated = mutations.repeat(workout.id);
            if (repeated) {
              router.replace({ pathname: '/workout/[id]', params: { id: repeated.id } });
            }
          }}
        />
      )}
    </Screen>
  );
}

/**
 * `ExerciseSection` with its previous performance looked up.
 *
 * The lookup lives here rather than inside the section so the section itself
 * needs no database, no query client and no auth provider to render — which is
 * what makes its accessibility behaviour testable. The query is local and
 * instant; nothing here waits on a network.
 */
function ExerciseSectionWithHistory(
  props: Omit<React.ComponentProps<typeof ExerciseSection>, 'previous'>,
) {
  const { previous } = usePreviousPerformance(props.exercise.exerciseId, props.workoutId);
  return <ExerciseSection {...props} previous={previous} />;
}
