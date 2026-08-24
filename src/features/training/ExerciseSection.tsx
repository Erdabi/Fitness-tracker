import { Pressable, View } from 'react-native';

import { Button, Card, Text } from '@/components/ui';
import type { WorkoutExerciseDetail, WorkoutSet } from '@/db/repositories/workouts';
import { describeSet, reorder, type WeightUnit } from '@/lib/training';
import { MIN_TOUCH_TARGET, useTheme } from '@/theme';
import { SetRow } from './SetRow';

/**
 * The subset of the training mutations this section needs.
 *
 * Declared structurally rather than imported from the hook, so the component
 * can be rendered in a test with four jest functions instead of a database, a
 * query client and an auth provider.
 */
export interface ExerciseSectionActions {
  reorderExercises: (workoutId: string, orderedIds: readonly string[]) => void;
  removeExercise: (id: string) => void;
  addSet: (input: {
    workoutExerciseId: string;
    weightKg?: number | null;
    weightUnit?: WeightUnit;
    reps?: number | null;
    durationSeconds?: number | null;
    distanceM?: number | null;
    isCompleted?: boolean;
  }) => unknown;
  editSet: (
    id: string,
    patch: {
      weightKg?: number | null;
      reps?: number | null;
      durationSeconds?: number | null;
      distanceM?: number | null;
    },
  ) => void;
  toggleSet: (id: string) => void;
  removeSet: (id: string) => void;
}

/**
 * One exercise and its sets.
 *
 * Reordering is offered as **buttons, not a drag**. A drag needs a sustained
 * press and a steady hand, both of which are in short supply between sets, and
 * it is unusable with a screen reader or a switch control. Two arrows do the
 * same job for everyone.
 */
export function ExerciseSection({
  exercise,
  index,
  total,
  workoutId,
  unit,
  mutations,
  allIds,
  previous,
}: {
  exercise: WorkoutExerciseDetail;
  index: number;
  total: number;
  workoutId: string;
  unit: WeightUnit;
  mutations: ExerciseSectionActions;
  allIds: readonly string[];
  /**
   * What was done last time. Passed in rather than fetched here so the
   * component stays renderable without a database — the screen reads it from
   * SQLite, which is instant and never touches the network.
   */
  previous: { sets: readonly WorkoutSet[] } | null;
}) {
  const theme = useTheme();

  const move = (to: number) => {
    mutations.reorderExercises(workoutId, reorder(allIds, index, to));
  };

  /** Copies the last set's numbers: the second set is usually the first again. */
  const addSet = () => {
    const last = exercise.sets[exercise.sets.length - 1];
    const template = last ?? previous?.sets[previous.sets.length - 1] ?? null;

    mutations.addSet({
      workoutExerciseId: exercise.id,
      weightKg: template?.weightKg ?? (exercise.loadType === 'bodyweight' ? 0 : null),
      weightUnit: unit,
      reps: template?.reps ?? null,
      durationSeconds: template?.durationSeconds ?? null,
      distanceM: template?.distanceM ?? null,
      // Offered, not claimed. The user ticks it when they have done it.
      isCompleted: false,
    });
  };

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <Text variant="headline" style={{ flex: 1 }}>
          {exercise.name}
        </Text>

        <MoveButton
          label={`Move ${exercise.name} up`}
          glyph="↑"
          disabled={index === 0}
          onPress={() => move(index - 1)}
        />
        <MoveButton
          label={`Move ${exercise.name} down`}
          glyph="↓"
          disabled={index === total - 1}
          onPress={() => move(index + 1)}
        />
      </View>

      {previous && previous.sets.length > 0 ? (
        <Text
          variant="caption"
          color="secondary"
          accessibilityLabel={`Previous ${exercise.name}: ${previous.sets
            .map((set) => describeSet(set, exercise.loadType, unit))
            .join('; ')}`}
        >
          Previous:{' '}
          {previous.sets
            .map((set) =>
              set.weightKg !== null && set.reps !== null
                ? `${set.weightKg} × ${set.reps}`
                : describeSet(set, exercise.loadType, unit),
            )
            .join(', ')}
        </Text>
      ) : null}

      <View style={{ gap: theme.spacing.sm, marginTop: theme.spacing.xs }}>
        {exercise.sets.map((set, setIndex) => (
          <SetRow
            key={set.id}
            set={set}
            loadType={exercise.loadType}
            unit={unit}
            previousLabel={
              previous?.sets[setIndex]
                ? describeSet(previous.sets[setIndex]!, exercise.loadType, unit)
                : null
            }
            onChange={(patch) => mutations.editSet(set.id, patch)}
            onToggle={() => mutations.toggleSet(set.id)}
            onDelete={() => mutations.removeSet(set.id)}
          />
        ))}
      </View>

      <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
        <Button
          label="Add set"
          variant="secondary"
          size="medium"
          fullWidth={false}
          style={{ flex: 1 }}
          onPress={addSet}
        />
        <Button
          label="Remove"
          variant="ghost"
          size="medium"
          fullWidth={false}
          style={{ flex: 1 }}
          onPress={() => mutations.removeExercise(exercise.id)}
        />
      </View>

      {exercise.summary.estimatedOneRepMaxKg !== null ? (
        <Text variant="caption" color="muted">
          Estimated 1RM {exercise.summary.estimatedOneRepMaxKg} kg — an estimate from
          today&apos;s sets, not a measured maximum.
        </Text>
      ) : null}
    </Card>
  );
}

function MoveButton({
  label,
  glyph,
  disabled,
  onPress,
}: {
  label: string;
  glyph: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={{
        minWidth: MIN_TOUCH_TARGET,
        minHeight: MIN_TOUCH_TARGET,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.3 : 1,
      }}
    >
      <Text variant="callout" color="secondary">
        {glyph}
      </Text>
    </Pressable>
  );
}
