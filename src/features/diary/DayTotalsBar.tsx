import { View } from 'react-native';

import { Text } from '@/components/ui';
import { displayEnergy, displayMacro, type ScaledNutrition } from '@/lib/nutrition';
import { useTheme } from '@/theme';

/**
 * The day's running totals.
 *
 * Summed from the entries' own snapshots, so the figure is the sum of what is
 * on screen — a total that disagreed with the rows above it would be the
 * fastest way to lose a user's trust in every other number in the app.
 *
 * No goal ring or remaining-calories figure yet: targets arrive with the
 * calorie calculator, and inventing one here would mean showing somebody a
 * budget nobody set.
 */
export function DayTotalsBar({ totals }: { totals: ScaledNutrition }) {
  const theme = useTheme();

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        paddingVertical: theme.spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <View>
        <Text variant="displayMedium">{displayEnergy(totals.calories)}</Text>
        <Text variant="overline" color="muted">
          kcal today
        </Text>
      </View>

      <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
        <Macro label="Protein" grams={totals.protein_g} />
        <Macro label="Carbs" grams={totals.carbohydrates_g} />
        <Macro label="Fat" grams={totals.fat_g} />
      </View>
    </View>
  );
}

function Macro({ label, grams }: { label: string; grams: number | null }) {
  return (
    <View style={{ alignItems: 'flex-end' }}>
      <Text variant="bodyStrong">{grams === null ? '—' : `${displayMacro(grams)} g`}</Text>
      <Text variant="overline" color="muted">
        {label}
      </Text>
    </View>
  );
}
