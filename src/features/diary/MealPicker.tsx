import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui';
import { MEAL_SLOTS, type MealSlot } from '@/db/schema';
import { localHourFor } from '@/lib/date';
import { useTheme } from '@/theme';

const LABELS: Record<MealSlot, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
};

/** Which meal to preselect, from the time of day in the user's zone. */
export function defaultMealFor(instant: Date, timeZone: string): MealSlot {
  const hour = localHourFor(instant, timeZone);
  if (hour < 11) return 'breakfast';
  if (hour < 15) return 'lunch';
  if (hour < 21) return 'dinner';
  return 'snack';
}

/**
 * Which meal an entry belongs to.
 *
 * Four options, always visible, always one tap. A dropdown would hide the
 * choice behind an interaction on the screen people use several times a day.
 */
export function MealPicker({
  value,
  onChange,
}: {
  value: MealSlot;
  onChange: (meal: MealSlot) => void;
}) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="overline" color="secondary">
        Meal
      </Text>
      <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
        {MEAL_SLOTS.map((meal) => {
          const selected = meal === value;
          return (
            <Pressable
              key={meal}
              onPress={() => onChange(meal)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={LABELS[meal]}
              style={{
                flex: 1,
                alignItems: 'center',
                paddingVertical: theme.spacing.sm,
                borderRadius: theme.radius.md,
                borderWidth: 1,
                borderColor: selected ? theme.colors.accent : theme.colors.border,
                backgroundColor: selected ? theme.colors.accentMuted : 'transparent',
              }}
            >
              <Text variant="caption" color={selected ? 'accent' : 'secondary'}>
                {LABELS[meal]}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
