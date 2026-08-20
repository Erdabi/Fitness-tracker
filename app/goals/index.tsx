import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Card, EmptyState, LoadingState, Screen, Text, TextField } from '@/components/ui';
import type { NutritionGoalRow } from '@/db/schema';
import { formatFullDay } from '@/features/diary/DayNavigator';
import { BelowFloorWarning, EstimateNotice } from '@/features/goals/EstimateNotice';
import { GoalSummary, sourceLabel } from '@/features/goals/GoalSummary';
import {
  useCurrentGoal,
  useGoalHistory,
  useGoalMutations,
} from '@/features/goals/useGoals';
import { asLocalDay } from '@/lib/date';
import { validateCalorieTarget } from '@/lib/bodyInputs';
import { calorieFloorFor, macroTargets, type GoalDirection } from '@/lib/energy';
import { useTheme } from '@/theme';

/**
 * Goal management.
 *
 * Deliberately not a read-only summary with a "recalculate" button. Changing a
 * calorie target by hand is the most common thing anybody wants here, and
 * making that require a walk through five calculator steps would be a tax on
 * the ordinary case.
 */
export default function GoalsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { goal, isLoading, today } = useCurrentGoal();
  const { periods } = useGoalHistory();
  const { setManualGoal } = useGoalMutations();

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  const draftResult = validateCalorieTarget(draft);
  const floor = calorieFloorFor(
    goal?.basis_sex === 'male' ? 'male' : goal?.basis_sex === 'female' ? 'female' : 'unspecified',
    goal?.basis_bmr ?? null,
  );
  const draftBelowFloor = draftResult.ok && draftResult.value < floor;

  function saveManualTarget(): void {
    if (!draftResult.ok) return;

    /*
     * A new period from today, not an edit of the current one. Yesterday's
     * diary keeps yesterday's target — which is the whole reason goals are
     * periods rather than a settings row.
     *
     * The recommendation and basis are carried across, so overriding a
     * calculated goal by hand does not throw away what the app had suggested.
     */
    setManualGoal({
      effectiveFrom: today,
      targets: {
        calorieTarget: draftResult.value,
        macros: macroTargets(
          draftResult.value,
          goal?.basis_weight_kg ?? 75,
          (goal?.basis_direction as GoalDirection) ?? 'maintain',
        ),
      },
      recommendation:
        goal?.calculated_calories != null
          ? {
              calorieTarget: goal.calculated_calories,
              macros: {
                protein_g: goal.calculated_protein_g ?? 0,
                carbohydrates_g: goal.calculated_carbohydrate_g ?? 0,
                fat_g: goal.calculated_fat_g ?? 0,
              },
            }
          : null,
      basis:
        goal?.basis_bmr != null && goal.basis_tdee != null && goal.basis_weight_kg != null
          ? {
              bmr: goal.basis_bmr,
              tdee: goal.basis_tdee,
              activity: goal.basis_activity ?? 'moderate',
              direction: goal.basis_direction ?? 'maintain',
              weightKg: goal.basis_weight_kg,
              heightCm: goal.basis_height_cm,
              ageYears: goal.basis_age_years,
              sex: goal.basis_sex ?? 'other',
            }
          : null,
      acknowledgedBelowFloor: draftBelowFloor,
    });

    setIsEditing(false);
  }

  if (isLoading) return <LoadingState label="Loading your goal" />;

  return (
    <Screen scrollable keyboardAvoiding>
      <View style={{ paddingTop: theme.spacing.lg, gap: theme.spacing.lg }}>
        <Text variant="displayMedium">Your goal</Text>

        {!goal ? (
          <View style={{ paddingVertical: theme.spacing.xl }}>
            <EmptyState
              title="No target set yet"
              description="Work one out from your body and activity, or set a calorie target by hand."
              actionLabel="Open the calculator"
              onAction={() => router.push('/goals/calculator')}
            />
            <View style={{ marginTop: theme.spacing.lg }}>
              <Button
                label="Set a target by hand"
                variant="secondary"
                onPress={() => {
                  setDraft('2000');
                  setIsEditing(true);
                }}
              />
            </View>
          </View>
        ) : (
          <>
            <Card>
              <GoalSummary goal={goal} />
              <Text variant="caption" color="muted">
                In force since {formatFullDay(asLocalDay(goal.effective_from))}.
              </Text>
            </Card>

            {goal.acknowledged_below_floor === 1 ? (
              <BelowFloorWarning floor={floor} />
            ) : null}
          </>
        )}

        {isEditing ? (
          <Card>
            <Text variant="overline" color="secondary">
              New calorie target
            </Text>
            <TextField
              label="Calories per day"
              value={draft}
              onChangeText={setDraft}
              keyboardType="number-pad"
              hint="kcal"
              error={
                draft.length > 0 && !draftResult.ok
                  ? draftResult.errors[0]!.message
                  : undefined
              }
            />

            {draftBelowFloor ? <BelowFloorWarning floor={floor} /> : null}

            <Text variant="caption" color="muted">
              This starts a new period from today. Every earlier day keeps the target it
              had, and macro targets are recalculated to match.
            </Text>

            <Button
              label="Save target"
              disabled={!draftResult.ok}
              onPress={saveManualTarget}
            />
            <Button
              label="Cancel"
              variant="ghost"
              onPress={() => setIsEditing(false)}
            />
          </Card>
        ) : goal ? (
          <View style={{ gap: theme.spacing.sm }}>
            <Button
              label="Change my calorie target"
              variant="secondary"
              onPress={() => {
                setDraft(String(goal.calorie_target));
                setIsEditing(true);
              }}
            />
            <Button
              label="Recalculate from my body"
              variant="secondary"
              onPress={() => router.push('/goals/calculator')}
            />
            <Button
              label={showHistory ? 'Hide previous goals' : 'View previous goals'}
              variant="ghost"
              onPress={() => setShowHistory((shown) => !shown)}
            />
          </View>
        ) : null}

        {showHistory ? <GoalHistory periods={periods} /> : null}

        {goal ? <EstimateNotice compact /> : null}
      </View>
    </Screen>
  );
}

/**
 * Previous periods.
 *
 * Every one of them is still exactly what it was — the list is a record, not a
 * derivation, which is why a goal from March can show a weight the user has
 * not been for months.
 */
function GoalHistory({ periods }: { periods: readonly NutritionGoalRow[] }) {
  const theme = useTheme();

  if (periods.length === 0) {
    return (
      <Text variant="callout" color="muted">
        No previous goals yet.
      </Text>
    );
  }

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="overline" color="secondary">
        Previous goals
      </Text>

      {periods.map((period) => (
        <Card key={period.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong">{describeRange(period)}</Text>
              <Text variant="caption" color="muted">
                {sourceLabel(period)}
              </Text>
            </View>
            <Text variant="title" tabular>
              {period.calorie_target.toLocaleString()}
            </Text>
          </View>

          <Text variant="caption" color="secondary">
            P {Math.round(period.protein_target_g)} g · C{' '}
            {Math.round(period.carbohydrate_target_g)} g · F{' '}
            {Math.round(period.fat_target_g)} g
            {period.calculated_calories !== null &&
            period.calculated_calories !== period.calorie_target
              ? ` · suggested ${period.calculated_calories.toLocaleString()} kcal`
              : ''}
          </Text>

          {period.basis_weight_kg !== null ? (
            <Text variant="caption" color="muted">
              Calculated from {period.basis_weight_kg} kg
              {period.basis_activity ? `, ${period.basis_activity} activity` : ''}
              {period.basis_tdee ? `, ${period.basis_tdee.toLocaleString()} kcal maintenance` : ''}
              .
            </Text>
          ) : null}
        </Card>
      ))}
    </View>
  );
}

function describeRange(period: NutritionGoalRow): string {
  const from = formatFullDay(asLocalDay(period.effective_from));

  if (period.effective_to === null) return `${from} — now`;

  // A period that ends before it starts was superseded on the day it was
  // created, and never governed a single diary day. Saying so beats printing
  // a backwards date range.
  if (period.effective_to < period.effective_from) {
    return `${from} — replaced the same day`;
  }

  return `${from} — ${formatFullDay(asLocalDay(period.effective_to))}`;
}
