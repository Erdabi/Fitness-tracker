import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { EmptyState, Screen, Text, TextField } from '@/components/ui';
import { FoodResultRow } from '@/features/food/FoodResultRow';
import { useFoodSearch } from '@/features/food/useFoodSearch';
import type { FoodSearchResult } from '@/features/food/types';
import { useTheme } from '@/theme';

/**
 * Food search.
 *
 * Built for repetition: most logging is the same twenty foods, so the screen
 * opens straight into recents and typing is the exception rather than the
 * entry point.
 */
export default function FoodSearchScreen() {
  const theme = useTheme();
  const router = useRouter();
  const {
    query,
    results,

    isSearching,
    isLoadingMore,
    error,
    hasMore,
    showingRecents,
    setQuery,
    loadMore,
  } = useFoodSearch();

  const handleSelect = useCallback(
    (result: FoodSearchResult) => {
      router.push({ pathname: '/food/[id]', params: { id: result.foodId } });
    },
    [router],
  );

  const renderItem = useCallback(
    ({ item }: { item: FoodSearchResult }) => (
      <FoodResultRow result={item} onPress={handleSelect} />
    ),
    [handleSelect],
  );

  return (
    <Screen flush keyboardAvoiding>
      <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.lg }}>
        <TextField
          label="Search foods"
          value={query}
          onChangeText={setQuery}
          placeholder="Apple, Greek yogurt, Snickers…"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          // The list updates as you type; dismissing the keyboard on submit
          // just reveals more of the results already there.
          clearButtonMode="while-editing"
        />
      </View>

      {/*
        Origin is stated rather than implied. Someone offline is looking at
        what their device already had, which is not the same as everything
        that exists — presenting the two identically would be a lie of omission.
      */}
      {error && error.kind === 'network' ? (
        <Banner tone="warning" text={error.message} />
      ) : showingRecents && results.length > 0 ? (
        <Banner tone="muted" text="Your recent foods · available offline" />
      ) : error ? (
        <Banner tone="danger" text={error.message} />
      ) : null}

      <FlashList
        data={results as FoodSearchResult[]}
        renderItem={renderItem}
        keyExtractor={(item) => item.foodId}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onEndReached={hasMore ? loadMore : undefined}
        onEndReachedThreshold={0.6}
        ListEmptyComponent={
          isSearching ? null : (
            <EmptyStateForContext query={query} showingRecents={showingRecents} />
          )
        }
        ListFooterComponent={
          isLoadingMore ? (
            <View style={{ padding: theme.spacing.lg }}>
              <ActivityIndicator color={theme.colors.accent} />
            </View>
          ) : null
        }
      />

      {/*
        A spinner overlaying results rather than replacing them: the previous
        list stays readable while a refined query is in flight, so the screen
        does not flash empty on every pause in typing.
      */}
      {isSearching ? (
        <View
          style={{
            position: 'absolute',
            top: 96,
            alignSelf: 'center',
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing.sm,
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.surface,
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
          accessibilityLiveRegion="polite"
        >
          <Text variant="caption" color="muted">
            Searching…
          </Text>
        </View>
      ) : null}
    </Screen>
  );
}

function Banner({ tone, text }: { tone: 'muted' | 'warning' | 'danger'; text: string }) {
  const theme = useTheme();
  const background =
    tone === 'warning'
      ? theme.colors.warningMuted
      : tone === 'danger'
        ? theme.colors.dangerMuted
        : theme.colors.surfaceMuted;

  return (
    <View
      style={{
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.sm,
        backgroundColor: background,
      }}
      accessibilityLiveRegion="polite"
    >
      <Text variant="caption" color={tone === 'muted' ? 'muted' : tone}>
        {text}
      </Text>
    </View>
  );
}

function EmptyStateForContext({
  query,
  showingRecents,
}: {
  query: string;
  showingRecents: boolean;
}) {
  if (showingRecents) {
    return (
      <EmptyState
        title="No recent foods yet"
        description="Search for a food to log it. Anything you log shows up here for next time."
      />
    );
  }

  if (query.trim().length < 2) {
    return (
      <EmptyState
        title="Keep typing"
        description="Enter at least two characters to search."
      />
    );
  }

  return (
    <EmptyState
      title={`Nothing found for “${query.trim()}”`}
      description="Check the spelling, or create it as your own food."
    />
  );
}
