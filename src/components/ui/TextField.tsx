import { forwardRef, useId, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { MIN_TOUCH_TARGET, useTheme } from '@/theme';
import { Text } from './Text';

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  /** Shown under the field and announced to screen readers. */
  error?: string | undefined;
  /** Guidance shown when there is no error. */
  hint?: string | undefined;
  containerStyle?: ViewStyle;
  /** Adds a show/hide toggle. Use instead of a bare `secureTextEntry`. */
  secureToggle?: boolean;
}

/**
 * Labelled text input with error and hint states.
 *
 * The label is always visible rather than a placeholder that vanishes on
 * focus — placeholder-as-label fails badly for anyone who gets interrupted
 * mid-form, and disappears entirely for screen readers.
 */
export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  {
    label,
    error,
    hint,
    containerStyle,
    secureToggle = false,
    secureTextEntry,
    onFocus,
    onBlur,
    ...rest
  },
  ref,
) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const errorId = useId();

  const isSecure = secureToggle ? !revealed : secureTextEntry;
  const borderColor = error
    ? theme.colors.danger
    : focused
      ? theme.colors.accent
      : theme.colors.border;

  return (
    <View style={[{ gap: theme.spacing.xs }, containerStyle]}>
      <Text variant="caption" color="secondary">
        {label}
      </Text>

      <View
        style={[
          styles.inputRow,
          {
            borderColor,
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.surface,
            paddingHorizontal: theme.spacing.md,
            minHeight: MIN_TOUCH_TARGET,
            // Focus reads as a weight change as well as a colour change, so it
            // survives for users who cannot distinguish the hue.
            borderWidth: focused || error ? 2 : 1,
          },
        ]}
      >
        <TextInput
          ref={ref}
          accessibilityLabel={label}
          accessibilityHint={hint}
          aria-errormessage={error ? errorId : undefined}
          placeholderTextColor={theme.colors.textMuted}
          secureTextEntry={isSecure}
          maxFontSizeMultiplier={1.4}
          style={[
            styles.input,
            theme.typography.body,
            { color: theme.colors.textPrimary },
          ]}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          {...rest}
        />

        {secureToggle ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
            hitSlop={12}
            onPress={() => setRevealed((current) => !current)}
          >
            <Text variant="caption" color="accent">
              {revealed ? 'Hide' : 'Show'}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {error ? (
        <Text
          nativeID={errorId}
          variant="caption"
          color="danger"
          accessibilityLiveRegion="polite"
        >
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" color="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    flex: 1,
    paddingVertical: 10,
  },
});
