import { View } from 'react-native';

import { Card, Skeleton, Text } from '@/components/ui';
import { formatWeight, type UnitSystem } from '@/lib/units';
import { useTheme } from '@/theme';
import type { WeightTrend } from './dashboardService';

/**
 * Current weight and how it has moved.
 *
 * The change is only shown when there is a genuinely earlier reading to
 * compare against — "0.0 kg this month" for somebody who has weighed
 * themselves once is an invented fact, and the card says "add another reading"
 * instead.
 */
export function WeightCard({
  trend,
  system,
  onPress,
}: {
  trend: WeightTrend;
  system: UnitSystem;
  onPress?: () => void;
}) {
  const theme = useTheme();

  if (!trend.current) {
    return (
      <Card>
        <Text variant="overline" color="secondary">
          Weight
        </Text>
        <Text variant="body" color="secondary">
          No weight entries yet.
        </Text>
        <Text
          variant="caption"
          color="accent"
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel="Record your weight"
        >
          Record your weight →
        </Text>
      </Card>
    );
  }

  const change = trend.changeKg;
  const direction = change === null ? null : change < 0 ? 'down' : change > 0 ? 'up' : 'level';

  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text variant="overline" color="secondary">
          Weight
        </Text>
        <Text
          variant="caption"
          color="accent"
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel="View progress"
        >
          Progress
        </Text>
      </View>

      <View
        style={{ flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.md }}
        accessible
        accessibilityLabel={describe(trend, system)}
      >
        <Text variant="displayMedium" tabular>
          {formatWeight(trend.current.weight_kg, system)}
        </Text>

        {change !== null ? (
          <Text
            variant="bodyStrong"
            color={direction === 'down' ? 'success' : direction === 'up' ? 'warning' : 'muted'}
            tabular
            style={{ paddingBottom: 4 }}
          >
            {change > 0 ? '+' : change < 0 ? '−' : '±'}
            {formatWeight(Math.abs(change), system)}
          </Text>
        ) : null}
      </View>

      <Text variant="caption" color="muted">
        {change === null
          ? 'Add another reading to see how it is trending.'
          : `over the last ${trend.overDays} days`}
      </Text>
    </Card>
  );
}

/** The card as a sentence, for anyone not reading the layout. */
function describe(trend: WeightTrend, system: UnitSystem): string {
  const current = formatWeight(trend.current!.weight_kg, system);
  if (trend.changeKg === null) return `Current weight ${current}. No earlier reading to compare.`;

  const moved =
    trend.changeKg === 0
      ? 'unchanged'
      : `${trend.changeKg < 0 ? 'down' : 'up'} ${formatWeight(Math.abs(trend.changeKg), system)}`;

  return `Current weight ${current}, ${moved} over the last ${trend.overDays} days.`;
}

export function WeightCardSkeleton() {
  return (
    <Card>
      <Skeleton height={11} width="25%" />
      <Skeleton height={34} width="45%" />
      <Skeleton height={13} width="55%" />
    </Card>
  );
}
