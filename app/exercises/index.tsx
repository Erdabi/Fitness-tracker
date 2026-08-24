import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Button, EmptyState, Screen, Text, TextField } from '@/components/ui';
import { MUSCLE_GROUPS, type Exercise } from '@/db/repositories/exercises';
import { useExercises, useWorkoutMutations } from '@/features/training/useTraining';
import { useTheme } from '@/theme';

/**
 * Browsing and searching the catalogue.
 *
 * Doubles as the exercise picker: arriving with a `workoutId` turns every row
 * into "add this to the session". One screen rather than two, because they are
 * the same list with the same filters and a different tap handler — and a
 * separate picker would drift out of step with the browser the first time
 * either changed.
 */
export default function ExercisesScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { workoutId } = useLocalSearchParams<{ workoutId?: string }>();

  const [query, setQuery] = useState('');
  const [muscle, setMuscle] = useState<string | null>(null);

  const { exercises, isLoading } = useExercises({ query, muscle });
  const { addExercise } = useWorkoutMutations();

  const isPicking = Boolean(workoutId);

  const choose = (exercise: Exercise) => {
    if (!workoutId) {
      router.push({ pathname: '/exercises/[id]', params: { id: exercise.id } });
      return;
    }

    addExercise({
      workoutId,
      exerciseId: exercise.id,
      name: exercise.name,
      loadType: exercise.loadType,
    });

    router.back();
  };

  return (
    <Screen scrollable keyboardAvoiding>
      <View style={{ paddingTop: theme.spacing.lg, gap: theme.spacing.xs }}>
        <Text variant="displayMedium">{isPicking ? 'Add an exercise' : 'Exercises'}</Text>
        <Text variant="body" color="secondary">
          {isPicking
            ? 'Pick one, or make your own if it is not here.'
            : 'The built-in list plus anything you have added. Works offline.'}
        </Text>
      </View>

      <TextField
        label="Search"
        value={query}
        onChangeText={setQuery}
        placeholder="Bench, squat, plank…"
        autoCapitalize="none"
        autoCorrect={false}
      />

      {/* Horizontal filters, each a real button rather than a chip that only
          looks tappable. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: theme.spacing.sm, paddingVertical: 2 }}
      >
        <Filter label="All" selected={muscle === null} onPress={() => setMuscle(null)} />
        {MUSCLE_GROUPS.map((group) => (
          <Filter
            key={group}
            label={label(group)}
            selected={muscle === group}
            onPress={() => setMuscle(muscle === group ? null : group)}
          />
        ))}
      </ScrollView>

      <Button
        label="Create a new exercise"
        variant="secondary"
        onPress={() =>
          router.push({
            pathname: '/exercises/new',
            params: workoutId ? { workoutId } : {},
          })
        }
      />

      {isLoading ? null : exercises.length === 0 ? (
        <EmptyState
          title="Nothing matches"
          description="Try a shorter search, or create the exercise yourself."
        />
      ) : (
        <View style={{ gap: theme.spacing.sm }}>
          {exercises.map((exercise) => (
            <ExerciseRow
              key={exercise.id}
              exercise={exercise}
              actionLabel={isPicking ? 'Add to workout' : 'View details'}
              onPress={() => choose(exercise)}
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

function ExerciseRow({
  exercise,
  actionLabel,
  onPress,
}: {
  exercise: Exercise;
  actionLabel: string;
  onPress: () => void;
}) {
  const theme = useTheme();

  const detail = [label(exercise.primaryMuscle), label(exercise.equipment)].join(' · ');

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${exercise.name}. ${detail}.${exercise.isOwn ? ' Your own exercise.' : ''}`}
      accessibilityHint={actionLabel}
      style={({ pressed }) => ({
        padding: theme.spacing.md,
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: pressed ? theme.colors.accent : theme.colors.border,
        backgroundColor: pressed ? theme.colors.accentMuted : theme.colors.surface,
        gap: 2,
        minHeight: 64,
        justifyContent: 'center',
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <Text variant="callout" style={{ flex: 1 }}>
          {exercise.name}
        </Text>
        {exercise.isOwn ? (
          <Text variant="overline" color="accent">
            Yours
          </Text>
        ) : null}
      </View>
      <Text variant="caption" color="muted">
        {detail}
      </Text>
    </Pressable>
  );
}

function Filter({
  label: text,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={text}
      style={{
        paddingHorizontal: theme.spacing.md,
        paddingVertical: theme.spacing.sm,
        minHeight: 44,
        justifyContent: 'center',
        borderRadius: theme.radius.md,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected ? theme.colors.accentMuted : 'transparent',
      }}
    >
      <Text variant="caption" color={selected ? 'accent' : 'secondary'}>
        {text}
      </Text>
    </Pressable>
  );
}

/** `full_body` reads badly; the underscore is a database concern. */
export function label(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
