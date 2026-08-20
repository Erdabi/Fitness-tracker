import { View } from 'react-native';

import { Text } from '@/components/ui';
import type { NutritionGoalRow } from '@/db/schema';
import { goalProgress } from '@/lib/energy';
import { displayEnergy, displayMacro, type ScaledNutrition } from '@/lib/nutrition';
import { useTheme } from '@/theme';

/**
 * The day's running totals, against the goal that was in force that day.
 *
 * Two rules matter here and are easy to get wrong:
 *
 *   • The goal comes from the diary's OWN date, resolved through the goal
 *     periods — never from today's target. A diary page for 5 August shows
 *     what was being aimed at on 5 August.
 *
 *   • Going over the target is reported as an overage, not as a negative
 *     remaining figure. "−240 remaining" reads as an allowance; "240 over"
 *     reads as what happened.
 */
export function DayTotalsBar({
  totals,
  goal,
}: {
  totals: ScaledNutrition;
  goal: NutritionGoalRow | null;
}) {
  const theme = useTheme();
  const progress = goal ? goalProgress(totals.calories, goal.calorie_target) : null;

  return (
    <View
      style={{
        paddingVertical: theme.spacing.md,
        gap: theme.spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <View>
          <Text variant="displayMedium" tabular>
            {displayEnergy(totals.calories)}
            {goal ? (
              <Text variant="title" color="muted">
                {' / '}
                {goal.calorie_target.toLocaleString()}
              </Text>
            ) : null}
          </Text>
          <Text variant="overline" color="muted">
            kcal
          </Text>
        </View>

        {progress ? (
          <View style={{ alignItems: 'flex-end' }}>
            <Text
              variant="bodyStrong"
              color={progress.isOver ? 'warning' : 'primary'}
              tabular
            >
              {progress.isOver
                ? `${Math.round(progress.overBy).toLocaleString()}`
                : `${Math.round(progress.remaining).toLocaleString()}`}
            </Text>
            <Text variant="overline" color="muted">
              {progress.isOver ? 'over' : 'remaining'}
            </Text>
          </View>
        ) : null}
      </View>

      {progress ? <ProgressBar progress={progress.fraction} isOver={progress.isOver} /> : null}

      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Macro label="Protein" grams={totals.protein_g} target={goal?.protein_target_g} />
        <Macro
          label="Carbs"
          grams={totals.carbohydrates_g}
          target={goal?.carbohydrate_target_g}
        />
        <Macro label="Fat" grams={totals.fat_g} target={goal?.fat_target_g} />
      </View>
    </View>
  );
}

function ProgressBar({ progress, isOver }: { progress: number; isOver: boolean }) {
  const theme = useTheme();

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        height: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.surfaceMuted,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          width: `${Math.round(progress * 100)}%`,
          height: '100%',
          // Full and amber rather than overflowing: a bar cannot render past
          // its own end, so the colour is what carries "over".
          backgroundColor: isOver ? theme.colors.warning : theme.colors.accent,
        }}
      />
    </View>
  );
}

function Macro({
  label,
  grams,
  target,
}: {
  label: string;
  grams: number | null;
  target?: number;
}) {
  const consumed = grams === null ? '—' : displayMacro(grams);

  return (
    <View>
      <Text variant="bodyStrong" tabular>
        {consumed}
        {target !== undefined ? (
          <Text variant="caption" color="muted">
            {' / '}
            {Math.round(target)}
          </Text>
        ) : null}
        <Text variant="caption" color="muted"> g</Text>
      </Text>
      <Text variant="overline" color="muted">
        {label}
      </Text>
    </View>
  );
}
