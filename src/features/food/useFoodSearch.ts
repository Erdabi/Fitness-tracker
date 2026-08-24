import { useCallback, useEffect, useRef, useState } from 'react';

import { getDatabase } from '@/db/client';
import { listLocalRecents } from '@/db/repositories/foodRecents';
import { useAuth } from '@/features/auth/AuthProvider';
import type { AppError } from '@/lib/result';
import { MIN_QUERY_LENGTH, searchFoods } from './searchService';
import type { FoodSearchResult, ResultOrigin, SearchCursor } from './types';

/**
 * Debounced, paginated food search.
 *
 * Holds the whole interaction: what the user typed, what came back, whether it
 * came from the server or the device, and whether there is more.
 *
 * Two behaviours matter more than the rest:
 *
 *   • The input does not fire a request per keystroke. Typing "chicken breast"
 *     would otherwise be fourteen searches, thirteen of them already stale.
 *   • A response only lands if it is still the response to what is currently
 *     in the box. Without that check, a slow early request can overwrite the
 *     results of a later, faster one.
 */

/**
 * Long enough that a typed word settles, short enough to feel immediate.
 * Below ~200 ms the network sees most keystrokes; above ~400 ms it drags.
 */
export const SEARCH_DEBOUNCE_MS = 280;

export interface FoodSearchState {
  readonly query: string;
  readonly results: readonly FoodSearchResult[];
  readonly origin: ResultOrigin;
  readonly isSearching: boolean;
  readonly isLoadingMore: boolean;
  readonly error: AppError | null;
  readonly hasMore: boolean;
  /** True when the box is empty and the list is showing recents instead. */
  readonly showingRecents: boolean;
}

/**
 * @param initialQuery Seeds the box on mount. Used when another screen already
 *   knows what is being looked for — a food photo naming "grilled chicken
 *   breast", for instance — so the user is not asked to retype it.
 */
export function useFoodSearch(initialQuery = '') {
  const { userId } = useAuth();

  const [query, setQuery] = useState(initialQuery);
  const [state, setState] = useState<FoodSearchState>({
    query: initialQuery,
    results: [],
    origin: 'recent',
    isSearching: false,
    isLoadingMore: false,
    error: null,
    hasMore: false,
    showingRecents: initialQuery.length < MIN_QUERY_LENGTH,
  });

  const cursorRef = useRef<SearchCursor | null>(null);
  // Identifies the request a response belongs to, so a stale one is dropped.
  const requestIdRef = useRef(0);

  /** Recents come from SQLite, so they are instant and work with no signal. */
  const loadRecents = useCallback(() => {
    if (!userId) return;

    try {
      const recents = listLocalRecents(userId, 'recent', 20, getDatabase());
      setState((current) => ({
        ...current,
        query: '',
        results: recents,
        origin: 'recent',
        isSearching: false,
        error: null,
        hasMore: false,
        showingRecents: true,
      }));
    } catch {
      setState((current) => ({ ...current, results: [], showingRecents: true }));
    }
  }, [userId]);

  useEffect(() => {
    loadRecents();
  }, [loadRecents]);

  // Debounce: restart the timer on every keystroke, search when typing pauses.
  useEffect(() => {
    const trimmed = query.trim();

    if (trimmed.length < MIN_QUERY_LENGTH) {
      // Cancels any in-flight response as well as the pending timer.
      requestIdRef.current += 1;
      loadRecents();
      return;
    }

    setState((current) => ({ ...current, isSearching: true, error: null }));

    const requestId = ++requestIdRef.current;
    const timer = setTimeout(() => {
      void (async () => {
        const result = await searchFoods(trimmed, { limit: 25 });

        // A newer keystroke has already superseded this request.
        if (requestId !== requestIdRef.current) return;

        if (!result.ok) {
          setState((current) => ({
            ...current,
            query: trimmed,
            isSearching: false,
            error: result.error,
            // Keep whatever is on screen; replacing results with nothing on a
            // dropped connection is worse than leaving them in place.
            showingRecents: false,
          }));
          return;
        }

        cursorRef.current = result.value.nextCursor;
        setState({
          query: trimmed,
          results: result.value.results,
          origin: result.value.origin,
          isSearching: false,
          isLoadingMore: false,
          error: null,
          hasMore: result.value.nextCursor !== null,
          showingRecents: false,
        });
      })();
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, loadRecents]);

  const loadMore = useCallback(() => {
    const cursor = cursorRef.current;
    if (!cursor || state.isLoadingMore || state.showingRecents) return;

    setState((current) => ({ ...current, isLoadingMore: true }));
    const requestId = requestIdRef.current;

    void (async () => {
      const result = await searchFoods(state.query, { limit: 25, cursor });
      if (requestId !== requestIdRef.current) return;

      if (!result.ok) {
        setState((current) => ({
          ...current,
          isLoadingMore: false,
          error: result.error,
        }));
        return;
      }

      cursorRef.current = result.value.nextCursor;
      setState((current) => ({
        ...current,
        // Appended, not replaced: keyset pagination guarantees no overlap.
        results: [...current.results, ...result.value.results],
        isLoadingMore: false,
        hasMore: result.value.nextCursor !== null,
      }));
    })();
  }, [state.query, state.isLoadingMore, state.showingRecents]);

  const retry = useCallback(() => {
    setQuery((current) => `${current} `.trimEnd());
    requestIdRef.current += 1;
    setState((current) => ({ ...current, error: null }));
  }, []);

  return { ...state, setQuery, loadMore, retry, refreshRecents: loadRecents };
}
