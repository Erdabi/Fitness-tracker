import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Button, Screen, Text, TextField } from '@/components/ui';
import { EQUIPMENT, MUSCLE_GROUPS } from '@/db/repositories/exercises';
import type { LoadTypeValue } from '@/db/schema';
import {
  useExercise,
  useExerciseMutations,
  useWorkoutMutations,
} from '@/features/training/useTraining';
import { useTheme } from '@/theme';
import { label } from './index';

/**
 * Creating or editing an exercise the user owns.
 *
 * One screen for both: arriving with an `id` loads it and saves in place. The
 * fields are identical, and two copies would drift the first time either
 * changed.
 *
 * `loadType` is the only field with real consequences, so it is explained
 * rather than merely listed — it decides what the set editor asks for and
 * whether an estimated 1RM is offered at all.
 */
export default function ExerciseFormScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { id, workoutId } = useLocalSearchParams<{ id?: string; workoutId?: string }>();

  const { exercise: existing } = useExercise(id ?? null);
  const { create, edit, remove } = useExerciseMutations();
  const { addExercise } = useWorkoutMutations();

  const [name, setName] = useState(existing?.name ?? '');
  const [muscle, setMuscle] = useState<string>(existing?.primaryMuscle ?? 'chest');
  const [equipment, setEquipment] = useState<string>(existing?.equipment ?? 'barbell');
  const [loadType, setLoadType] = useState<LoadTypeValue>(existing?.loadType ?? 'weighted');
  const [instructions, setInstructions] = useState(existing?.instructions ?? '');
  const [error, setError] = useState<string | null>(null);

  const isEditing = Boolean(id && existing?.isOwn);

  const save = () => {
    if (!name.trim()) {
      setError('Give the exercise a name.');
      return;
    }
    setError(null);

    if (isEditing && id) {
      edit(id, {
        name,
        primaryMuscle: muscle,
        equipment,
        loadType,
        instructions: instructions.trim() || null,
      });
      router.back();
      return;
    }

    const created = create({
      name,
      primaryMuscle: muscle,
      equipment,
      loadType,
      instructions: instructions.trim() || null,
    });

    // Invented mid-session: add it to the workout that sent us here, so the
    // user does not have to find it again.
    if (created && workoutId) {
      addExercise({
        workoutId,
        exerciseId: created.id,
        name: created.name,
        loadType: created.load_type,
      });
      router.dismissTo({ pathname: '/workout/[id]', params: { id: workoutId } });
      return;
    }

    router.back();
  };

  return (
    <Screen scrollable keyboardAvoiding>
      <View style={{ paddingTop: theme.spacing.lg, gap: theme.spacing.xs }}>
        <Text variant="displayMedium">
          {isEditing ? 'Edit exercise' : 'New exercise'}
        </Text>
        <Text variant="body" color="secondary">
          {isEditing
            ? 'Changes apply from now on. Past workouts keep the name and type they were recorded with.'
            : 'Saved on this device straight away, and synced when there is a connection.'}
        </Text>
      </View>

      <TextField
        label="Name"
        value={name}
        onChangeText={setName}
        error={error ?? undefined}
        autoCapitalize="words"
        autoFocus={!isEditing}
      />

      <Choice
        title="How is it measured?"
        hint="This decides what a set asks for."
        options={LOAD_TYPE_OPTIONS}
        value={loadType}
        onChange={(next) => setLoadType(next as LoadTypeValue)}
      />

      <Picker
        title="Main muscle"
        options={MUSCLE_GROUPS.map((group) => ({ value: group, label: label(group) }))}
        value={muscle}
        onChange={setMuscle}
      />

      <Picker
        title="Equipment"
        options={EQUIPMENT.map((item) => ({ value: item, label: label(item) }))}
        value={equipment}
        onChange={setEquipment}
      />

      <TextField
        label="Instructions (optional)"
        value={instructions}
        onChangeText={setInstructions}
        placeholder="Setup, cues, anything you want to remember."
        multiline
      />

      <Button label={isEditing ? 'Save changes' : 'Create exercise'} onPress={save} />

      {isEditing && id ? (
        <>
          <Button
            label="Delete this exercise"
            variant="danger"
            onPress={() => {
              remove(id);
              router.back();
            }}
          />
          <Text variant="caption" color="muted" align="center">
            Deleting it removes it from the list. Workouts you have already done
            keep every set you recorded.
          </Text>
        </>
      ) : null}
    </Screen>
  );
}

const LOAD_TYPE_OPTIONS = [
  {
    value: 'weighted',
    label: 'Weight and reps',
    detail: 'Bench press, squat. Gets an estimated 1RM.',
  },
  {
    value: 'bodyweight',
    label: 'Reps, weight optional',
    detail: 'Push-ups, pull-ups. Add a belt weight if you use one.',
  },
  { value: 'duration', label: 'Time held', detail: 'Plank, dead hang.' },
  { value: 'distance', label: 'Distance', detail: 'Running, rowing.' },
] as const;

/** A radio group where each option needs a sentence of explanation. */
function Choice({
  title,
  hint,
  options,
  value,
  onChange,
}: {
  title: string;
  hint: string;
  options: readonly { value: string; label: string; detail: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="overline" color="secondary">
        {title}
      </Text>
      <Text variant="caption" color="muted">
        {hint}
      </Text>

      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={option.label}
            accessibilityHint={option.detail}
            style={{
              padding: theme.spacing.md,
              minHeight: 56,
              borderRadius: theme.radius.md,
              borderWidth: selected ? 2 : 1,
              borderColor: selected ? theme.colors.accent : theme.colors.border,
              backgroundColor: selected ? theme.colors.accentMuted : 'transparent',
              gap: 2,
            }}
          >
            <Text variant="callout" color={selected ? 'accent' : 'primary'}>
              {option.label}
            </Text>
            <Text variant="caption" color="muted">
              {option.detail}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A horizontal radio group for a long, self-explanatory list. */
function Picker({
  title,
  options,
  value,
  onChange,
}: {
  title: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="overline" color="secondary">
        {title}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: theme.spacing.sm, paddingVertical: 2 }}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              onPress={() => onChange(option.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={option.label}
              style={{
                paddingHorizontal: theme.spacing.md,
                minHeight: 44,
                justifyContent: 'center',
                borderRadius: theme.radius.md,
                borderWidth: selected ? 2 : 1,
                borderColor: selected ? theme.colors.accent : theme.colors.border,
                backgroundColor: selected ? theme.colors.accentMuted : 'transparent',
              }}
            >
              <Text variant="caption" color={selected ? 'accent' : 'secondary'}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
