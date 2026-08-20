import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Text, TextField } from '@/components/ui';
import {
  displayEnergy,
  displayMacro,
  nutritionFor,
  servingOptions,
  type FoodBasis,
  type NutritionPerBase,
  type Serving,
} from '@/lib/nutrition';
import { useTheme } from '@/theme';

/**
 * Portion and quantity picker.
 *
 * Every number shown is computed from the food's canonical values by
 * `nutritionFor` — nothing here is precomputed or passed in already scaled. If
 * 100 g is 52 kcal then 150 g renders as 78 kcal because the arithmetic says
 * so, not because anyone stored that.
 */
export function ServingSelector({
  food,
  nutrition,
  servings,
  onChange,
}: {
  food: FoodBasis;
  nutrition: NutritionPerBase;
  servings: readonly Serving[];
  onChange?: (state: { quantity: number; serving: Serving | null }) => void;
}) {
  const theme = useTheme();
  const options = useMemo(() => servingOptions(food, servings), [food, servings]);

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [quantityText, setQuantityText] = useState('1');

  const selected = options[selectedIndex] ?? options[0]!;
  const quantity = Number(quantityText.replace(',', '.'));
  const isValidQuantity = Number.isFinite(quantity) && quantity > 0;

  const computed = useMemo(() => {
    if (!isValidQuantity) return null;
    // The base-unit option is a serving like any other, so one code path
    // handles "150 g" and "2 medium" alike.
    return nutritionFor(nutrition, food, quantity, selected);
  }, [isValidQuantity, nutrition, food, quantity, selected]);

  /*
   * Report the current selection whenever it is valid — including on mount.
   *
   * Reporting only from the tap handlers would leave the caller with nothing
   * until the user touched something, so a screen whose defaults are already
   * correct ("1 × 100 g") would have no selection to log. Deriving it from
   * state instead of from events means there is one answer, and it is the one
   * on screen.
   */
  useEffect(() => {
    if (isValidQuantity) onChange?.({ quantity, serving: selected });
  }, [isValidQuantity, quantity, selected, onChange]);

  return (
    <View style={{ gap: theme.spacing.lg }}>
      <View style={{ gap: theme.spacing.sm }}>
        <Text variant="overline" color="muted">
          Serving
        </Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: theme.spacing.sm }}
        >
          {options.map((option, index) => {
            const active = index === selectedIndex;
            return (
              <Pressable
                key={`${option.label}-${option.amount}`}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${option.label}, ${option.amount} ${option.unit}`}
                onPress={() => setSelectedIndex(index)}
                style={{
                  paddingVertical: theme.spacing.sm,
                  paddingHorizontal: theme.spacing.md,
                  borderRadius: theme.radius.pill,
                  borderWidth: active ? 2 : 1,
                  borderColor: active ? theme.colors.accent : theme.colors.border,
                  backgroundColor: active ? theme.colors.accentMuted : theme.colors.surface,
                }}
              >
                <Text variant="callout" color={active ? 'accent' : 'primary'}>
                  {option.label}
                </Text>
                {/* The gram equivalent is what makes the portion meaningful. */}
                {option.unit !== 'item' && option.amount !== food.baseAmount ? (
                  <Text variant="caption" color="muted">
                    {option.amount} {option.unit}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <TextField
        label="Quantity"
        value={quantityText}
        onChangeText={setQuantityText}
        keyboardType="decimal-pad"
        error={quantityText.length > 0 && !isValidQuantity ? 'Enter a number above zero' : undefined}
        hint={`× ${selected.label}`}
      />

      <View
        style={{
          padding: theme.spacing.lg,
          borderRadius: theme.radius.lg,
          backgroundColor: theme.colors.surfaceMuted,
          gap: theme.spacing.sm,
        }}
        accessibilityLiveRegion="polite"
      >
        {computed ? (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text variant="headline">Energy</Text>
              <Text variant="metric" tabular>
                {displayEnergy(computed.scaled.calories)}
                <Text variant="caption" color="muted">
                  {' '}
                  kcal
                </Text>
              </Text>
            </View>

            <Text variant="caption" color="muted" tabular>
              {computed.resolved.amountInBase} {computed.resolved.baseUnit}
            </Text>

            <View style={{ flexDirection: 'row', gap: theme.spacing.lg, marginTop: theme.spacing.sm }}>
              <Macro label="Protein" grams={computed.scaled.protein_g} />
              <Macro label="Carbs" grams={computed.scaled.carbohydrates_g} />
              <Macro label="Fat" grams={computed.scaled.fat_g} />
              <Macro label="Fibre" grams={computed.scaled.fiber_g} />
            </View>
          </>
        ) : (
          <Text variant="callout" color="muted">
            Enter a quantity to see the nutrition.
          </Text>
        )}
      </View>
    </View>
  );
}

/** A nutrient with no reported value shows an em dash, never 0 g. */
function Macro({ label, grams }: { label: string; grams: number | null }) {
  const value = displayMacro(grams);
  return (
    <View style={{ gap: 2 }}>
      <Text variant="overline" color="muted">
        {label}
      </Text>
      <Text variant="callout" tabular>
        {value === null ? '—' : `${value} g`}
      </Text>
    </View>
  );
}
