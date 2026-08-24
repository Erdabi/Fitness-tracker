import { useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';

import { Button, Card, LoadingState, Screen, Text } from '@/components/ui';
import { useExercise } from '@/features/training/useTraining';
import { supportsOneRepMax } from '@/lib/training';
import { useTheme } from '@/theme';
import { label } from './index';

/**
 * One exercise.
 *
 * Exists mainly so a custom exercise has somewhere to be edited from, and so
 * `load_type` — the field with real consequences — is explained where a user
 * might wonder why one exercise offers an estimated 1RM and another does not.
 */
export default function ExerciseDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const router = useRouter();

  const { exercise, isLoading } = useExercise(id ?? null);

  if (isLoading) return <LoadingState label="Loading exercise" />;

  if (!exercise) {
    return (
      <Screen>
        <Text variant="headline">This exercise is no longer here.</Text>
        <Button label="Back" onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen scrollable>
      <View style={{ paddingTop: theme.spacing.lg, gap: theme.spacing.xs }}>
        <Text variant="displayMedium">{exercise.name}</Text>
        <Text variant="body" color="secondary">
          {label(exercise.primaryMuscle)} · {label(exercise.equipment)}
          {exercise.movementType ? ` · ${label(exercise.movementType)}` : ''}
        </Text>
        {exercise.isOwn ? (
          <Text variant="overline" color="accent">
            Your own exercise
          </Text>
        ) : null}
      </View>

      {exercise.description ? (
        <Text variant="body">{exercise.description}</Text>
      ) : null}

      {exercise.secondaryMuscles.length > 0 ? (
        <View style={{ gap: theme.spacing.xs }}>
          <Text variant="overline" color="secondary">
            Also works
          </Text>
          <Text variant="callout" color="secondary">
            {exercise.secondaryMuscles.map(label).join(', ')}
          </Text>
        </View>
      ) : null}

      <Card>
        <Text variant="overline" color="secondary">
          How a set is recorded
        </Text>
        <Text variant="body">{LOAD_DESCRIPTION[exercise.loadType]}</Text>
        <Text variant="caption" color="muted">
          {supportsOneRepMax(exercise.loadType)
            ? 'An estimated one-rep max is shown for this exercise. It is an estimate from the Epley formula, not a measured maximum.'
            : 'No one-rep max is shown: the figure would not mean anything for this kind of exercise.'}
        </Text>
      </Card>

      {exercise.instructions ? (
        <View style={{ gap: theme.spacing.xs }}>
          <Text variant="overline" color="secondary">
            Instructions
          </Text>
          <Text variant="body">{exercise.instructions}</Text>
        </View>
      ) : null}

      {exercise.isOwn ? (
        <Button
          label="Edit this exercise"
          variant="secondary"
          onPress={() =>
            router.push({ pathname: '/exercises/new', params: { id: exercise.id } })
          }
        />
      ) : (
        <Text variant="caption" color="muted">
          Built-in exercises cannot be edited. Create your own version if you need
          it to work differently.
        </Text>
      )}
    </Screen>
  );
}

const LOAD_DESCRIPTION = {
  weighted: 'A weight and a number of reps, like 70 kg × 8.',
  bodyweight:
    'A number of reps. Add a weight if you use a belt or a vest; leave it at zero if not.',
  duration: 'How long it was held, in seconds.',
  distance: 'How far, in metres. Add a time if you want one.',
} as const;
