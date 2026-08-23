import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';

import {
  Button,
  Card,
  EmptyState,
  LoadingState,
  Screen,
  Text,
  TextField,
} from '@/components/ui';
import type { WaterLogRow } from '@/db/schema';
import {
  DayNavigator,
  describeDay,
  formatFullDay,
} from '@/features/diary/DayNavigator';
import {
  useSuggestedWaterTarget,
  useWaterDay,
  useWaterEntries,
  useWaterHistory,
  useWaterMutations,
} from '@/features/water/useWater';
import { useDiaryTimeZone } from '@/features/diary/useDiary';
import { asLocalDay, todayIn, type LocalDay } from '@/lib/date';
import { useProfile } from '@/features/profile/useProfile';
import { describeWaterProgress, formatWater, formatWaterAgainstTarget } from '@/lib/water';
import { useTheme } from '@/theme';

/**
 * Water for a day, plus the week behind it.
 *
 * Each day in the weekly strip is measured against the goal that applied on
 * that day, not today's — which is what makes "4 of 7 days met" a fact about
 * the week rather than about the target the user happens to hold now.
 */
export default function WaterScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { profile } = useProfile();
  const timeZone = useDiaryTimeZone();
  const today = todayIn(timeZone);
  const [day, setDay] = useState<LocalDay>(today);

  const system = profile?.unit_system ?? 'metric';
  const { day: summary, isLoading } = useWaterDay(day);
  const { entries } = useWaterEntries(day);
  const { days: week, summary: weekly } = useWaterHistory(7, today);
  const { addWater, updateWater, removeWater, setWaterGoal } = useWaterMutations();
  const { targetMl: suggestedMl, weightKg } = useSuggestedWaterTarget();

  const [goalDraft, setGoalDraft] = useState('');
  const [isEditingGoal, setIsEditingGoal] = useState(false);
  const draftMl = Number(goalDraft.replace(',', '.'));
  const draftValid = Number.isFinite(draftMl) && draftMl >= 500 && draftMl <= 10_000;

  if (isLoading || !summary) return <LoadingState label="Loading water" />;

  return (
    <Screen scrollable keyboardAvoiding>
      <View style={{ paddingTop: theme.spacing.md, gap: theme.spacing.md }}>
        <DayNavigator day={day} today={today} onChange={setDay} />
      </View>

      <Card>
        <Text variant="overline" color="secondary">
          {describeDay(day, today)}
        </Text>
        <Text variant="displayMedium" tabular>
          {summary.targetMl === null
            ? formatWater(summary.consumedMl, system)
            : formatWaterAgainstTarget(summary.consumedMl, summary.targetMl, system)}
        </Text>
        {summary.progress ? (
          <Text
            variant="callout"
            color={summary.progress.isOver ? 'warning' : 'secondary'}
          >
            {describeWaterProgress(summary.progress, system)}
          </Text>
        ) : (
          <Text variant="caption" color="muted">
            No goal was set for this day.
          </Text>
        )}

        {day === today ? (
          <View style={{ flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
            {[250, 500, 750, 1000].map((amount) => (
              <Pressable
                key={amount}
                onPress={() => addWater(amount, { day })}
                accessibilityRole="button"
                accessibilityLabel={`Add ${formatWater(amount, system)} of water`}
                style={({ pressed }) => ({
                  minHeight: 44,
                  minWidth: 76,
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingHorizontal: theme.spacing.md,
                  borderRadius: theme.radius.pill,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  backgroundColor: pressed ? theme.colors.accentMuted : theme.colors.surface,
                })}
              >
                <Text variant="callout" color="accent">
                  +{formatWater(amount, system)}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </Card>

      {/* ------------------------------------------------------------ goal */}

      <Card>
        <Text variant="overline" color="secondary">
          Daily goal
        </Text>

        {isEditingGoal ? (
          <>
            <TextField
              label="Target"
              value={goalDraft}
              onChangeText={setGoalDraft}
              keyboardType="number-pad"
              hint="ml per day"
              error={
                goalDraft.length > 0 && !draftValid
                  ? 'Enter a target between 500 and 10000 ml.'
                  : undefined
              }
            />
            <Text variant="caption" color="muted">
              {weightKg === null
                ? `Suggested: ${formatWater(suggestedMl, system)} a day.`
                : `Suggested from your ${weightKg} kg: ${formatWater(suggestedMl, system)} a day.`}{' '}
              A rough starting point, not a medical recommendation — adjust it to
              suit your climate, activity and how you actually feel.
            </Text>
            <Text variant="caption" color="muted">
              This starts a new goal from today. Earlier days keep the target they
              were measured against.
            </Text>
            <Button
              label="Save goal"
              disabled={!draftValid}
              onPress={() => {
                setWaterGoal({
                  targetMl: Math.round(draftMl),
                  recommendedMl: suggestedMl,
                  weightKg,
                });
                setIsEditingGoal(false);
              }}
            />
            <Button label="Cancel" variant="ghost" onPress={() => setIsEditingGoal(false)} />
          </>
        ) : (
          <>
            <Text variant="body">
              {summary.targetMl === null
                ? 'Not set'
                : `${formatWater(summary.targetMl, system)} a day`}
            </Text>
            <Button
              label={summary.targetMl === null ? 'Set a goal' : 'Change goal'}
              variant="secondary"
              onPress={() => {
                setGoalDraft(String(summary.targetMl ?? suggestedMl));
                setIsEditingGoal(true);
              }}
            />
          </>
        )}
      </Card>

      {/* --------------------------------------------------------- entries */}

      <Card flush>
        <Text
          variant="overline"
          color="secondary"
          style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.lg }}
        >
          Entries
        </Text>

        {entries.length === 0 ? (
          <View style={{ paddingVertical: theme.spacing.lg }}>
            <EmptyState
              title="No water logged"
              description={
                day === today
                  ? 'Use the quick-add buttons above.'
                  : 'Nothing was recorded on this day.'
              }
            />
          </View>
        ) : (
          entries.map((entry) => (
            <WaterEntryRow
              key={entry.id}
              entry={entry}
              system={system}
              timeZone={timeZone}
              onEdit={(ml) => updateWater(entry.id, ml)}
              onDelete={() => removeWater(entry.id)}
            />
          ))
        )}
      </Card>

      {/* ------------------------------------------------------------ week */}

      <Card>
        <Text variant="overline" color="secondary">
          Last 7 days
        </Text>

        {/*
          The chart is never the only way to read this. The sentence below
          carries the same facts, and each bar has its own label.
        */}
        <Text variant="body">
          {weekly.daysLogged === 0
            ? 'Nothing logged this week yet.'
            : `${formatWater(weekly.averageMl, system)} a day on average, and the goal was met on ${weekly.daysGoalMet} of ${weekly.daysInRange} days.`}
        </Text>

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-end',
            gap: theme.spacing.sm,
            height: 72,
          }}
        >
          {week.map((entry) => {
            const fraction = entry.targetMl
              ? Math.min(1, entry.consumedMl / entry.targetMl)
              : 0;
            const met = entry.targetMl !== null && entry.consumedMl >= entry.targetMl;

            return (
              <View
                key={entry.day}
                accessible
                accessibilityLabel={`${formatFullDay(asLocalDay(entry.day))}: ${formatWater(
                  entry.consumedMl,
                  system,
                )}${entry.targetMl ? ` of ${formatWater(entry.targetMl, system)}` : ''}`}
                style={{ flex: 1, alignItems: 'center', gap: 4 }}
              >
                <View
                  style={{
                    width: '100%',
                    height: Math.max(3, fraction * 56),
                    borderRadius: 3,
                    backgroundColor: met ? theme.colors.success : theme.colors.accent,
                    opacity: entry.consumedMl === 0 ? 0.2 : 1,
                  }}
                />
                <Text variant="overline" color="muted">
                  {entry.day.slice(8)}
                </Text>
              </View>
            );
          })}
        </View>
      </Card>

      <Button label="Back" variant="ghost" onPress={() => router.back()} />
    </Screen>
  );
}

function WaterEntryRow({
  entry,
  system,
  timeZone,
  onEdit,
  onDelete,
}: {
  entry: WaterLogRow;
  system: 'metric' | 'imperial';
  timeZone: string;
  onEdit: (amountMl: number) => void;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(String(entry.amount_ml));

  const draftMl = Number(draft.replace(',', '.'));
  const valid = Number.isFinite(draftMl) && draftMl > 0 && draftMl <= 5000;

  const time = new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(entry.consumed_at));

  if (isEditing) {
    return (
      <View style={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}>
        <TextField
          label="Amount"
          value={draft}
          onChangeText={setDraft}
          keyboardType="number-pad"
          hint="ml"
        />
        <Button
          label="Save"
          disabled={!valid}
          onPress={() => {
            onEdit(Math.round(draftMl));
            setIsEditing(false);
          }}
        />
        <Button label="Cancel" variant="ghost" onPress={() => setIsEditing(false)} />
      </View>
    );
  }

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text variant="body">{formatWater(entry.amount_ml, system)}</Text>
        <Text variant="caption" color="muted">
          {time}
        </Text>
      </View>

      <Pressable
        onPress={() => setIsEditing(true)}
        accessibilityRole="button"
        accessibilityLabel={`Edit water entry of ${formatWater(entry.amount_ml, system)}`}
        hitSlop={8}
        style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        <Text variant="caption" color="accent">
          Edit
        </Text>
      </Pressable>

      <Pressable
        onPress={() =>
          Alert.alert('Remove this entry?', `${formatWater(entry.amount_ml, system)} at ${time}.`, [
            { text: 'Keep it', style: 'cancel' },
            { text: 'Remove', style: 'destructive', onPress: onDelete },
          ])
        }
        accessibilityRole="button"
        accessibilityLabel={`Delete water entry of ${formatWater(entry.amount_ml, system)}`}
        hitSlop={8}
        style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        <Text variant="caption" color="danger">
          Delete
        </Text>
      </Pressable>
    </View>
  );
}
