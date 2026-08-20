import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { getDatabase } from '@/db/client';
import {
  currentGoal,
  deleteGoalPeriod,
  editGoalPeriod,
  goalForDate,
  isBelowFloor,
  listGoalPeriods,
  openGoalPeriod,
  type GoalBasis,
  type GoalTargets,
} from '@/db/repositories/goals';
import { latestWeight, recordWeight, weightHistory } from '@/db/repositories/weight';
import type { NutritionGoalRow } from '@/db/schema';
import { useAuth } from '@/features/auth/AuthProvider';
import { useProfile } from '@/features/profile/useProfile';
import { todayIn, type LocalDay } from '@/lib/date';
import {
  ageOn,
  calculateTargets,
  type ActivityLevel,
  type BiologicalSex,
  type BodyMetrics,
  type CalculatedTargets,
  type GoalDirection,
} from '@/lib/energy';
import { sync } from '@/sync/engine';
import { createSupabaseRemote } from '@/sync/remote';

/**
 * Goals, read from SQLite.
 *
 * Everything here resolves without a network request, so the calculator works
 * on a plane and the diary can always say what the target was. Sync reconciles
 * in the background; nothing waits on it.
 */

const remote = createSupabaseRemote();

const goalKey = (userId: string) => ['goals', userId] as const;

/** The goal in force on a specific diary date. Never today's, for a past day. */
export function useGoalForDate(day: LocalDay) {
  const { userId } = useAuth();

  const query = useQuery({
    queryKey: [...goalKey(userId ?? 'anonymous'), 'on', day],
    enabled: userId !== null,
    queryFn: () => (userId ? (goalForDate(userId, day, getDatabase()) ?? null) : null),
  });

  return { goal: query.data ?? null, isLoading: query.isLoading };
}

export function useCurrentGoal() {
  const { profile } = useProfile();
  const { userId } = useAuth();
  const today = todayIn(profile?.time_zone ?? 'UTC');

  const query = useQuery({
    queryKey: [...goalKey(userId ?? 'anonymous'), 'current', today],
    enabled: userId !== null,
    queryFn: () => (userId ? (currentGoal(userId, today, getDatabase()) ?? null) : null),
  });

  return { goal: query.data ?? null, isLoading: query.isLoading, today };
}

export function useGoalHistory() {
  const { userId } = useAuth();

  const query = useQuery({
    queryKey: [...goalKey(userId ?? 'anonymous'), 'history'],
    enabled: userId !== null,
    queryFn: () => (userId ? listGoalPeriods(userId, getDatabase()) : []),
  });

  return { periods: query.data ?? [], isLoading: query.isLoading };
}

/**
 * What the calculator starts from.
 *
 * Prefilled from the profile and the most recent weigh-in. `sex` is carried
 * through as `unspecified` rather than defaulted, so the calculator asks
 * instead of the equation guessing.
 */
export interface CalculatorSeed {
  readonly sex: BiologicalSex;
  readonly ageYears: number | null;
  readonly heightCm: number | null;
  readonly weightKg: number | null;
  readonly activity: ActivityLevel | null;
  readonly unitSystem: 'metric' | 'imperial';
}

export function useCalculatorSeed(): CalculatorSeed {
  const { userId } = useAuth();
  const { profile } = useProfile();

  const weight = useQuery({
    queryKey: ['weight', userId ?? 'anonymous', 'latest'],
    enabled: userId !== null,
    queryFn: () => (userId ? (latestWeight(userId, getDatabase()) ?? null) : null),
  });

  return {
    sex:
      profile?.sex === 'male' || profile?.sex === 'female' ? profile.sex : 'unspecified',
    ageYears: profile?.birth_date ? ageOn(profile.birth_date) : null,
    heightCm: profile?.height_cm ?? null,
    weightKg: weight.data?.weight_kg ?? null,
    activity: (profile?.activity_level as ActivityLevel | null) ?? null,
    unitSystem: profile?.unit_system ?? 'metric',
  };
}

export interface RecalculationInput {
  readonly metrics: BodyMetrics;
  readonly activity: ActivityLevel;
  readonly direction: GoalDirection;
}

/**
 * Runs the calculation without storing anything.
 *
 * The results screen shows what this returns; nothing is written until the
 * user confirms. Keeping the two apart is what makes "have a look at what a
 * different activity level would give" free of consequences.
 */
export function calculateRecommendation(
  input: RecalculationInput,
): CalculatedTargets | null {
  return calculateTargets(input.metrics, input.activity, input.direction);
}

export function useGoalMutations() {
  const { userId } = useAuth();
  const { profile, saveProfile } = useProfile();
  const queryClient = useQueryClient();

  const refresh = useCallback(() => {
    if (!userId) return;
    void queryClient.invalidateQueries({ queryKey: goalKey(userId) });
    void queryClient.invalidateQueries({ queryKey: ['weight', userId] });
    // A changed goal changes what every diary day renders against it.
    void queryClient.invalidateQueries({ queryKey: ['diary', userId] });
  }, [queryClient, userId]);

  const pushInBackground = useCallback(() => {
    if (!userId) return;
    void sync({ db: getDatabase(), userId, remote });
  }, [userId]);

  /**
   * Opens a new goal period from a calculation.
   *
   * Deliberately not an update. A recalculation after gaining or losing weight
   * is a new period starting today; every day before it keeps the target it
   * had, because those days already happened.
   *
   * The profile is updated alongside — height, activity, sex — since those are
   * facts about the person rather than about this period. The period keeps its
   * own snapshot regardless, so a later profile change cannot reach back.
   */
  const applyCalculation = useCallback(
    (params: {
      effectiveFrom: LocalDay;
      calculated: CalculatedTargets;
      chosen?: GoalTargets;
      input: RecalculationInput;
      acknowledgedBelowFloor?: boolean;
    }): NutritionGoalRow | null => {
      if (!userId) return null;

      const recommendation: GoalTargets = {
        calorieTarget: params.calculated.calorieTarget,
        macros: params.calculated.macros,
      };

      const basis: GoalBasis = {
        bmr: params.calculated.bmr,
        tdee: params.calculated.tdee,
        activity: params.input.activity,
        direction: params.input.direction,
        weightKg: params.input.metrics.weightKg,
        heightCm: params.input.metrics.heightCm,
        ageYears: params.input.metrics.ageYears,
        sex: params.input.metrics.sex === 'unspecified' ? 'other' : params.input.metrics.sex,
      };

      const row = openGoalPeriod(
        {
          userId,
          effectiveFrom: params.effectiveFrom,
          targets: params.chosen ?? recommendation,
          recommendation,
          basis,
          acknowledgedBelowFloor: params.acknowledgedBelowFloor,
        },
        getDatabase(),
      );

      // Keep the profile in step with what the user just told us.
      saveProfile({
        height_cm: params.input.metrics.heightCm,
        activity_level: params.input.activity,
        ...(params.input.metrics.sex === 'unspecified'
          ? {}
          : { sex: params.input.metrics.sex }),
      });

      refresh();
      pushInBackground();
      return row;
    },
    [userId, saveProfile, refresh, pushInBackground],
  );

  /**
   * Sets a target by hand, with no calculation behind it.
   *
   * Used from the goal screen, so changing a number does not require walking
   * back through the whole calculator.
   */
  const setManualGoal = useCallback(
    (params: {
      effectiveFrom: LocalDay;
      targets: GoalTargets;
      recommendation?: GoalTargets | null;
      basis?: GoalBasis | null;
      acknowledgedBelowFloor?: boolean;
    }): NutritionGoalRow | null => {
      if (!userId) return null;

      const row = openGoalPeriod(
        {
          userId,
          effectiveFrom: params.effectiveFrom,
          targets: params.targets,
          recommendation: params.recommendation ?? null,
          basis: params.basis ?? null,
          acknowledgedBelowFloor: params.acknowledgedBelowFloor,
        },
        getDatabase(),
      );

      refresh();
      pushInBackground();
      return row;
    },
    [userId, refresh, pushInBackground],
  );

  /** Corrects a period already in force, rather than starting a new one. */
  const correctPeriod = useCallback(
    (id: string, targets: GoalTargets, acknowledgedBelowFloor?: boolean) => {
      editGoalPeriod(id, { targets, acknowledgedBelowFloor }, getDatabase());
      refresh();
      pushInBackground();
    },
    [refresh, pushInBackground],
  );

  const removePeriod = useCallback(
    (id: string) => {
      deleteGoalPeriod(id, getDatabase());
      refresh();
      pushInBackground();
    },
    [refresh, pushInBackground],
  );

  const saveWeight = useCallback(
    (params: { measuredOn: LocalDay; weightKg: number }) => {
      if (!userId) return;
      recordWeight({ userId, ...params }, getDatabase());
      refresh();
      pushInBackground();
    },
    [userId, refresh, pushInBackground],
  );

  return {
    applyCalculation,
    setManualGoal,
    correctPeriod,
    removePeriod,
    saveWeight,
    /** The zone every diary day is measured in. */
    timeZone: profile?.time_zone ?? 'UTC',
  };
}

export function useWeightHistory(days = 90) {
  const { userId } = useAuth();
  const { profile } = useProfile();
  const to = todayIn(profile?.time_zone ?? 'UTC');

  const query = useQuery({
    queryKey: ['weight', userId ?? 'anonymous', 'history', days, to],
    enabled: userId !== null,
    queryFn: () => (userId ? weightHistory(userId, { to, days }, getDatabase()) : []),
  });

  return { entries: query.data ?? [], isLoading: query.isLoading };
}

export { isBelowFloor };
