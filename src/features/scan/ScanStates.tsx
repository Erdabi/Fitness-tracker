import { ActivityIndicator, View } from 'react-native';

import { Button, Card, Text } from '@/components/ui';
import type { AppError } from '@/lib/result';
import type { Confidence } from '@/features/ai/schemas';
import { useTheme } from '@/theme';

/**
 * The states an AI scan passes through.
 *
 * Collected here so both scan flows show the same thing for the same
 * situation, and so the wording about what these results are can be written
 * once and be right everywhere.
 */

/**
 * Analysis in progress.
 *
 * `accessibilityLiveRegion` matters more than usual here: the screen changes
 * from a button to a spinner with no focus movement, and without an
 * announcement a screen-reader user is left on a control that has silently
 * stopped doing anything.
 */
export function AnalyzingState({ label }: { label: string }) {
  const theme = useTheme();

  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${label}. This usually takes a few seconds.`}
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.xl,
      }}
    >
      <ActivityIndicator color={theme.colors.accent} />
      <Text variant="callout" color="secondary" align="center">
        {label}
      </Text>
      <Text variant="caption" color="muted" align="center">
        This usually takes a few seconds.
      </Text>
    </View>
  );
}

/**
 * A failed analysis.
 *
 * Offline is separated from every other failure because it is the one the user
 * can do something about, and because the alternatives — search, or type it in
 * — genuinely work without a connection.
 */
export function ScanErrorState({
  error,
  onRetry,
  onSearch,
  onManual,
}: {
  error: AppError;
  onRetry?: () => void;
  onSearch?: () => void;
  onManual?: () => void;
}) {
  const theme = useTheme();
  const isOffline = error.kind === 'network';

  return (
    <Card>
      <View accessible accessibilityLiveRegion="assertive" style={{ gap: theme.spacing.xs }}>
        {/*
          The heading carries the meaning, not the colour: an error that is
          only red is an error some people cannot see.
        */}
        <Text variant="headline" color="danger">
          {isOffline ? 'No connection' : 'That did not work'}
        </Text>
        <Text variant="body" color="secondary">
          {error.message}
        </Text>
      </View>

      {onRetry && error.retryable ? <Button label="Try again" onPress={onRetry} /> : null}
      {onSearch ? (
        <Button label="Search for the food" variant="secondary" onPress={onSearch} />
      ) : null}
      {onManual ? (
        <Button label="Enter it by hand" variant="secondary" onPress={onManual} />
      ) : null}
    </Card>
  );
}

/**
 * How much to trust what follows.
 *
 * Shown above every AI result, and worded so that `low` reads as an
 * instruction rather than a decoration. The word appears alongside the colour
 * for the same reason as above.
 */
export function ConfidenceNotice({
  confidence,
  kind,
}: {
  confidence: Confidence;
  kind: 'label' | 'photo';
}) {
  const theme = useTheme();

  const tone =
    confidence === 'high' ? 'success' : confidence === 'medium' ? 'warning' : 'danger';

  const background =
    confidence === 'high'
      ? theme.colors.successMuted
      : confidence === 'medium'
        ? theme.colors.warningMuted
        : theme.colors.dangerMuted;

  const heading =
    confidence === 'high'
      ? 'Read clearly'
      : confidence === 'medium'
        ? 'Read with some uncertainty'
        : 'Low confidence — check every value';

  const detail =
    kind === 'label'
      ? confidence === 'high'
        ? 'The panel was legible. Still worth a glance before you save.'
        : confidence === 'medium'
          ? 'Some values were harder to read. Check them against the packet.'
          : 'Several values had to be inferred. Check each one against the packet before saving.'
      : confidence === 'high'
        ? 'The foods were identifiable, but portions from a photo are always estimates.'
        : confidence === 'medium'
          ? 'Portions were hard to judge from this angle. Adjust anything that looks off.'
          : 'This is a rough guess. Treat every number as a starting point, not a measurement.';

  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${heading}. ${detail}`}
      style={{
        padding: theme.spacing.md,
        borderRadius: theme.radius.md,
        backgroundColor: background,
        gap: 2,
      }}
    >
      <Text variant="caption" color={tone}>
        {heading}
      </Text>
      <Text variant="caption" color="secondary">
        {detail}
      </Text>
    </View>
  );
}

/** Anything the model flagged about the image. */
export function ScanWarnings({ warnings }: { warnings: readonly string[] }) {
  const theme = useTheme();
  if (warnings.length === 0) return null;

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Text variant="overline" color="secondary">
        Worth knowing
      </Text>
      {warnings.map((warning) => (
        <Text key={warning} variant="caption" color="secondary">
          • {warning}
        </Text>
      ))}
    </View>
  );
}

/**
 * Problems that block saving.
 *
 * Distinct from warnings: these are values that cannot be right, and the save
 * button stays disabled until they are corrected. Listing the field makes the
 * fix obvious rather than leaving the user hunting.
 */
export function BlockingProblems({
  problems,
}: {
  problems: readonly { field: string; message: string }[];
}) {
  const theme = useTheme();
  if (problems.length === 0) return null;

  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      style={{
        padding: theme.spacing.md,
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.dangerMuted,
        gap: theme.spacing.xs,
      }}
    >
      <Text variant="caption" color="danger">
        Fix before saving
      </Text>
      {problems.map((problem) => (
        <Text key={`${problem.field}:${problem.message}`} variant="caption" color="secondary">
          • {problem.message}
        </Text>
      ))}
    </View>
  );
}
