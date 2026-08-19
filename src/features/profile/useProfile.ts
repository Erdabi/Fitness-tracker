import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { getDatabase } from '@/db/client';
import {
  getProfile,
  getSettings,
  updateProfile,
  updateSettings,
  type ProfileUpdate,
  type SettingsUpdate,
} from '@/db/repositories/profiles';
import { useAuth } from '@/features/auth/AuthProvider';
import { sync } from '@/sync/engine';
import { createSupabaseRemote } from '@/sync/remote';

/**
 * Profile and settings, read from SQLite.
 *
 * The query function touches only the local database, so this resolves without
 * a network round trip and works offline. Sync updates the same rows in the
 * background; invalidating after a write is what surfaces the change.
 */

/** One adapter for the app; tests inject their own through SyncContext. */
const remote = createSupabaseRemote();

const profileKey = (userId: string) => ['profile', userId] as const;

export function useProfile() {
  const { userId } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: profileKey(userId ?? 'anonymous'),
    enabled: userId !== null,
    queryFn: () => {
      if (!userId) return null;
      const db = getDatabase();
      return {
        profile: getProfile(userId, db) ?? null,
        settings: getSettings(userId, db) ?? null,
      };
    },
  });

  const invalidate = useCallback(() => {
    if (userId) {
      void queryClient.invalidateQueries({ queryKey: profileKey(userId) });
    }
  }, [queryClient, userId]);

  const saveProfile = useCallback(
    (patch: ProfileUpdate) => {
      if (!userId) return;
      updateProfile(userId, patch);
      invalidate();
      // Not awaited: the local write already succeeded and the UI reads from
      // SQLite. Pushing is the engine's problem, and it retries on failure.
      void sync({ db: getDatabase(), userId, remote });
    },
    [userId, invalidate],
  );

  const saveSettings = useCallback(
    (patch: SettingsUpdate) => {
      if (!userId) return;
      updateSettings(userId, patch);
      invalidate();
      void sync({ db: getDatabase(), userId, remote });
    },
    [userId, invalidate],
  );

  return {
    profile: query.data?.profile ?? null,
    settings: query.data?.settings ?? null,
    isLoading: query.isLoading,
    error: query.error,
    saveProfile,
    saveSettings,
    refetch: invalidate,
  };
}
