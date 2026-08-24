import { useEffect, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { Text } from '@/components/ui';
import type { LoadTypeValue } from '@/db/schema';
import type { WorkoutSet } from '@/db/repositories/workouts';
import {
  describeSet,
  fromCanonicalKg,
  toCanonicalKg,
  validateSet,
  type WeightUnit,
} from '@/lib/training';
import { MIN_TOUCH_TARGET, useTheme } from '@/theme';

/**
 * One set, editable in place.
 *
 * This is the control the whole feature is judged on, and it is used standing
 * up, mid-set, with one hand, sometimes with chalk on it. Three decisions
 * follow from that:
 *
 *   • **The tick is the largest target on the row.** Marking a set done is the
 *     commonest action by a wide margin and the one most often done in a
 *     hurry, so it gets a full-height 56 pt target on the edge of the row
 *     rather than a small checkbox in the middle.
 *
 *   • **Fields commit on blur, not on every keystroke.** Writing per keystroke
 *     would queue a sync entry for "7" on the way to "70" and flood the outbox
 *     with rows nobody typed.
 *
 *   • **Nothing is cleared when it is wrong.** An invalid entry keeps what the
 *     user typed and says what is wrong beneath it; wiping the field is how a
 *     mistyped rep count becomes a lost set.
 */
export function SetRow({
  set,
  loadType,
  unit,
  previousLabel,
  onChange,
  onToggle,
  onDelete,
}: {
  set: WorkoutSet;
  loadType: LoadTypeValue;
  /** The unit to show. Storage is always kilograms. */
  unit: WeightUnit;
  /** What was done last time in this slot, offered as a one-tap fill. */
  previousLabel?: string | null;
  onChange: (patch: {
    weightKg?: number | null;
    reps?: number | null;
    durationSeconds?: number | null;
    distanceM?: number | null;
  }) => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const theme = useTheme();

  const showsWeight = loadType === 'weighted' || loadType === 'bodyweight';
  const showsReps = loadType === 'weighted' || loadType === 'bodyweight';
  const showsDuration = loadType === 'duration';
  const showsDistance = loadType === 'distance';

  const [weightText, setWeightText] = useState(() =>
    set.weightKg === null ? '' : String(fromCanonicalKg(set.weightKg, unit)),
  );
  const [repsText, setRepsText] = useState(() =>
    set.reps === null ? '' : String(set.reps),
  );
  const [durationText, setDurationText] = useState(() =>
    set.durationSeconds === null ? '' : String(set.durationSeconds),
  );
  const [distanceText, setDistanceText] = useState(() =>
    set.distanceM === null ? '' : String(set.distanceM),
  );

  /*
   * Re-seed when the row is replaced by a sync or an edit made elsewhere.
   * Keyed on the stored values, so a pull that changes nothing leaves whatever
   * the user is halfway through typing alone.
   */
  useEffect(() => {
    setWeightText(set.weightKg === null ? '' : String(fromCanonicalKg(set.weightKg, unit)));
  }, [set.weightKg, unit]);
  useEffect(() => {
    setRepsText(set.reps === null ? '' : String(set.reps));
  }, [set.reps]);

  const problems = validateSet(
    {
      weightKg: set.weightKg,
      reps: set.reps,
      durationSeconds: set.durationSeconds,
      distanceM: set.distanceM,
      setNumber: set.setNumber,
      isCompleted: set.isCompleted,
    },
    loadType,
  );

  const parse = (text: string): number | null => {
    const trimmed = text.trim().replace(',', '.');
    if (trimmed === '') return null;
    const value = Number(trimmed);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };

  const commitWeight = () => {
    const value = parse(weightText);
    onChange({ weightKg: value === null ? null : toCanonicalKg(value, unit) });
  };

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
          opacity: set.isCompleted ? 1 : 0.75,
        }}
      >
        <Text
          variant="callout"
          color="secondary"
          style={{ width: 28 }}
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          {set.setNumber}
        </Text>

        {showsWeight ? (
          <Field
            label={`Set ${set.setNumber} weight in ${unit === 'kg' ? 'kilograms' : 'pounds'}`}
            suffix={unit}
            value={weightText}
            placeholder={loadType === 'bodyweight' ? '0' : '—'}
            onChangeText={setWeightText}
            onBlur={commitWeight}
          />
        ) : null}

        {showsReps ? (
          <Field
            label={`Set ${set.setNumber} reps`}
            suffix="reps"
            value={repsText}
            onChangeText={setRepsText}
            onBlur={() => onChange({ reps: parse(repsText) })}
          />
        ) : null}

        {showsDuration ? (
          <Field
            label={`Set ${set.setNumber} duration in seconds`}
            suffix="sec"
            value={durationText}
            onChangeText={setDurationText}
            onBlur={() => onChange({ durationSeconds: parse(durationText) })}
          />
        ) : null}

        {showsDistance ? (
          <Field
            label={`Set ${set.setNumber} distance in metres`}
            suffix="m"
            value={distanceText}
            onChangeText={setDistanceText}
            onBlur={() => onChange({ distanceM: parse(distanceText) })}
          />
        ) : null}

        {/*
          The primary action. Full-height and on the edge so it is reachable
          with a thumb without looking, and labelled with the whole set so a
          screen reader announces what is being ticked rather than just "done".
        */}
        <Pressable
          onPress={onToggle}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: set.isCompleted }}
          accessibilityLabel={`Set ${set.setNumber}: ${describeSet(set, loadType, unit)}`}
          accessibilityHint={
            set.isCompleted ? 'Marks this set as not done' : 'Marks this set as done'
          }
          style={({ pressed }) => ({
            minWidth: MIN_TOUCH_TARGET + 12,
            minHeight: MIN_TOUCH_TARGET + 12,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: theme.radius.md,
            borderWidth: set.isCompleted ? 0 : 1,
            borderColor: theme.colors.border,
            backgroundColor: set.isCompleted
              ? theme.colors.successMuted
              : pressed
                ? theme.colors.accentMuted
                : 'transparent',
          })}
        >
          {/* The tick is not the only signal: the word is there for anyone who
              cannot distinguish the fill. */}
          <Text variant="callout" color={set.isCompleted ? 'success' : 'muted'}>
            {set.isCompleted ? '✓' : '○'}
          </Text>
        </Pressable>

        <Pressable
          onPress={onDelete}
          accessibilityRole="button"
          accessibilityLabel={`Delete set ${set.setNumber}`}
          hitSlop={8}
          style={{
            minWidth: MIN_TOUCH_TARGET,
            minHeight: MIN_TOUCH_TARGET,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text variant="callout" color="muted">
            ✕
          </Text>
        </Pressable>
      </View>

      {previousLabel ? (
        <Text variant="caption" color="muted" style={{ paddingLeft: 36 }}>
          Last time: {previousLabel}
        </Text>
      ) : null}

      {problems.length > 0 ? (
        <Text
          variant="caption"
          color="danger"
          accessibilityLiveRegion="polite"
          style={{ paddingLeft: 36 }}
        >
          {problems[0]?.message}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One numeric field.
 *
 * `decimal-pad` rather than the full keyboard: there is nothing to type here
 * but a number, and the difference between a nine-key pad and a full keyboard
 * is the difference between one thumb and two hands.
 */
function Field({
  label,
  suffix,
  value,
  placeholder,
  onChangeText,
  onBlur,
}: {
  label: string;
  suffix: string;
  value: string;
  placeholder?: string;
  onChangeText: (text: string) => void;
  onBlur: () => void;
}) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);

  return (
    <View
      style={{
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: theme.spacing.sm,
        minHeight: MIN_TOUCH_TARGET,
        borderRadius: theme.radius.md,
        borderWidth: focused ? 2 : 1,
        borderColor: focused ? theme.colors.accent : theme.colors.border,
        backgroundColor: theme.colors.surface,
      }}
    >
      <TextInput
        accessibilityLabel={label}
        value={value}
        placeholder={placeholder ?? '—'}
        placeholderTextColor={theme.colors.textMuted}
        keyboardType="decimal-pad"
        inputMode="decimal"
        returnKeyType="done"
        selectTextOnFocus
        maxFontSizeMultiplier={1.4}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          onBlur();
        }}
        style={[
          theme.typography.body,
          { flex: 1, color: theme.colors.textPrimary, paddingVertical: 8 },
        ]}
      />
      <Text variant="caption" color="muted">
        {suffix}
      </Text>
    </View>
  );
}
