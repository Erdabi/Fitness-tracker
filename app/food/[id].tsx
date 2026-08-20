import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { Button, ErrorState, LoadingState, Screen, Text } from '@/components/ui';
import { cacheFood, recordFoodUse } from '@/db/repositories/foodRecents';
import { getDatabase } from '@/db/client';
import type { MealSlot } from '@/db/schema';
import { useAuth } from '@/features/auth/AuthProvider';
import { MealPicker, defaultMealFor } from '@/features/diary/MealPicker';
import { describeDay } from '@/features/diary/DayNavigator';
import { useDiaryMutations, useDiaryTimeZone, useToday } from '@/features/diary/useDiary';
import { ServingSelector } from '@/features/food/ServingSelector';
import { getFoodDetail, type FoodDetail } from '@/features/food/foodDetailService';
import { isLocalDay, type LocalDay } from '@/lib/date';
import { servingOptions, type Serving } from '@/lib/nutrition';
import type { AppError } from '@/lib/result';
import { logger } from '@/lib/logger';
import { useTheme } from '@/theme';

/**
 * Food detail, serving selection and logging.
 *
 * The last step before an entry exists. Every number on screen is computed by
 * `ServingSelector` from the food's canonical values, and the same quantity
 * and portion are handed to `logFood` — so what the user confirmed is exactly
 * what gets written, rather than being recomputed on the way in.
 */
export default function FoodDetailScreen() {
  const { id, meal: mealParam, day: dayParam } = useLocalSearchParams<{
    id: string;
    meal?: string;
    day?: string;
  }>();
  const theme = useTheme();
  const router = useRouter();
  const { userId } = useAuth();
  const timeZone = useDiaryTimeZone();
  const today = useToday();
  const { logFood } = useDiaryMutations();

  // The meal and day the diary sent us, when it sent any. Otherwise: today,
  // and whichever meal the clock suggests.
  const targetDay: LocalDay =
    dayParam && isLocalDay(dayParam) ? dayParam : today;
  const initialMeal = useMemo<MealSlot>(
    () => asMeal(mealParam) ?? defaultMealFor(new Date(), timeZone),
    [mealParam, timeZone],
  );

  const [meal, setMeal] = useState<MealSlot>(initialMeal);
  const [isSaving, setIsSaving] = useState(false);

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

  /*
   * The selector reports its state on mount, so `selection` is set before the
   * user can press anything. The fallback covers the single render before that
   * lands, and it is the selector's own default — the food's first portion —
   * rather than a bare quantity, which would mean "1 gram".
   */
  const chosen =
    selection ??
    {
      quantity: 1,
      serving: servingOptions(
        { baseUnit: food.baseUnit, baseAmount: food.baseAmount },
        servings,
      )[0]!,
    };

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

      <View style={{ marginTop: theme.spacing.lg }}>
        <MealPicker value={meal} onChange={setMeal} />
      </View>

      <View style={{ flex: 1, minHeight: theme.spacing.lg }} />

      <Button
        label={`Add to ${describeDay(targetDay, today).toLowerCase()}`}
        loading={isSaving}
        onPress={() => {
          if (!userId || isSaving) return;
          setIsSaving(true);

          try {
            logFood({
              meal,
              food: {
                foodId: food.foodId,
                name: food.name,
                brandName: food.brandName,
                sourceId: food.sourceId,
                isVerified: food.isVerified,
                baseUnit: food.baseUnit,
                baseAmount: food.baseAmount,
              },
              // Snapshotted as the entry's basis. Nothing downstream reads
              // this food again.
              nutrition,
              quantity: chosen.quantity,
              serving: chosen.serving,
              servingId: chosen.serving?.id ?? null,
              timeZone,
              diaryDate: targetDay,
            });

            // Logging is a use. Recording it here rather than inside the diary
            // keeps "what I reach for" about the catalogue, and leaves the
            // diary free of a second write path.
            recordFoodUse({ userId, foodId: food.foodId }, getDatabase());
            router.back();
          } catch (cause) {
            setIsSaving(false);
            logger.error('Could not log food', {
              reason: cause instanceof Error ? cause.message : 'unknown',
            });
          }
        }}
      />

      <Text variant="caption" color="muted" align="center">
        {summarise(chosen, food)}
      </Text>
    </Screen>
  );
}

function asMeal(value: string | undefined): MealSlot | null {
  return value === 'breakfast' || value === 'lunch' || value === 'dinner' || value === 'snack'
    ? value
    : null;
}

/** Restates what is about to be written, in the user's own terms. */
function summarise(
  chosen: { quantity: number; serving: Serving | null },
  food: FoodDetail['food'],
): string {
  return chosen.serving
    ? `${chosen.quantity} × ${chosen.serving.label}`
    : `${chosen.quantity} × ${food.baseAmount} ${food.baseUnit}`;
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
