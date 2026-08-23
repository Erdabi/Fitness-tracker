import { View } from 'react-native';

import { Card, Skeleton, Text } from '@/components/ui';
import type { DayTotals } from '@/db/repositories/foodLogs';
import type { NutritionGoalRow } from '@/db/schema';
import type { GoalProgress } from '@/lib/energy';
import { displayMacro } from '@/lib/nutrition';
import { useTheme } from '@/theme';
import { ProgressBar } from './ProgressBar';

/**
 * Calories and macros for the day.
 *
 * Every figure is passed in, computed by the diary's own aggregation. The card
 * formats; it does not calculate. A dashboard that did its own arithmetic
 * would eventually disagree with the diary screen, and the diary is the one
 * people would believe.
 */
export function CalorieCard({
  totals,
  goal,
  progress,
  onPress,
}: {
  totals: DayTotals;
  goal: NutritionGoalRow | null;
  progress: GoalProgress | null;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const consumed = Math.round(totals.total.calories);

  /*
   * The percentage is deliberately NOT taken from `progress.fraction`, which
   * is clamped to 1 so a bar cannot overflow its track. Reporting "100%" to
   * somebody who is at 107% would hide exactly the fact this card is supposed
   * to surface.
   */
  const percent = goal ? Math.round((consumed / goal.calorie_target) * 100) : null;

  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text variant="overline" color="secondary">
          Calories
        </Text>
        {percent !== null ? (
          <Text
            variant="caption"
            color={progress?.isOver ? 'warning' : 'muted'}
            tabular
          >
            {percent}%
          </Text>
        ) : null}
      </View>

      {totals.entryCount === 0 ? (
        <Text variant="body" color="secondary">
          No food logged yet today.
        </Text>
      ) : null}

      <View
        style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}
        accessible
        accessibilityLabel={describe(consumed, goal, progress)}
      >
        {/*
          Nested Text composes visually but reads as fragments, so the whole
          figure is given one spoken label above rather than being announced as
          "1,620" "/" "2,100" "kcal".
        */}
        <Text variant="displayMedium" tabular>
          {consumed.toLocaleString()}
          {goal ? (
            <Text variant="title" color="muted">
              {' / '}
              {goal.calorie_target.toLocaleString()}
            </Text>
          ) : null}
          <Text variant="caption" color="muted"> kcal</Text>
        </Text>

        {progress ? (
          <View style={{ alignItems: 'flex-end' }}>
            <Text
              variant="bodyStrong"
              color={progress.isOver ? 'warning' : 'primary'}
              tabular
            >
              {Math.round(progress.isOver ? progress.overBy : progress.remaining).toLocaleString()}
            </Text>
            <Text variant="overline" color="muted">
              {progress.isOver ? 'over' : 'remaining'}
            </Text>
          </View>
        ) : null}
      </View>

      {progress ? (
        <ProgressBar
          fraction={progress.fraction}
          isOver={progress.isOver}
          label={`${consumed} of ${goal?.calorie_target} calories`}
        />
      ) : (
        <Text
          variant="caption"
          color="accent"
          onPress={onPress}
          accessibilityRole="button"
        >
          Set a calorie goal to track against →
        </Text>
      )}

      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          gap: theme.spacing.md,
          paddingTop: theme.spacing.xs,
        }}
      >
        <Macro
          label="Protein"
          consumed={totals.total.protein_g}
          target={goal?.protein_target_g}
        />
        <Macro
          label="Carbs"
          consumed={totals.total.carbohydrates_g}
          target={goal?.carbohydrate_target_g}
        />
        <Macro label="Fat" consumed={totals.total.fat_g} target={goal?.fat_target_g} />
      </View>
    </Card>
  );
}

/** The headline as a sentence, for anyone not reading the layout. */
function describe(
  consumed: number,
  goal: NutritionGoalRow | null,
  progress: GoalProgress | null,
): string {
  if (!goal || !progress) return `${consumed.toLocaleString()} calories today, no goal set.`;

  return progress.isOver
    ? `${consumed.toLocaleString()} of ${goal.calorie_target.toLocaleString()} calories, ${Math.round(progress.overBy).toLocaleString()} over.`
    : `${consumed.toLocaleString()} of ${goal.calorie_target.toLocaleString()} calories, ${Math.round(progress.remaining).toLocaleString()} remaining.`;
}

function Macro({
  label,
  consumed,
  target,
}: {
  label: string;
  consumed: number | null;
  target?: number;
}) {
  const theme = useTheme();
  const shown = consumed === null ? null : displayMacro(consumed);
  const fraction =
    target && target > 0 && consumed !== null
      ? Math.min(1, Math.max(0, consumed / target))
      : 0;

  return (
    <View
      style={{ flex: 1, gap: 4 }}
      accessible
      accessibilityLabel={
        target
          ? `${label}, ${shown ?? 0} of ${Math.round(target)} grams`
          : `${label}, ${shown ?? 0} grams, no target set`
      }
    >
      <Text variant="bodyStrong" tabular>
        {shown ?? '—'}
        {target !== undefined ? (
          <Text variant="caption" color="muted">
            {' / '}
            {Math.round(target)}
          </Text>
        ) : null}
        <Text variant="caption" color="muted"> g</Text>
      </Text>

      {target !== undefined ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            height: 3,
            borderRadius: 2,
            backgroundColor: theme.colors.surfaceMuted,
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              width: `${Math.round(fraction * 100)}%`,
              height: '100%',
              backgroundColor: theme.colors.accent,
            }}
          />
        </View>
      ) : null}

      <Text variant="overline" color="muted">
        {label}
      </Text>
    </View>
  );
}

/** Matches the card's shape, so the page does not jump when data lands. */
export function CalorieCardSkeleton() {
  const theme = useTheme();
  return (
    <Card>
      <Skeleton height={11} width="30%" />
      <Skeleton height={34} width="60%" />
      <Skeleton height={4} />
      <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
        <Skeleton height={16} width="30%" />
        <Skeleton height={16} width="30%" />
        <Skeleton height={16} width="30%" />
      </View>
    </Card>
  );
}
