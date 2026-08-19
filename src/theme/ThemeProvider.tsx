import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useColorScheme } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { darkTheme, lightTheme, type Theme } from './tokens';
import { logger } from '@/lib/logger';

export type ThemePreference = 'light' | 'dark' | 'system';

const PREFERENCE_KEY = 'theme_preference';

interface ThemeContextValue {
  readonly theme: Theme;
  readonly preference: ThemePreference;
  readonly setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  // Restore the stored preference. Until it loads we follow the system, which
  // matches what the OS splash screen already showed — so there is no flash.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const stored = await SecureStore.getItemAsync(PREFERENCE_KEY);
        if (!cancelled && isThemePreference(stored)) {
          setPreferenceState(stored);
        }
      } catch (cause) {
        // A missing preference is not worth failing the app over.
        logger.warn('Could not read theme preference', {
          reason: cause instanceof Error ? cause.name : 'unknown',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    void SecureStore.setItemAsync(PREFERENCE_KEY, next).catch((cause: unknown) => {
      logger.warn('Could not persist theme preference', {
        reason: cause instanceof Error ? cause.name : 'unknown',
      });
    });
  }, []);

  const value = useMemo<ThemeContextValue>(() => {
    const resolved = preference === 'system' ? (systemScheme ?? 'light') : preference;
    return {
      theme: resolved === 'dark' ? darkTheme : lightTheme,
      preference,
      setPreference,
    };
  }, [preference, systemScheme, setPreference]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useThemeContext().theme;
}

export function useThemePreference(): {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
} {
  const { preference, setPreference } = useThemeContext();
  return { preference, setPreference };
}

function useThemeContext(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used inside <ThemeProvider>.');
  }
  return context;
}

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}
