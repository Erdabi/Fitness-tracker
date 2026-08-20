import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { EmptyState, LoadingState, Screen, Text } from '@/components/ui';
import { MEAL_SLOTS, type FoodLogRow, type MealSlot } from '@/db/schema';
import { DayNavigator } from '@/features/diary/DayNavigator';
import { DayTotalsBar } from '@/features/diary/DayTotalsBar';
import { FrequentStrip } from '@/features/diary/FrequentStrip';
import { defaultMealFor } from '@/features/diary/MealPicker';
import { MealSection } from '@/features/diary/MealSection';
import { SyncNotice } from '@/features/diary/SyncNotice';
import { useGoalForDate } from '@/features/goals/useGoals';
import {
  useDiaryDay,
  useDiaryMutations,
  useDiaryTimeZone,
  useFrequentFoods,
  useToday,
} from '@/features/diary/useDiary';
import { useSyncStatus } from '@/sync/useSyncStatus';
import type { LocalDay } from '@/lib/date';
import { useTheme } from '@/theme';

/**
 * The day view.
 *
 * Reads entirely from SQLite, so it renders instantly and works with the radio
 * off. What sync is doing appears as a note rather than a blocker — an entry
 * is in the diary the moment it is written, whatever the network is doing.
 */
export default function DiaryScreen() {
  const theme = useTheme();
  const router = useRouter();
  const today = useToday();
  const [day, setDay] = useState<LocalDay>(today);

  const { entries, totals, isLoading } = useDiaryDay(day);
  const { foods: frequent } = useFrequentFoods();
  // Resolved for the day being viewed, not for today — a page for 5 August
  // must show what was being aimed at on 5 August.
  const { goal } = useGoalForDate(day);
  const { repeatEntry } = useDiaryMutations();
  const timeZone = useDiaryTimeZone();
  const syncStatus = useSyncStatus();

  function addTo(meal: MealSlot): void {
    router.push({ pathname: '/food/search', params: { meal, day } });
  }

  function open(entry: FoodLogRow): void {
    router.push({ pathname: '/diary/[id]', params: { id: entry.id } });
  }

  return (
    <Screen scrollable>
      <View style={{ gap: theme.spacing.md, paddingTop: theme.spacing.md }}>
        <DayNavigator day={day} today={today} onChange={setDay} />
        <SyncNotice status={syncStatus} />
      </View>

      {isLoading || !totals ? (
        <LoadingState label="Opening your diary" />
      ) : (
        <>
          <DayTotalsBar totals={totals.total} goal={goal} />

          {!goal ? (
            <Pressable
              onPress={() => router.push('/goals')}
              accessibilityRole="button"
              style={{ paddingVertical: theme.spacing.sm }}
            >
              <Text variant="caption" color="accent">
                Set a calorie goal to see how a day compares →
              </Text>
            </Pressable>
          ) : null}

          {totals.entryCount === 0 ? (
            /*
             * An empty day still shows its meals below, so this is a nudge
             * rather than a dead end — the four "Add …" rows underneath are
             * the actual way in.
             */
            <View style={{ paddingVertical: theme.spacing.lg }}>
              <EmptyState
                title={day === today ? 'Nothing logged yet today' : 'Nothing logged'}
                description="Add your first item to any meal below."
                actionLabel="Search foods"
                onAction={() => addTo('breakfast')}
              />
            </View>
          ) : null}

          <View style={{ paddingTop: theme.spacing.lg }}>
            <FrequentStrip
              foods={frequent}
              onRepeat={(food) =>
                repeatEntry(food.lastLogId, {
                  diaryDate: day,
                  // The day being viewed decides the date; the clock decides
                  // the meal, which is right for today and a reasonable guess
                  // for a day being filled in after the fact.
                  meal: defaultMealFor(new Date(), timeZone),
                })
              }
            />
          </View>

          <View style={{ gap: theme.spacing.md, paddingTop: theme.spacing.md }}>
            {MEAL_SLOTS.map((meal) => (
              <MealSection
                key={meal}
                meal={meal}
                entries={entries.filter((entry) => entry.meal === meal)}
                subtotal={totals.byMeal[meal].total}
                onAdd={() => addTo(meal)}
                onSelectEntry={open}
              />
            ))}
          </View>

          <Text
            variant="caption"
            color="muted"
            align="center"
            style={{ paddingVertical: theme.spacing.xl }}
          >
            {goal
              ? 'Totals are the sum of what you logged, against the goal in force that day.'
              : 'Totals are the sum of what you logged, in your own timezone.'}
          </Text>
        </>
      )}
    </Screen>
  );
}
