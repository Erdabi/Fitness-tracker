import type { Session } from '@supabase/supabase-js';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { manageAutoRefresh, supabase } from '@/api/supabase';
import { clearLocalUserData, getDatabase } from '@/db/client';
import { ensureLocalProfile } from '@/db/repositories/profiles';
import { resolveDeviceTimeZone } from '@/lib/date';
import { logger } from '@/lib/logger';
import type { AppError, Result } from '@/lib/result';
import { sync } from '@/sync/engine';
import * as authService from './authService';
import type { SignInInput, SignUpInput } from './validation';

/**
 * Session state and the operations that change it.
 *
 * Status is an explicit three-state machine rather than a nullable user. The
 * difference matters for routing: "we do not know yet" and "definitely signed
 * out" must not look the same, or the app redirects to sign-in for a frame
 * before restoring a perfectly good session.
 */
export type AuthStatus = 'restoring' | 'signedIn' | 'signedOut';

interface AuthContextValue {
  readonly status: AuthStatus;
  readonly session: Session | null;
  readonly userId: string | null;
  readonly signIn: (input: SignInInput) => Promise<Result<void>>;
  readonly signUp: (input: SignUpInput) => Promise<Result<authService.SignUpOutcome>>;
  readonly signOut: () => Promise<Result<void>>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('restoring');
  const [session, setSession] = useState<Session | null>(null);

  // Guards against seeding and syncing twice for one sign-in: onAuthStateChange
  // fires for both the restored session and the explicit sign-in call.
  const preparedUserId = useRef<string | null>(null);

  /**
   * Everything that must happen once per signed-in user: make sure local rows
   * exist so onboarding works offline, then reconcile with the server.
   */
  const prepareSession = useCallback((next: Session) => {
    if (preparedUserId.current === next.user.id) return;
    preparedUserId.current = next.user.id;

    try {
      ensureLocalProfile({
        userId: next.user.id,
        email: next.user.email ?? null,
        timeZone: resolveDeviceTimeZone(),
      });
    } catch (cause) {
      // The pull will still populate the profile; onboarding is what degrades.
      logger.error('Could not seed local profile', {
        reason: cause instanceof Error ? cause.message : 'unknown',
      });
    }

    // Deliberately not awaited: the UI reads from SQLite and must not wait on
    // the network. The engine handles its own failures.
    void sync({ db: getDatabase(), userId: next.user.id });
  }, []);

  useEffect(() => {
    let active = true;

    void (async () => {
      const restored = await authService.getSession();
      if (!active) return;

      if (restored.ok && restored.value) {
        setSession(restored.value);
        prepareSession(restored.value);
        setStatus('signedIn');
      } else {
        setStatus('signedOut');
      }
    })();

    const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return;

      setSession(nextSession);

      if (nextSession) {
        prepareSession(nextSession);
        setStatus('signedIn');
        return;
      }

      preparedUserId.current = null;
      setStatus('signedOut');

      if (event === 'SIGNED_OUT') {
        // Two people can share a phone; the next session must not inherit the
        // previous one's rows or its unsent writes.
        try {
          clearLocalUserData();
        } catch (cause) {
          logger.error('Could not clear local data on sign-out', {
            reason: cause instanceof Error ? cause.message : 'unknown',
          });
        }
      }
    });

    const stopAutoRefresh = manageAutoRefresh();

    return () => {
      active = false;
      data.subscription.unsubscribe();
      stopAutoRefresh();
    };
  }, [prepareSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      userId: session?.user.id ?? null,

      signIn: async (input) => {
        const result = await authService.signIn(input);
        // onAuthStateChange drives the state transition, so nothing to set here.
        return result.ok ? { ok: true, value: undefined } : result;
      },

      signUp: (input) => authService.signUp(input),

      signOut: () => authService.signOut(),
    }),
    [status, session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>.');
  }
  return context;
}

/** The signed-in user's id. Throws if called from an unauthenticated screen. */
export function useUserId(): string {
  const { userId } = useAuth();
  if (!userId) {
    throw new Error('useUserId called outside an authenticated route.');
  }
  return userId;
}

export type { AppError };
