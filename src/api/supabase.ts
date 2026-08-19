import 'react-native-url-polyfill/auto';

import { createClient } from '@supabase/supabase-js';
import { AppState, type AppStateStatus } from 'react-native';

import { env } from '@/config/env';
import type { Database } from './database.types';
import { secureSessionStore } from './secureStorage';

/**
 * The Supabase client.
 *
 * Only the project URL and the anon key reach the device. Neither is a secret:
 * the anon key grants exactly what Row Level Security allows, and every table
 * denies access without a matching `auth.uid()`. The service-role key and the
 * model provider key live in Edge Function secrets and never appear here.
 */
export const supabase = createClient<Database>(env.supabaseUrl, env.supabaseAnonKey, {
  auth: {
    storage: secureSessionStore,
    persistSession: true,
    autoRefreshToken: true,
    // No URL bar in a native app; leaving this on makes the client look for a
    // session in a location that does not exist and delays startup.
    detectSessionInUrl: false,
    // PKCE is the correct flow for a public client that cannot hold a secret.
    flowType: 'pkce',
  },
});

/**
 * Refresh tokens only while the app is in front of the user.
 *
 * Supabase's timer keeps firing in the background otherwise, waking the app to
 * spend network and battery on a session nobody is using. Returns a cleanup
 * function for the caller to run on unmount.
 */
export function manageAutoRefresh(): () => void {
  const handleChange = (state: AppStateStatus): void => {
    if (state === 'active') {
      void supabase.auth.startAutoRefresh();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  };

  handleChange(AppState.currentState);
  const subscription = AppState.addEventListener('change', handleChange);

  return () => {
    subscription.remove();
    void supabase.auth.stopAutoRefresh();
  };
}
