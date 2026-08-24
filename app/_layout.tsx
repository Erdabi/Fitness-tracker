import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ErrorState, LoadingState } from '@/components/ui';
import { openDatabase } from '@/db/client';
import { registerAIProvider } from '@/features/ai/register';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { logger } from '@/lib/logger';
import { queryClient } from '@/state/queryClient';
import { ThemeProvider, useTheme } from '@/theme';

/**
 * Root layout.
 *
 * Provider order is deliberate: the local database opens before anything that
 * reads from it, and auth mounts inside it because signing in seeds local rows.
 */
export default function RootLayout() {
  const [dbState, setDbState] = useState<'opening' | 'ready' | 'failed'>('opening');

  useEffect(() => {
    try {
      openDatabase();
      // Scanning goes through Edge Functions, which hold the API key. Chosen
      // here so there is exactly one place the app decides what the AI
      // boundary is backed by.
      registerAIProvider();
      setDbState('ready');
    } catch (cause) {
      // Without local storage the app cannot function — every read goes
      // through SQLite — so this is a hard stop rather than a degraded mode.
      logger.error('Could not open local database', {
        reason: cause instanceof Error ? cause.message : 'unknown',
      });
      setDbState('failed');
    }
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <ThemedStatusBar />
          <ErrorBoundary>
            {dbState === 'opening' ? (
              <LoadingState label="Starting up" />
            ) : dbState === 'failed' ? (
              <ErrorState
                title="Could not open local storage"
                description="Restart the app. If this keeps happening, reinstalling will clear the local database."
              />
            ) : (
              <QueryClientProvider client={queryClient}>
                <AuthProvider>
                  <Stack screenOptions={{ headerShown: false }}>
                    <Stack.Screen name="(auth)" />
                    <Stack.Screen name="(tabs)" />
                    <Stack.Screen
                      name="settings"
                      options={{
                        headerShown: true,
                        title: 'Settings',
                        presentation: 'modal',
                      }}
                    />
                    <Stack.Screen
                      name="goals/index"
                      options={{ headerShown: true, title: 'Goal' }}
                    />
                    <Stack.Screen
                      name="goals/calculator"
                      options={{ headerShown: true, title: 'Calorie calculator' }}
                    />
                    <Stack.Screen
                      name="water/index"
                      options={{ headerShown: true, title: 'Water' }}
                    />
                    {/*
                      The barcode scanner owns the whole screen — a camera
                      preview under a navigation bar reads as a bug — so it is
                      the one route here without a header.
                    */}
                    <Stack.Screen name="scan/barcode" options={{ headerShown: false }} />
                    <Stack.Screen
                      name="scan/label"
                      options={{ headerShown: true, title: 'Nutrition label' }}
                    />
                    <Stack.Screen
                      name="scan/photo"
                      options={{ headerShown: true, title: 'Food photo' }}
                    />
                    <Stack.Screen
                      name="food/custom"
                      options={{ headerShown: true, title: 'Your own food' }}
                    />
                    {/*
                      The active session owns its own header: it shows an
                      editable name and a running timer, which a navigation
                      title cannot.
                    */}
                    <Stack.Screen
                      name="workout/[id]"
                      options={{ headerShown: true, title: 'Workout' }}
                    />
                    <Stack.Screen
                      name="exercises/index"
                      options={{ headerShown: true, title: 'Exercises' }}
                    />
                    <Stack.Screen
                      name="exercises/new"
                      options={{ headerShown: true, title: 'Exercise' }}
                    />
                    <Stack.Screen
                      name="exercises/[id]"
                      options={{ headerShown: true, title: 'Exercise' }}
                    />
                  </Stack>
                </AuthProvider>
              </QueryClientProvider>
            )}
          </ErrorBoundary>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/** Keeps the status bar legible against whichever theme is active. */
function ThemedStatusBar() {
  const theme = useTheme();
  return <StatusBar style={theme.name === 'dark' ? 'light' : 'dark'} />;
}
