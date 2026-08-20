import { Pressable, ScrollView, View } from 'react-native';

import { Text } from '@/components/ui';
import type { FrequentFood } from '@/db/repositories/foodLogs';
import { useTheme } from '@/theme';

/**
 * One-tap repeats of what this person actually eats.
 *
 * Ranked by how often each food was logged in the last 90 days — a real
 * window, not an all-time tally, so a breakfast someone gave up in January
 * stops crowding out the one they eat now.
 *
 * Every row here is served from the device and logs without a network,
 * because it repeats an entry's own snapshot rather than looking the food up.
 */
export function FrequentStrip({
  foods,
  onRepeat,
}: {
  foods: readonly FrequentFood[];
  onRepeat: (food: FrequentFood) => void;
}) {
  const theme = useTheme();
  if (foods.length === 0) return null;

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="overline" color="secondary">
        Log again
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: theme.spacing.sm }}
      >
        {foods.map((food) => (
          <Pressable
            key={food.foodId}
            onPress={() => onRepeat(food)}
            accessibilityRole="button"
            accessibilityLabel={`Log ${food.name} again. Logged ${food.logCount} times in the last 90 days.`}
            style={({ pressed }) => ({
              maxWidth: 200,
              paddingVertical: theme.spacing.sm,
              paddingHorizontal: theme.spacing.md,
              borderRadius: theme.radius.pill,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: pressed ? theme.colors.surfaceMuted : theme.colors.surface,
            })}
          >
            <Text variant="callout" numberOfLines={1}>
              {food.name}
            </Text>
            <Text variant="caption" color="muted">
              {food.logCount}× recently
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
