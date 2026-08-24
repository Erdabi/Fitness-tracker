import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { getDatabase } from '@/db/client';
import {
  browseExercises,
  createCustomExercise,
  deleteCustomExercise,
  editCustomExercise,
  getExercise,
  type BrowseOptions,
  type CustomExerciseInput,
  type EditExerciseInput,
} from '@/db/repositories/exercises';
import {
  abandonWorkout,
  activeWorkout,
  addWorkoutExercise,
  deleteSet,
  deleteWorkout,
  duplicateWorkoutExercise,
  editSet,
  editWorkout,
  finishWorkout,
  getWorkoutDetail,
  listWorkouts,
  previousPerformance,
  recordSet,
  removeWorkoutExercise,
  repeatWorkout,
  reorderWorkoutExercises,
  startWorkout,
  toggleSetCompleted,
  type AddExerciseInput,
  type EditSetInput,
  type RecordSetInput,
} from '@/db/repositories/workouts';
import { useAuth } from '@/features/auth/AuthProvider';
import { useDiaryTimeZone } from '@/features/diary/useDiary';
import { sync } from '@/sync/engine';
import { createSupabaseRemote } from '@/sync/remote';

/**
 * Training, read from SQLite.
 *
 * Every read here is a local query and every write lands locally first, so the
 * whole feature works in a gym basement. The push is fire-and-forget behind
 * the cache invalidation — a tapped set appears immediately whether or not
 * there is signal.
 *
 * `pushInBackground` is deliberately not awaited anywhere. Section F is
 * explicit that set entry must never wait for the network, and awaiting a sync
 * inside a mutation is exactly how that happens by accident.
 */

const remote = createSupabaseRemote();

const trainingKey = (userId: string) => ['training', userId] as const;

function usePush() {
  const { userId } = useAuth();

  return useCallback(() => {
    if (!userId) return;
    void sync({ db: getDatabase(), userId, remote });
  }, [userId]);
}

/* ------------------------------------------------------------- catalogue */

export function useExercises(options: BrowseOptions = {}) {
  const { userId } = useAuth();

  const query = useQuery({
    queryKey: [
      ...trainingKey(userId ?? 'anonymous'),
      'exercises',
      options.query ?? '',
      options.muscle ?? '',
      options.equipment ?? '',
      options.ownOnly ?? false,
    ],
    enabled: userId !== null,
    queryFn: () => (userId ? browseExercises(userId, options, getDatabase()) : []),
  });

  return { exercises: query.data ?? [], isLoading: query.isLoading };
}

export function useExercise(id: string | null) {
  const query = useQuery({
    queryKey: ['training-exercise', id ?? 'none'],
    enabled: id !== null,
    queryFn: () => (id ? getExercise(id, getDatabase()) : null),
  });

  return { exercise: query.data ?? null, isLoading: query.isLoading };
}

export function useExerciseMutations() {
  const { userId } = useAuth();
  const queryClient = useQueryClient();
  const push = usePush();

  const refresh = useCallback(() => {
    if (!userId) return;
    void queryClient.invalidateQueries({ queryKey: trainingKey(userId) });
    void queryClient.invalidateQueries({ queryKey: ['training-exercise'] });
  }, [queryClient, userId]);

  return {
    create: useCallback(
      (input: Omit<CustomExerciseInput, 'userId'>) => {
        if (!userId) return null;
        const row = createCustomExercise({ ...input, userId }, getDatabase());
        refresh();
        push();
        return row;
      },
      [userId, refresh, push],
    ),

    edit: useCallback(
      (id: string, patch: EditExerciseInput) => {
        const row = editCustomExercise(id, patch, getDatabase());
        refresh();
        push();
        return row;
      },
      [refresh, push],
    ),

    remove: useCallback(
      (id: string) => {
        deleteCustomExercise(id, getDatabase());
        refresh();
        push();
      },
      [refresh, push],
    ),
  };
}

/* -------------------------------------------------------------- workouts */

export function useActiveWorkout() {
  const { userId } = useAuth();

  const query = useQuery({
    queryKey: [...trainingKey(userId ?? 'anonymous'), 'active'],
    enabled: userId !== null,
    queryFn: () => (userId ? activeWorkout(userId, getDatabase()) : null),
  });

  return { workout: query.data ?? null, isLoading: query.isLoading };
}

export function useWorkoutHistory(limit = 30) {
  const { userId } = useAuth();

  const query = useQuery({
    queryKey: [...trainingKey(userId ?? 'anonymous'), 'history', limit],
    enabled: userId !== null,
    queryFn: () => (userId ? listWorkouts(userId, limit, getDatabase()) : []),
  });

  return { workouts: query.data ?? [], isLoading: query.isLoading };
}

export function useWorkoutDetail(workoutId: string | null) {
  const query = useQuery({
    queryKey: ['training-workout', workoutId ?? 'none'],
    enabled: workoutId !== null,
    queryFn: () => (workoutId ? getWorkoutDetail(workoutId, getDatabase()) : null),
  });

  return { detail: query.data ?? null, isLoading: query.isLoading };
}

/**
 * What the user did last time.
 *
 * A local query, answered from rows the device already holds. It is a `useQuery`
 * only so it participates in the same cache invalidation as everything else;
 * there is no request behind it and nothing to wait for.
 */
export function usePreviousPerformance(
  exerciseId: string | null,
  excludeWorkoutId: string | null,
) {
  const { userId } = useAuth();

  const query = useQuery({
    queryKey: [
      'training-previous',
      userId ?? 'anonymous',
      exerciseId ?? 'none',
      excludeWorkoutId ?? 'none',
    ],
    enabled: userId !== null && exerciseId !== null,
    queryFn: () =>
      userId ? previousPerformance(userId, exerciseId, excludeWorkoutId, getDatabase()) : null,
  });

  return { previous: query.data ?? null };
}

export function useWorkoutMutations() {
  const { userId } = useAuth();
  const timeZone = useDiaryTimeZone();
  const queryClient = useQueryClient();
  const push = usePush();

  const refresh = useCallback(() => {
    if (!userId) return;
    void queryClient.invalidateQueries({ queryKey: trainingKey(userId) });
    void queryClient.invalidateQueries({ queryKey: ['training-workout'] });
    void queryClient.invalidateQueries({ queryKey: ['training-previous'] });
  }, [queryClient, userId]);

  const start = useCallback(
    (name: string) => {
      if (!userId) return null;
      const row = startWorkout({ userId, name, timeZone }, getDatabase());
      refresh();
      push();
      return row;
    },
    [userId, timeZone, refresh, push],
  );

  const repeat = useCallback(
    (sourceWorkoutId: string) => {
      if (!userId) return null;
      const row = repeatWorkout(sourceWorkoutId, { userId, timeZone }, getDatabase());
      refresh();
      push();
      return row;
    },
    [userId, timeZone, refresh, push],
  );

  const addExercise = useCallback(
    (input: Omit<AddExerciseInput, 'userId'>) => {
      if (!userId) return null;
      const row = addWorkoutExercise({ ...input, userId }, getDatabase());
      refresh();
      push();
      return row;
    },
    [userId, refresh, push],
  );

  const addSet = useCallback(
    (input: Omit<RecordSetInput, 'userId'>) => {
      if (!userId) return null;
      const row = recordSet({ ...input, userId }, getDatabase());
      refresh();
      push();
      return row;
    },
    [userId, refresh, push],
  );

  /**
   * Runs a mutation, refreshes what it touched, and pushes behind it.
   *
   * One callback rather than one per action: a hook cannot be created inside a
   * helper, and every mutation here needs exactly the same three steps. The
   * push is not awaited — set entry must never wait on the network.
   */
  const run = useCallback(
    <T,>(action: () => T): T => {
      const result = action();
      refresh();
      push();
      return result;
    },
    [refresh, push],
  );

  return {
    start,
    repeat,
    addExercise,
    addSet,

    rename: (id: string, name: string) =>
      run(() => editWorkout(id, { name }, getDatabase())),

    setNotes: (id: string, notes: string | null) =>
      run(() => editWorkout(id, { notes }, getDatabase())),

    finish: (id: string) => run(() => finishWorkout(id, getDatabase())),
    abandon: (id: string) => run(() => abandonWorkout(id, getDatabase())),
    remove: (id: string) => run(() => deleteWorkout(id, getDatabase())),

    reorderExercises: (workoutId: string, orderedIds: readonly string[]) =>
      run(() => reorderWorkoutExercises(workoutId, orderedIds, getDatabase())),
    removeExercise: (id: string) => run(() => removeWorkoutExercise(id, getDatabase())),
    duplicateExercise: (id: string) =>
      run(() => duplicateWorkoutExercise(id, getDatabase())),

    editSet: (id: string, patch: EditSetInput) =>
      run(() => editSet(id, patch, getDatabase())),
    toggleSet: (id: string) => run(() => toggleSetCompleted(id, getDatabase())),
    removeSet: (id: string) => run(() => deleteSet(id, getDatabase())),
  };
}
