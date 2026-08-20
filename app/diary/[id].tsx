import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { Button, Card, ErrorState, Screen, Text } from '@/components/ui';
import { getDatabase } from '@/db/client';
import { getFoodLog } from '@/db/repositories/foodLogs';
import type { FoodLogRow, MealSlot } from '@/db/schema';
import { MealPicker } from '@/features/diary/MealPicker';
import { portionOf } from '@/features/diary/DiaryEntryRow';
import { formatFullDay } from '@/features/diary/DayNavigator';
import { useDiaryMutations } from '@/features/diary/useDiary';
import { ServingSelector } from '@/features/food/ServingSelector';
import { asLocalDay } from '@/lib/date';
import { displayEnergy, type NutritionPerBase, type Serving } from '@/lib/nutrition';
import { useTheme } from '@/theme';

/**
 * Editing one entry.
 *
 * The screen the snapshot rule is most visible on. The serving selector is fed
 * the entry's OWN frozen basis, not the food it came from — so changing 200 g
 * to 300 g of something logged at 52 kcal/100 g gives 156 kcal, whatever that
 * food says today and whether or not it still exists. The food's identity is
 * shown but not editable, because an entry that could be repointed at a
 * different food would be a record of nothing.
 */
export default function DiaryEntryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const router = useRouter();
  const { updateEntry, removeEntry } = useDiaryMutations();

  // Read once: this is the entry as it was written, and re-reading it after
  // each keystroke would fight the selector for authority over the numbers.
  const [entry] = useState<FoodLogRow | undefined>(() =>
    id ? getFoodLog(id, getDatabase()) : undefined,
  );

  const [meal, setMeal] = useState<MealSlot>(entry?.meal ?? 'snack');
  const [selection, setSelection] = useState<{
    quantity: number;
    serving: Serving | null;
  } | null>(null);

  if (!entry) {
    return (
      <Screen>
        <ErrorState
          title="This entry is gone"
          description="It was removed, either here or on another device."
          retryLabel="Back to the diary"
          onRetry={() => router.back()}
        />
      </Screen>
    );
  }

  const basis = basisOf(entry);
  const food = { baseUnit: entry.basis_unit, baseAmount: entry.basis_amount };

  /*
   * The portion is offered back as a named option so the entry re-opens on the
   * portion it was logged with rather than resetting to grams.
   */
  const originalServing: Serving[] =
    entry.serving_amount === 1 && entry.serving_label === entry.basis_unit
      ? []
      : [
          {
            id: entry.serving_id ?? undefined,
            label: entry.serving_label,
            amount: entry.serving_amount,
            unit: entry.basis_unit,
          },
        ];

  return (
    <Screen scrollable keyboardAvoiding>
      <View style={{ gap: theme.spacing.xs, marginTop: theme.spacing.lg }}>
        <Text variant="displayMedium">{entry.food_name}</Text>
        {entry.brand_name ? (
          <Text variant="body" color="secondary">
            {entry.brand_name}
          </Text>
        ) : null}
        <Text variant="caption" color="muted">
          {formatFullDay(asLocalDay(entry.diary_date))} · logged as {portionOf(entry)} ·{' '}
          {displayEnergy(entry.calories)} kcal
        </Text>
      </View>

      {/*
        Stated plainly rather than left to be discovered. Someone who corrects
        a food in the catalogue and then finds their old entries unchanged
        should already know why.
      */}
      <Card>
        <Text variant="caption" color="secondary">
          This entry keeps the nutrition it was logged with
          {entry.food_is_verified ? ' (verified data)' : ''} — {entry.basis_calories} kcal
          per {entry.basis_amount} {entry.basis_unit}. Changing the amount rescales from
          that, so corrections to the food later never rewrite what you ate.
        </Text>
      </Card>

      <ServingSelector
        food={food}
        nutrition={basis}
        servings={originalServing}
        onChange={setSelection}
      />

      <View style={{ marginTop: theme.spacing.lg }}>
        <MealPicker value={meal} onChange={setMeal} />
      </View>

      <View style={{ flex: 1, minHeight: theme.spacing.lg }} />

      <Button
        label="Save changes"
        onPress={() => {
          updateEntry(entry.id, {
            meal,
            ...(selection
              ? { quantity: selection.quantity, serving: selection.serving }
              : {}),
          });
          router.back();
        }}
      />

      <Button
        label="Remove from diary"
        variant="danger"
        onPress={() => {
          Alert.alert(
            'Remove this entry?',
            `${entry.food_name} will be taken out of ${formatFullDay(asLocalDay(entry.diary_date))}.`,
            [
              { text: 'Keep it', style: 'cancel' },
              {
                text: 'Remove',
                style: 'destructive',
                onPress: () => {
                  removeEntry(entry.id);
                  router.back();
                },
              },
            ],
          );
        }}
      />
    </Screen>
  );
}

/** The entry's own frozen nutrition, per `basis_amount` of `basis_unit`. */
function basisOf(entry: FoodLogRow): NutritionPerBase {
  return {
    calories: entry.basis_calories,
    protein_g: entry.basis_protein_g,
    carbohydrates_g: entry.basis_carbohydrates_g,
    fat_g: entry.basis_fat_g,
    fiber_g: entry.basis_fiber_g,
    sugar_g: entry.basis_sugar_g,
    saturated_fat_g: entry.basis_saturated_fat_g,
    sodium_mg: entry.basis_sodium_mg,
  };
}
