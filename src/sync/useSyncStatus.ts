import * as Network from 'expo-network';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { getDatabase } from '@/db/client';
import { useAuth } from '@/features/auth/AuthProvider';
import { sync } from './engine';
import { countPending } from './outbox';
import type { SyncStatus } from './types';

const IDLE: SyncStatus = {
  phase: 'idle',
  pendingCount: 0,
  lastSyncedAt: null,
  lastError: null,
};

/**
 * Observes sync and drives its triggers.
 *
 * Two of the three triggers live here because they are lifecycle events the
 * engine has no view of: returning to the foreground, and regaining
 * connectivity. The third — after a mutation — fires from the repository that
 * made the write.
 */
export function useSyncStatus(): SyncStatus & { syncNow: () => void } {
  const { userId } = useAuth();
  const [status, setStatus] = useState<SyncStatus>(IDLE);
  const running = useRef(false);

  const run = useCallback(async () => {
    if (!userId || running.current) return;
    running.current = true;

    const db = getDatabase();
    setStatus((current) => ({ ...current, phase: 'pushing' }));

    const outcome = await sync({ db, userId });

    running.current = false;
    setStatus({
      phase: 'idle',
      pendingCount: countPending(db),
      lastSyncedAt: outcome.error ? null : Date.now(),
      lastError: outcome.error,
    });
  }, [userId]);

  // Keep the pending count fresh even when nothing triggers a cycle, so the
  // dashboard does not claim "up to date" while writes sit in the outbox.
  useEffect(() => {
    if (!userId) {
      setStatus(IDLE);
      return;
    }
    setStatus((current) => ({ ...current, pendingCount: countPending(getDatabase()) }));
  }, [userId]);

  // Trigger: app returns to the foreground.
  useEffect(() => {
    if (!userId) return;

    const handleChange = (state: AppStateStatus): void => {
      if (state === 'active') void run();
    };

    const subscription = AppState.addEventListener('change', handleChange);
    return () => subscription.remove();
  }, [userId, run]);

  // Trigger: connectivity returns.
  useEffect(() => {
    if (!userId) return;

    const subscription = Network.addNetworkStateListener((state) => {
      if (state.isConnected && state.isInternetReachable !== false) {
        void run();
      }
    });

    return () => subscription.remove();
  }, [userId, run]);

  return {
    ...status,
    syncNow: () => {
      void run();
    },
  };
}
