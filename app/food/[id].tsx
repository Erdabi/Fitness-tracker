import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, ErrorState, LoadingState, Screen, Text } from '@/components/ui';
import { cacheFood, recordFoodUse } from '@/db/repositories/foodRecents';
import { getDatabase } from '@/db/client';
import { useAuth } from '@/features/auth/AuthProvider';
import { ServingSelector } from '@/features/food/ServingSelector';
import { getFoodDetail, type FoodDetail } from '@/features/food/foodDetailService';
import type { Serving } from '@/lib/nutrition';
import type { AppError } from '@/lib/result';
import { logger } from '@/lib/logger';
import { useTheme } from '@/theme';

/**
 * Food detail and serving selection.
 *
 * The screen a search result opens into. Picking a portion here is the last
 * step before logging, which arrives with the diary in the next milestone —
 * for now selecting a food records it as recently used and caches it, which
 * is what makes it available offline next time.
 */
export default function FoodDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const router = useRouter();
  const { userId } = useAuth();

  const [detail, setDetail] = useState<FoodDetail | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selection, setSelection] = useState<{
    quantity: number;
    serving: Serving | null;
  } | null>(null);

  const load = useCallback(async () => {
    if (!id) return;

    setIsLoading(true);
    setError(null);

    const result = await getFoodDetail(id);
    setIsLoading(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setDetail(result.value);

    // Cache on selection rather than on search: caching everything a user
    // scrolled past would fill the device with foods nobody chose.
    try {
      cacheFood(result.value.food, result.value.servings, getDatabase());
    } catch (cause) {
      // A cache miss costs offline availability, not correctness.
      logger.warn('Could not cache food', {
        reason: cause instanceof Error ? cause.name : 'unknown',
      });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (isLoading) return <LoadingState label="Loading food" />;

  if (error || !detail) {
    return (
      <Screen>
        <ErrorState
          title="Could not open this food"
          description={error?.message}
          onRetry={() => void load()}
        />
      </Screen>
    );
  }

  const { food, nutrition, servings, origin } = detail;

  return (
    <Screen scrollable keyboardAvoiding>
      <View style={{ gap: theme.spacing.xs, marginTop: theme.spacing.lg }}>
        <Text variant="displayMedium">{food.name}</Text>
        {food.brandName ? (
          <Text variant="body" color="secondary">
            {food.brandName}
          </Text>
        ) : null}

        <View style={{ flexDirection: 'row', gap: theme.spacing.sm, marginTop: theme.spacing.xs }}>
          <Provenance food={food} />
          {origin === 'cache' ? (
            <Text variant="overline" color="muted">
              Saved on this device
            </Text>
          ) : null}
        </View>
      </View>

      <ServingSelector
        food={{ baseUnit: food.baseUnit, baseAmount: food.baseAmount }}
        nutrition={nutrition}
        servings={servings}
        onChange={setSelection}
      />

      <View style={{ flex: 1 }} />

      {/*
        Logging lands with the diary. The button is present but honest about
        that rather than silently doing nothing — a control that looks live and
        is not is worse than one that says so.
      */}
      <Button
        label="Add to diary"
        disabled
        onPress={() => {
          /* Diary arrives in the next milestone. */
        }}
      />
      <Text variant="caption" color="muted" align="center">
        The food diary arrives in the next milestone.
      </Text>

      <Button
        label="Save to recents"
        variant="secondary"
        onPress={() => {
          if (!userId) return;
          recordFoodUse({ userId, foodId: food.foodId }, getDatabase());
          router.back();
        }}
      />

      {selection ? (
        <Text variant="caption" color="muted" align="center">
          {selection.quantity} × {selection.serving?.label ?? `${food.baseAmount} ${food.baseUnit}`}
        </Text>
      ) : null}
    </Screen>
  );
}

/** States where a number came from, only when it changes how to read it. */
function Provenance({ food }: { food: FoodDetail['food'] }) {
  if (food.isOwn) {
    return (
      <Text variant="overline" color="accent">
        Your food
      </Text>
    );
  }

  if (food.sourceId === 'ai_estimated') {
    return (
      <Text variant="overline" color="warning">
        Estimated — check before logging
      </Text>
    );
  }

  return (
    <Text variant="overline" color={food.isVerified ? 'success' : 'muted'}>
      {food.isVerified ? 'Verified data' : 'Community data'}
    </Text>
  );
}
