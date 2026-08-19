import React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

export interface ScreenProps {
  children: React.ReactNode;
  /** Wraps content in a ScrollView. Off for screens that own their own list. */
  scrollable?: boolean;
  /** Lifts content above the keyboard. On for any screen with a text input. */
  keyboardAvoiding?: boolean;
  /** Removes the default horizontal padding for edge-to-edge content. */
  flush?: boolean;
  contentContainerStyle?: ViewStyle;
}

/**
 * Screen shell: background, safe-area insets, keyboard avoidance.
 *
 * Centralised so no screen has to rediscover that iOS needs `padding` and
 * Android needs `height` for keyboard avoidance, and so the bottom inset is
 * applied consistently above the tab bar.
 */
export function Screen({
  children,
  scrollable = false,
  keyboardAvoiding = false,
  flush = false,
  contentContainerStyle,
}: ScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const padding: ViewStyle = {
    paddingHorizontal: flush ? 0 : theme.spacing.lg,
    paddingBottom: insets.bottom + theme.spacing.lg,
    gap: theme.spacing.lg,
  };

  const body = scrollable ? (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={[styles.grow, padding, contentContainerStyle]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.fill, padding, contentContainerStyle]}>{children}</View>
  );

  const content = keyboardAvoiding ? (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {body}
    </KeyboardAvoidingView>
  ) : (
    body
  );

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.background }]}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flexGrow: 1 },
});
