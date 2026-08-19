import { useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Easing, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Button } from './Button';
import { Text } from './Text';

/**
 * The four states every screen ships with.
 *
 * Collected in one file so no screen can quietly skip one — a screen that only
 * handles "populated" is the most common source of a blank rectangle in
 * production.
 */

/* --------------------------------------------------------------- loading -- */

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  const theme = useTheme();
  return (
    <View style={[styles.centered, { padding: theme.spacing.xl, gap: theme.spacing.md }]}>
      <ActivityIndicator color={theme.colors.accent} />
      <Text variant="callout" color="muted">
        {label}
      </Text>
    </View>
  );
}

/**
 * Skeleton placeholder.
 *
 * Preferred over a spinner wherever the final layout is known: matching the
 * shape of the content means the page does not jump when data lands.
 */
export function Skeleton({
  height = 16,
  width = '100%',
  radius,
}: {
  height?: number;
  width?: number | `${number}%`;
  radius?: number;
}) {
  const theme = useTheme();
  const pulse = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.4,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        height,
        width,
        opacity: pulse,
        borderRadius: radius ?? theme.radius.sm,
        backgroundColor: theme.colors.surfaceMuted,
      }}
    />
  );
}

/* ----------------------------------------------------------------- empty -- */

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.centered, { padding: theme.spacing.xl, gap: theme.spacing.sm }]}>
      <Text variant="headline" align="center">
        {title}
      </Text>
      {description ? (
        <Text variant="callout" color="muted" align="center">
          {description}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <View style={{ marginTop: theme.spacing.md }}>
          <Button
            label={actionLabel}
            variant="secondary"
            fullWidth={false}
            onPress={onAction}
          />
        </View>
      ) : null}
    </View>
  );
}

/* ----------------------------------------------------------------- error -- */

export function ErrorState({
  title = 'Something went wrong',
  description,
  onRetry,
  retryLabel = 'Try again',
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.centered, { padding: theme.spacing.xl, gap: theme.spacing.sm }]}
    >
      <Text variant="headline" color="danger" align="center">
        {title}
      </Text>
      {description ? (
        <Text variant="callout" color="secondary" align="center">
          {description}
        </Text>
      ) : null}
      {onRetry ? (
        <View style={{ marginTop: theme.spacing.md }}>
          <Button
            label={retryLabel}
            variant="secondary"
            fullWidth={false}
            onPress={onRetry}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
