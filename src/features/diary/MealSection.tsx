import { View } from 'react-native';

import { Card, Text } from '@/components/ui';
import type { FoodLogRow, MealSlot } from '@/db/schema';
import { displayEnergy, type ScaledNutrition } from '@/lib/nutrition';
import { useTheme } from '@/theme';
import { DiaryEntryRow } from './DiaryEntryRow';

const MEAL_LABELS: Record<MealSlot, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snacks',
};

/**
 * One meal, its entries and its subtotal.
 *
 * Empty meals still render. A day with breakfast logged and nothing else is a
 * different thing from a day where lunch has not happened yet, and the row
 * that says "Lunch — add food" is the affordance that makes logging the next
 * meal one tap rather than a search through a tab bar.
 */
export function MealSection({
  meal,
  entries,
  subtotal,
  onAdd,
  onSelectEntry,
}: {
  meal: MealSlot;
  entries: readonly FoodLogRow[];
  subtotal: ScaledNutrition;
  onAdd: () => void;
  onSelectEntry: (entry: FoodLogRow) => void;
}) {
  const theme = useTheme();

  return (
    <Card flush>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: theme.spacing.lg,
          paddingTop: theme.spacing.lg,
          paddingBottom: entries.length > 0 ? theme.spacing.sm : theme.spacing.lg,
        }}
      >
        <Text variant="overline" color="secondary">
          {MEAL_LABELS[meal]}
        </Text>
        {entries.length > 0 ? (
          <Text variant="caption" color="muted">
            {displayEnergy(subtotal.calories)} kcal
          </Text>
        ) : null}
      </View>

      {entries.map((entry) => (
        <DiaryEntryRow
          key={entry.id}
          entry={entry}
          onPress={() => onSelectEntry(entry)}
        />
      ))}

      <Text
        variant="callout"
        color="accent"
        onPress={onAdd}
        accessibilityRole="button"
        style={{
          paddingHorizontal: theme.spacing.lg,
          paddingTop: entries.length > 0 ? theme.spacing.sm : 0,
          paddingBottom: theme.spacing.lg,
        }}
      >
        {entries.length > 0 ? 'Add another' : `Add ${MEAL_LABELS[meal].toLowerCase()}`}
      </Text>
    </Card>
  );
}
