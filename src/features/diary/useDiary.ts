import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { getDatabase } from '@/db/client';
import {
  createFoodLog,
  dayTotals,
  deleteFoodLog,
  editFoodLog,
  frequentFoods,
  listDay,
  repeatFoodLog,
  type DayTotals,
  type EditFoodLogInput,
  type LogFoodInput,
} from '@/db/repositories/foodLogs';
import type { FoodLogRow, MealSlot } from '@/db/schema';
import { useAuth } from '@/features/auth/AuthProvider';
import { useProfile } from '@/features/profile/useProfile';
import { resolveDeviceTimeZone, todayIn, type LocalDay } from '@/lib/date';
import { sync } from '@/sync/engine';
import { createSupabaseRemote } from '@/sync/remote';

/**
 * The diary, read from SQLite.
 *
 * Everything the day view renders comes from the device: entries, subtotals,
 * day totals. No screen waits on a network request to show what someone ate,
 * because the answer is already here — sync is a background reconciliation,
 * not a prerequisite for reading.
 */

/** One adapter for the app; tests drive the repositories directly. */
const remote = createSupabaseRemote();

const dayKey = (userId: string, day: string) => ['diary', userId, day] as const;

/**
 * The zone the user's days are measured in.
 *
 * The profile's zone wins over the device's. They are usually the same, and
 * when they are not it is because the user is travelling — in which case the
 * question "which day is this" should still be answered the way the rest of
 * their history was, until they change it deliberately.
 */
export function useDiaryTimeZone(): string {
  const { profile } = useProfile();
  return profile?.time_zone ?? resolveDeviceTimeZone();
}

export function useToday(): LocalDay {
  return todayIn(useDiaryTimeZone());
}

export interface DiaryDay {
  readonly entries: readonly FoodLogRow[];
  readonly totals: DayTotals | null;
  readonly isLoading: boolean;
  readonly error: unknown;
}

export function useDiaryDay(day: LocalDay): DiaryDay {
  const { userId } = useAuth();

  const query = useQuery({
    queryKey: dayKey(userId ?? 'anonymous', day),
    enabled: userId !== null,
    queryFn: () => {
      if (!userId) return null;
      const db = getDatabase();
      return { entries: listDay(userId, day, db), totals: dayTotals(userId, day, db) };
    },
  });

  return {
    entries: query.data?.entries ?? [],
    totals: query.data?.totals ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}

/**
 * Logging, editing and removing entries.
 *
 * Each mutation writes locally, refreshes the affected day, and kicks a sync
 * without waiting for it. The local write has already succeeded by then; if
 * the push fails the outbox retries, and the entry stays in the diary
 * throughout.
 */
export function useDiaryMutations() {
  const { userId } = useAuth();
  const queryClient = useQueryClient();

  const refresh = useCallback(
    (day?: string) => {
      if (!userId) return;
      void queryClient.invalidateQueries({
        queryKey: day ? dayKey(userId, day) : ['diary', userId],
      });
    },
    [queryClient, userId],
  );

  const pushInBackground = useCallback(() => {
    if (!userId) return;
    void sync({ db: getDatabase(), userId, remote });
  }, [userId]);

  const logFood = useCallback(
    (input: Omit<LogFoodInput, 'userId'>): FoodLogRow | null => {
      if (!userId) return null;
      const row = createFoodLog({ ...input, userId }, getDatabase());
      refresh(row.diary_date);
      pushInBackground();
      return row;
    },
    [userId, refresh, pushInBackground],
  );

  const updateEntry = useCallback(
    (id: string, patch: EditFoodLogInput): FoodLogRow | null => {
      if (!userId) return null;
      const row = editFoodLog(id, patch, getDatabase());
      // An edit can move an entry between days, so both are stale.
      refresh();
      pushInBackground();
      return row;
    },
    [userId, refresh, pushInBackground],
  );

  const removeEntry = useCallback(
    (id: string) => {
      if (!userId) return;
      deleteFoodLog(id, getDatabase());
      refresh();
      pushInBackground();
    },
    [userId, refresh, pushInBackground],
  );

  /**
   * Logs a previous entry again, onto whichever day and meal is asked for.
   *
   * Reads and writes only the device, so "the same as yesterday" is one tap
   * with no network and no search — which is what most logging actually is.
   */
  const repeatEntry = useCallback(
    (
      sourceLogId: string,
      target: { meal?: MealSlot; diaryDate?: LocalDay },
    ): FoodLogRow | null => {
      if (!userId) return null;
      const row = repeatFoodLog(sourceLogId, target, getDatabase());
      refresh(row.diary_date);
      pushInBackground();
      return row;
    },
    [userId, refresh, pushInBackground],
  );

  return { logFood, updateEntry, removeEntry, repeatEntry };
}

/**
 * The foods this person logs most, over the last 90 days.
 *
 * A real answer rather than an all-time tally: see `frequentFoods`. Reads the
 * diary, so it works offline and costs the server nothing.
 */
export function useFrequentFoods(limit = 10) {
  const { userId } = useAuth();
  const timeZone = useDiaryTimeZone();

  const query = useQuery({
    queryKey: ['diary-frequent', userId ?? 'anonymous', limit],
    enabled: userId !== null,
    queryFn: () =>
      userId ? frequentFoods(userId, { limit, timeZone }, getDatabase()) : [],
  });

  return { foods: query.data ?? [], isLoading: query.isLoading };
}
