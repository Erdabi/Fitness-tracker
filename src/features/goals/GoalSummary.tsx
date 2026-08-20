import { View } from 'react-native';

import { Text } from '@/components/ui';
import type { NutritionGoalRow } from '@/db/schema';
import { macroCalories } from '@/lib/energy';
import { useTheme } from '@/theme';

/**
 * A goal's targets, with the recommendation shown beside them when the two
 * differ.
 *
 * The spec's distinction made visible: estimated maintenance, the app's
 * recommendation, and the target actually in force are three different facts,
 * and a screen that showed only the last one would be quietly claiming the
 * app had suggested it.
 */
export function GoalSummary({
  goal,
  showBasis = true,
}: {
  goal: NutritionGoalRow;
  showBasis?: boolean;
}) {
  const theme = useTheme();
  const overridden =
    goal.calculated_calories !== null && goal.calculated_calories !== goal.calorie_target;

  return (
    <View style={{ gap: theme.spacing.md }}>
      {showBasis && goal.basis_tdee !== null ? (
        <Line
          label="Estimated maintenance"
          value={`${goal.basis_tdee.toLocaleString()} kcal`}
          tone="secondary"
        />
      ) : null}

      {goal.calculated_calories !== null ? (
        <Line
          label={overridden ? 'Suggested target' : 'Suggested and chosen'}
          value={`${goal.calculated_calories.toLocaleString()} kcal`}
          tone="secondary"
        />
      ) : null}

      <View
        style={{
          paddingTop: theme.spacing.sm,
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
        }}
      >
        <Text variant="overline" color="muted">
          {sourceLabel(goal)}
        </Text>
        <Text variant="displayMedium">
          {goal.calorie_target.toLocaleString()}
          <Text variant="caption" color="muted">
            {' '}
            kcal
          </Text>
        </Text>
      </View>

      <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
        <Macro label="Protein" grams={goal.protein_target_g} />
        <Macro label="Carbs" grams={goal.carbohydrate_target_g} />
        <Macro label="Fat" grams={goal.fat_target_g} />
      </View>

      <Text variant="caption" color="muted">
        {macroNote(goal)}
      </Text>
    </View>
  );
}

function Line({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'primary' | 'secondary';
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text variant="callout" color={tone === 'secondary' ? 'secondary' : 'primary'}>
        {label}
      </Text>
      <Text variant="callout" color={tone === 'secondary' ? 'secondary' : 'primary'} tabular>
        {value}
      </Text>
    </View>
  );
}

function Macro({ label, grams }: { label: string; grams: number }) {
  return (
    <View>
      <Text variant="bodyStrong" tabular>
        {Math.round(grams)} g
      </Text>
      <Text variant="overline" color="muted">
        {label}
      </Text>
    </View>
  );
}

export function sourceLabel(goal: NutritionGoalRow): string {
  switch (goal.source) {
    case 'calculated':
      return 'Your target · from the calculator';
    case 'calculated_then_modified':
      return 'Your target · adjusted by you';
    default:
      return 'Your target · set by you';
  }
}

/**
 * States the reconciliation rather than hiding it.
 *
 * Three whole-gram figures cannot always hit a multiple of ten exactly, so the
 * macros land within a couple of calories of the target. Saying so is better
 * than letting somebody add them up and wonder which number is wrong.
 */
function macroNote(goal: NutritionGoalRow): string {
  const total = macroCalories({
    protein_g: goal.protein_target_g,
    carbohydrates_g: goal.carbohydrate_target_g,
    fat_g: goal.fat_target_g,
  });
  const gap = Math.round(total - goal.calorie_target);

  if (Math.abs(gap) <= 2) {
    return 'Macro targets are recommendations, and add up to the calorie target.';
  }

  return `Macro targets are recommendations. They add up to ${Math.round(
    total,
  ).toLocaleString()} kcal, ${Math.abs(gap)} ${gap > 0 ? 'above' : 'below'} the target.`;
}
