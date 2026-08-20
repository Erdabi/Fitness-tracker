import { View } from 'react-native';

import { Text } from '@/components/ui';
import { useTheme } from '@/theme';

/**
 * What these numbers are.
 *
 * Shown wherever a calculated figure appears. Mifflin-St Jeor is a population
 * regression: it predicts resting metabolic rate to within roughly ±10% for
 * most people and further off for some, and the activity multipliers are
 * coarser still. Presenting the output as a measurement would be the single
 * most misleading thing this app could do, so it is labelled every time
 * rather than once in an onboarding screen nobody re-reads.
 */
export function EstimateNotice({ compact = false }: { compact?: boolean }) {
  const theme = useTheme();

  return (
    <View
      style={{
        padding: theme.spacing.md,
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.surfaceMuted,
        gap: theme.spacing.xs,
      }}
    >
      <Text variant="caption" color="secondary">
        These are estimates from a standard formula, not measurements. Real energy
        needs vary from person to person and week to week.
      </Text>
      {compact ? null : (
        <Text variant="caption" color="muted">
          Use them as a starting point and adjust from what actually happens. This app
          does not give medical or dietary advice; talk to a professional before making
          significant changes.
        </Text>
      )}
    </View>
  );
}

/**
 * Shown when the floor moved the recommendation.
 *
 * The wording is careful on purpose: the floor is a rule about what this app
 * will suggest, not a claim about what is safe for the person reading it.
 */
export function FloorNotice({
  floor,
  rawTarget,
}: {
  floor: number;
  rawTarget: number;
}) {
  const theme = useTheme();

  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        padding: theme.spacing.md,
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.warningMuted,
        gap: theme.spacing.xs,
      }}
    >
      <Text variant="caption" color="warning">
        The arithmetic gave {rawTarget.toLocaleString()} kcal, which is below the lowest
        target this app will suggest ({floor.toLocaleString()} kcal), so the suggestion
        was raised.
      </Text>
      <Text variant="caption" color="secondary">
        That limit is this app&apos;s own rule, not a statement about what is safe for
        you. A slower rate of loss, or advice from a professional, is the better route
        below it.
      </Text>
    </View>
  );
}

/** Shown when the user is about to store a target below the floor by hand. */
export function BelowFloorWarning({ floor }: { floor: number }) {
  const theme = useTheme();

  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        padding: theme.spacing.md,
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.warningMuted,
      }}
    >
      <Text variant="caption" color="warning">
        This is below {floor.toLocaleString()} kcal, the lowest target this app will
        suggest on its own. You can still set it, but the app will not recommend it and
        it is worth discussing with a professional.
      </Text>
    </View>
  );
}
