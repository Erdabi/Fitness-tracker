import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui';
import type { FoodLogRow } from '@/db/schema';
import { displayEnergy, displayMacro } from '@/lib/nutrition';
import { useTheme } from '@/theme';

/**
 * One logged item.
 *
 * Everything shown comes from the entry's own snapshot — the name it had when
 * it was logged, the numbers it was logged with. Nothing is looked up, which
 * is what lets a diary render offline and lets a five-year-old entry render at
 * all.
 */
export function DiaryEntryRow({
  entry,
  onPress,
}: {
  entry: FoodLogRow;
  onPress?: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${entry.food_name}, ${portionOf(entry)}, ${displayEnergy(entry.calories)} calories`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
        backgroundColor: pressed ? theme.colors.surfaceMuted : 'transparent',
      })}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" numberOfLines={1}>
          {entry.food_name}
        </Text>
        <Text variant="caption" color="muted" numberOfLines={1}>
          {[entry.brand_name, portionOf(entry)].filter(Boolean).join(' · ')}
        </Text>
      </View>

      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <Text variant="bodyStrong">{displayEnergy(entry.calories)}</Text>
        <Text variant="caption" color="muted">
          {macroSummary(entry)}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * The portion, as the person chose it.
 *
 * A raw quantity reads "200 g"; a named portion reads "2 × 1 slice (60 g)",
 * because the label alone leaves out the thing that makes it checkable.
 */
export function portionOf(entry: FoodLogRow): string {
  const amount = trim(entry.amount_in_base);

  if (entry.serving_amount === 1 && entry.serving_label === entry.basis_unit) {
    return `${amount} ${entry.basis_unit}`;
  }

  const count = trim(entry.quantity);
  return `${count} × ${entry.serving_label} (${amount} ${entry.basis_unit})`;
}

function macroSummary(entry: FoodLogRow): string {
  return [
    `P ${displayMacro(entry.protein_g)}`,
    `C ${displayMacro(entry.carbohydrates_g)}`,
    `F ${displayMacro(entry.fat_g)}`,
  ].join('  ');
}

/** Drops a trailing `.0` without rounding anything a user typed away. */
function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}
