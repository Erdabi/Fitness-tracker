import {
  Text as RNText,
  type TextProps as RNTextProps,
  type TextStyle,
} from 'react-native';

import { useTheme, type TypographyVariant } from '@/theme';

type ColorRole =
  | 'primary'
  | 'secondary'
  | 'muted'
  | 'accent'
  | 'onAccent'
  | 'success'
  | 'warning'
  | 'danger';

export interface TextProps extends RNTextProps {
  variant?: TypographyVariant;
  color?: ColorRole;
  align?: TextStyle['textAlign'];
  /** Renders digits at uniform width so numbers do not jitter as they change. */
  tabular?: boolean;
  uppercase?: boolean;
}

/**
 * The only text component in the app.
 *
 * Routing every string through here is what keeps type consistent and makes
 * dynamic-type support a single change rather than an audit of every screen.
 */
export function Text({
  variant = 'body',
  color = 'primary',
  align,
  tabular = false,
  uppercase = false,
  style,
  ...rest
}: TextProps) {
  const theme = useTheme();
  const typeStyle = theme.typography[variant];

  return (
    <RNText
      // Lets the OS scale text, capped so layouts do not break outright.
      maxFontSizeMultiplier={1.6}
      style={[
        typeStyle as TextStyle,
        { color: resolveColor(color, theme.colors) },
        align ? { textAlign: align } : null,
        tabular ? { fontVariant: ['tabular-nums'] as TextStyle['fontVariant'] } : null,
        uppercase ? { textTransform: 'uppercase' as const } : null,
        style,
      ]}
      {...rest}
    />
  );
}

function resolveColor(
  role: ColorRole,
  colors: ReturnType<typeof useTheme>['colors'],
): string {
  switch (role) {
    case 'secondary':
      return colors.textSecondary;
    case 'muted':
      return colors.textMuted;
    case 'accent':
      return colors.accent;
    case 'onAccent':
      return colors.textOnAccent;
    case 'success':
      return colors.success;
    case 'warning':
      return colors.warning;
    case 'danger':
      return colors.danger;
    default:
      return colors.textPrimary;
  }
}
