import { QueryClient } from '@tanstack/react-query';

/**
 * Query client.
 *
 * Tuned for an offline-first app: reads come from SQLite, which is already
 * local and fast, so the defaults that make sense for a network-backed cache
 * are wrong here.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Local reads are cheap, but refetching on every focus still causes
      // avoidable re-renders. A short window covers navigation without
      // serving genuinely stale data.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      // The sync engine owns network retries; a second retry policy here would
      // just multiply the requests.
      retry: false,
      refetchOnReconnect: false,
      // Sync writes land in SQLite, not through this cache, so a focus
      // refetch is how the UI notices them.
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: false,
    },
  },
});
