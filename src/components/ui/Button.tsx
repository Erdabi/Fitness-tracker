import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type ViewStyle,
} from 'react-native';

import { MIN_TOUCH_TARGET, useTheme, type Theme } from '@/theme';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'medium' | 'large';

export interface ButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  style?: ViewStyle;
}

/**
 * Primary action control.
 *
 * While `loading`, the label stays mounted behind the spinner so the button
 * keeps its width — a button that shrinks mid-submit shifts everything under
 * it and can move a control out from under the user's thumb.
 */
export function Button({
  label,
  variant = 'primary',
  size = 'large',
  loading = false,
  fullWidth = true,
  disabled,
  style,
  ...rest
}: ButtonProps) {
  const theme = useTheme();
  const isInactive = disabled === true || loading;
  const palette = variantPalette(variant, theme);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isInactive, busy: loading }}
      accessibilityLabel={label}
      disabled={isInactive}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: size === 'large' ? MIN_TOUCH_TARGET + 4 : MIN_TOUCH_TARGET,
          paddingHorizontal: theme.spacing.lg,
          borderRadius: theme.radius.md,
          backgroundColor: pressed ? palette.pressedBackground : palette.background,
          borderColor: palette.border,
          borderWidth: palette.border === 'transparent' ? 0 : 1,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
          opacity: isInactive ? 0.55 : 1,
        },
        style,
      ]}
      {...rest}
    >
      <View style={styles.content}>
        <Text
          variant="headline"
          style={[{ color: palette.foreground }, loading ? styles.hidden : null]}
        >
          {label}
        </Text>
        {loading ? (
          <ActivityIndicator
            color={palette.foreground}
            style={StyleSheet.absoluteFill}
            accessibilityElementsHidden
          />
        ) : null}
      </View>
    </Pressable>
  );
}

interface VariantPalette {
  background: string;
  pressedBackground: string;
  foreground: string;
  border: string;
}

function variantPalette(variant: ButtonVariant, theme: Theme): VariantPalette {
  const { colors } = theme;

  switch (variant) {
    case 'secondary':
      return {
        background: colors.surface,
        pressedBackground: colors.surfaceMuted,
        foreground: colors.textPrimary,
        border: colors.border,
      };
    case 'ghost':
      return {
        background: 'transparent',
        pressedBackground: colors.surfaceMuted,
        foreground: colors.accent,
        border: 'transparent',
      };
    case 'danger':
      return {
        background: colors.danger,
        pressedBackground: colors.danger,
        foreground: colors.surface,
        border: 'transparent',
      };
    default:
      return {
        background: colors.accent,
        pressedBackground: colors.accentPressed,
        foreground: colors.textOnAccent,
        border: 'transparent',
      };
  }
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  hidden: {
    opacity: 0,
  },
});
