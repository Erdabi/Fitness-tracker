import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { Button, Card, Skeleton, Text, TextField } from '@/components/ui';
import type { WaterDay } from '@/db/repositories/water';
import { QUICK_ADD_ML, describeWaterProgress, formatWater, formatWaterAgainstTarget } from '@/lib/water';
import type { UnitSystem } from '@/lib/units';
import { useTheme } from '@/theme';
import { ProgressBar } from './ProgressBar';

/**
 * Water, with the quick-add row.
 *
 * The buttons differ by the number they pass to `onAdd` and by nothing else —
 * there is one logging service behind all of them, including the custom
 * amount. Adding a fifth preset is a change to `QUICK_ADD_ML`, not to this
 * file.
 */
export function WaterCard({
  water,
  system,
  onAdd,
  onSetGoal,
  onOpenHistory,
}: {
  water: WaterDay;
  system: UnitSystem;
  onAdd: (amountMl: number) => void;
  onSetGoal?: () => void;
  onOpenHistory?: () => void;
}) {
  const theme = useTheme();
  const [isCustom, setIsCustom] = useState(false);
  const [custom, setCustom] = useState('');

  const customMl = Number(custom.replace(',', '.'));
  const customIsValid = Number.isFinite(customMl) && customMl > 0 && customMl <= 5000;

  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text variant="overline" color="secondary">
          Water
        </Text>
        {onOpenHistory ? (
          <Text
            variant="caption"
            color="accent"
            onPress={onOpenHistory}
            accessibilityRole="button"
            accessibilityLabel="View water history"
          >
            History
          </Text>
        ) : null}
      </View>

      {water.entryCount === 0 ? (
        <Text variant="body" color="secondary">
          No water logged yet today.
        </Text>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <Text variant="displayMedium" tabular>
          {water.targetMl === null
            ? formatWater(water.consumedMl, system)
            : formatWaterAgainstTarget(water.consumedMl, water.targetMl, system)}
        </Text>
      </View>

      {water.progress ? (
        <>
          <ProgressBar
            fraction={water.progress.fraction}
            isOver={water.progress.isOver}
            label={`${formatWater(water.consumedMl, system)} of ${formatWater(
              water.targetMl ?? 0,
              system,
            )}`}
          />
          {/* The same fact as text, so the bar is never the only way to read it. */}
          <Text
            variant="caption"
            color={water.progress.isOver ? 'warning' : 'secondary'}
          >
            {describeWaterProgress(water.progress, system)}
          </Text>
        </>
      ) : (
        <Text
          variant="caption"
          color="accent"
          onPress={onSetGoal}
          accessibilityRole="button"
        >
          Set a daily water goal →
        </Text>
      )}

      <View style={{ flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
        {QUICK_ADD_ML.map((amount) => (
          <QuickAdd
            key={amount}
            amountMl={amount}
            system={system}
            onPress={() => onAdd(amount)}
          />
        ))}
      </View>

      {isCustom ? (
        <View style={{ gap: theme.spacing.sm }}>
          <TextField
            label="Custom amount"
            value={custom}
            onChangeText={setCustom}
            keyboardType="number-pad"
            hint="ml"
            error={
              custom.length > 0 && !customIsValid
                ? 'Enter an amount between 1 and 5000 ml.'
                : undefined
            }
          />
          <Button
            label="Add"
            disabled={!customIsValid}
            onPress={() => {
              if (!customIsValid) return;
              onAdd(Math.round(customMl));
              setCustom('');
              setIsCustom(false);
            }}
          />
          <Button label="Cancel" variant="ghost" onPress={() => setIsCustom(false)} />
        </View>
      ) : (
        <Text
          variant="caption"
          color="accent"
          onPress={() => setIsCustom(true)}
          accessibilityRole="button"
          accessibilityLabel="Add a custom water amount"
        >
          Custom amount
        </Text>
      )}
    </Card>
  );
}

function QuickAdd({
  amountMl,
  system,
  onPress,
}: {
  amountMl: number;
  system: UnitSystem;
  onPress: () => void;
}) {
  const theme = useTheme();
  const label = formatWater(amountMl, system);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Add ${label} of water`}
      // 44pt is the smallest reliably tappable target; these are pressed
      // several times a day, often one-handed.
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
        +{label}
      </Text>
    </Pressable>
  );
}

export function WaterCardSkeleton() {
  const theme = useTheme();
  return (
    <Card>
      <Skeleton height={11} width="25%" />
      <Skeleton height={34} width="50%" />
      <Skeleton height={6} />
      <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
        <Skeleton height={44} width="22%" radius={22} />
        <Skeleton height={44} width="22%" radius={22} />
        <Skeleton height={44} width="22%" radius={22} />
      </View>
    </Card>
  );
}
