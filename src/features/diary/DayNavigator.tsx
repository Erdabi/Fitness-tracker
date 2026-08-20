import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui';
import { addDays, daysBetween, type LocalDay } from '@/lib/date';
import { useTheme } from '@/theme';

/**
 * Moves between diary days.
 *
 * Forward is disabled beyond today: a diary records what happened, and
 * offering tomorrow invites entries that will be wrong by morning. Backwards
 * is unbounded.
 */
export function DayNavigator({
  day,
  today,
  onChange,
}: {
  day: LocalDay;
  today: LocalDay;
  onChange: (day: LocalDay) => void;
}) {
  const theme = useTheme();
  const canGoForward = daysBetween(day, today) > 0;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.spacing.md,
      }}
    >
      <Arrow
        label="Previous day"
        glyph="‹"
        onPress={() => onChange(addDays(day, -1))}
      />

      <Pressable
        onPress={() => onChange(today)}
        disabled={day === today}
        accessibilityRole="button"
        accessibilityLabel={`${describeDay(day, today)}. Tap to return to today.`}
        style={{ flex: 1, alignItems: 'center' }}
      >
        <Text variant="headline">{describeDay(day, today)}</Text>
        <Text variant="caption" color="muted">
          {formatFullDay(day)}
        </Text>
      </Pressable>

      <Arrow
        label="Next day"
        glyph="›"
        disabled={!canGoForward}
        onPress={() => onChange(addDays(day, 1))}
      />
    </View>
  );
}

function Arrow({
  label,
  glyph,
  onPress,
  disabled = false,
}: {
  label: string;
  glyph: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      hitSlop={12}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: theme.radius.md,
        opacity: disabled ? 0.3 : 1,
        backgroundColor: pressed ? theme.colors.surfaceMuted : 'transparent',
      })}
    >
      <Text variant="title" color={disabled ? 'muted' : 'primary'}>
        {glyph}
      </Text>
    </Pressable>
  );
}

/**
 * Names a day the way a person would.
 *
 * "Today" and "Yesterday" beat a date for the two days that carry almost all
 * the traffic; a weekday name covers the rest of the week, which is how people
 * remember the recent past. Anything older gets the date, because "three weeks
 * ago Thursday" is not a thing anyone can check at a glance.
 */
export function describeDay(day: LocalDay, today: LocalDay): string {
  const delta = daysBetween(today, day);

  if (delta === 0) return 'Today';
  if (delta === -1) return 'Yesterday';
  if (delta === 1) return 'Tomorrow';
  if (delta > -7 && delta < 0) return weekdayOf(day);

  return formatFullDay(day);
}

function weekdayOf(day: LocalDay): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(asUtcDate(day));
}

export function formatFullDay(day: LocalDay): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(asUtcDate(day));
}

/**
 * Reads a calendar day as a UTC instant, purely for formatting.
 *
 * Safe precisely because the formatters above are pinned to UTC: the date is
 * already the user's local day, so re-interpreting it in a zone would shift
 * the label off the day it names.
 */
function asUtcDate(day: LocalDay): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date));
}
