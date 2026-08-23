import { View } from 'react-native';

import { Text } from '@/components/ui';
import type { WeightEntryRow } from '@/db/schema';
import { formatWeight, type UnitSystem } from '@/lib/units';
import { useTheme } from '@/theme';

/**
 * A compact weight trend.
 *
 * Deliberately not a charting library: a sparkline of dots positioned by value
 * says everything a weight trend needs to say, and adding a dependency for it
 * would be a lot of surface for one shape.
 *
 * The chart is never the only way to read this. Every caller shows the same
 * facts as text, and the view carries a spoken summary of its own — a trend
 * that can only be seen is a trend half the users cannot read.
 */
export function WeightChart({
  entries,
  system,
  height = 96,
}: {
  entries: readonly WeightEntryRow[];
  system: UnitSystem;
  height?: number;
}) {
  const theme = useTheme();

  if (entries.length < 2) {
    return (
      <Text variant="caption" color="muted">
        Two readings are needed before a trend means anything.
      </Text>
    );
  }

  const values = entries.map((entry) => entry.weight_kg);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series would divide by zero and, worse, would render as noise
  // amplified to full scale. Give it a nominal range and it draws flat.
  const span = max - min < 0.2 ? 0.2 : max - min;

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <View
        accessible
        accessibilityLabel={describe(entries, system)}
        style={{
          height,
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: 2,
          paddingVertical: theme.spacing.xs,
        }}
      >
        {entries.map((entry) => {
          const fraction = (entry.weight_kg - min) / span;
          return (
            <View key={entry.id} style={{ flex: 1, height: '100%', justifyContent: 'flex-end' }}>
              <View
                style={{
                  height: Math.max(4, fraction * (height - 16) + 4),
                  borderTopLeftRadius: 2,
                  borderTopRightRadius: 2,
                  backgroundColor: theme.colors.accent,
                  opacity: 0.85,
                }}
              />
            </View>
          );
        })}
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text variant="overline" color="muted">
          {formatWeight(min, system)}
        </Text>
        <Text variant="overline" color="muted">
          {formatWeight(max, system)}
        </Text>
      </View>
    </View>
  );
}

/** The chart as a sentence. */
function describe(entries: readonly WeightEntryRow[], system: UnitSystem): string {
  const first = entries[0]!;
  const last = entries[entries.length - 1]!;
  const change = last.weight_kg - first.weight_kg;

  const direction =
    Math.abs(change) < 0.05
      ? 'unchanged'
      : `${change < 0 ? 'down' : 'up'} ${formatWeight(Math.abs(change), system)}`;

  return `Weight trend across ${entries.length} readings, from ${formatWeight(
    first.weight_kg,
    system,
  )} on ${first.measured_on} to ${formatWeight(last.weight_kg, system)} on ${
    last.measured_on
  } — ${direction}.`;
}
