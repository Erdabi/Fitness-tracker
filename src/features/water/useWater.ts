import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { getDatabase } from '@/db/client';
import {
  deleteWaterLog,
  editWaterLog,
  listWaterDay,
  logWater,
  openWaterGoal,
  suggestedTargetMl,
  summariseWater,
  waterDay,
  waterGoalForDate,
  waterHistory,
} from '@/db/repositories/water';
import { latestWeight } from '@/db/repositories/weight';
import { useAuth } from '@/features/auth/AuthProvider';
import { useDiaryTimeZone } from '@/features/diary/useDiary';
import { addDays, todayIn, type LocalDay } from '@/lib/date';
import { sync } from '@/sync/engine';
import { createSupabaseRemote } from '@/sync/remote';

/**
 * Water, read from SQLite.
 *
 * Every quick-add button, the custom amount and the goal screen go through
 * `logWater` and `openWaterGoal` — the buttons differ by the number they pass
 * and nothing else. Writes land locally first and the query cache is
 * invalidated immediately, so the dashboard updates on tap regardless of the
 * network; the push is fire-and-forget behind it.
 */

const remote = createSupabaseRemote();

const waterKey = (userId: string) => ['water', userId] as const;

export function useWaterDay(day: LocalDay) {
  const { userId } = useAuth();

  const query = useQuery({
    queryKey: [...waterKey(userId ?? 'anonymous'), 'day', day],
    enabled: userId !== null,
    queryFn: () => (userId ? waterDay(userId, day, getDatabase()) : null),
  });

  return {
    day: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}

export function useWaterEntries(day: LocalDay) {
  const { userId } = useAuth();

  const query = useQuery({
    queryKey: [...waterKey(userId ?? 'anonymous'), 'entries', day],
    enabled: userId !== null,
    queryFn: () => (userId ? listWaterDay(userId, day, getDatabase()) : []),
  });

  return { entries: query.data ?? [], isLoading: query.isLoading };
}

/** Daily totals over a window, each against its own day's goal. */
export function useWaterHistory(days = 7, to?: LocalDay) {
  const { userId } = useAuth();
  const timeZone = useDiaryTimeZone();
  const end = to ?? todayIn(timeZone);

  const query = useQuery({
    queryKey: [...waterKey(userId ?? 'anonymous'), 'history', days, end],
    enabled: userId !== null,
    queryFn: () =>
      userId
        ? waterHistory(userId, { from: addDays(end, -(days - 1)), to: end }, getDatabase())
        : [],
  });

  const history = query.data ?? [];

  return {
    days: history,
    summary: summariseWater(history),
    isLoading: query.isLoading,
    error: query.error,
  };
}

export function useWaterGoal(day: LocalDay) {
  const { userId } = useAuth();

  const query = useQuery({
    queryKey: [...waterKey(userId ?? 'anonymous'), 'goal', day],
    enabled: userId !== null,
    queryFn: () => (userId ? (waterGoalForDate(userId, day, getDatabase()) ?? null) : null),
  });

  return { goal: query.data ?? null, isLoading: query.isLoading };
}

/**
 * The target to suggest, from the user's most recent weight.
 *
 * A heuristic, stated as one wherever it is shown. See `ML_PER_KG_PER_DAY`.
 */
export function useSuggestedWaterTarget(): { targetMl: number; weightKg: number | null } {
  const { userId } = useAuth();

  const query = useQuery({
    queryKey: ['water-suggestion', userId ?? 'anonymous'],
    enabled: userId !== null,
    queryFn: () => (userId ? (latestWeight(userId, getDatabase())?.weight_kg ?? null) : null),
  });

  const weightKg = query.data ?? null;
  return { targetMl: suggestedTargetMl(weightKg), weightKg };
}

export function useWaterMutations() {
  const { userId } = useAuth();
  const timeZone = useDiaryTimeZone();
  const queryClient = useQueryClient();

  const refresh = useCallback(() => {
    if (!userId) return;
    void queryClient.invalidateQueries({ queryKey: waterKey(userId) });
    // The dashboard reads water through its own composed summary.
    void queryClient.invalidateQueries({ queryKey: ['dashboard', userId] });
  }, [queryClient, userId]);

  const pushInBackground = useCallback(() => {
    if (!userId) return;
    void sync({ db: getDatabase(), userId, remote });
  }, [userId]);

  /**
   * The one logging service.
   *
   * `+250 ml`, `+500 ml`, a custom amount and anything added later all arrive
   * here. There is no per-button path to get wrong.
   */
  const addWater = useCallback(
    (amountMl: number, options: { day?: LocalDay } = {}) => {
      if (!userId) return null;
      const row = logWater(
        { userId, amountMl, timeZone, localDate: options.day },
        getDatabase(),
      );
      refresh();
      pushInBackground();
      return row;
    },
    [userId, timeZone, refresh, pushInBackground],
  );

  const updateWater = useCallback(
    (id: string, amountMl: number) => {
      if (!userId) return null;
      const row = editWaterLog(id, { amountMl }, getDatabase());
      refresh();
      pushInBackground();
      return row;
    },
    [userId, refresh, pushInBackground],
  );

  const removeWater = useCallback(
    (id: string) => {
      if (!userId) return;
      deleteWaterLog(id, getDatabase());
      refresh();
      pushInBackground();
    },
    [userId, refresh, pushInBackground],
  );

  /**
   * Sets the daily target from today onward.
   *
   * A new period, never an edit: yesterday's history keeps the target it was
   * measured against, which is what makes "days goal met" mean anything.
   */
  const setWaterGoal = useCallback(
    (params: { targetMl: number; recommendedMl?: number | null; weightKg?: number | null }) => {
      if (!userId) return null;
      const row = openWaterGoal(
        {
          userId,
          effectiveFrom: todayIn(timeZone),
          targetMl: params.targetMl,
          recommendedMl: params.recommendedMl ?? null,
          basisWeightKg: params.weightKg ?? null,
        },
        getDatabase(),
      );
      refresh();
      pushInBackground();
      return row;
    },
    [userId, timeZone, refresh, pushInBackground],
  );

  return { addWater, updateWater, removeWater, setWaterGoal };
}
