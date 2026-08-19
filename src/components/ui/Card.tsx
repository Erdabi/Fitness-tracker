import { View, type ViewProps, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

export interface CardProps extends ViewProps {
  /** Removes the inner padding for cards that host their own rows. */
  flush?: boolean;
  style?: ViewStyle;
}

/** Raised surface used for grouping related content. */
export function Card({ flush = false, style, children, ...rest }: CardProps) {
  const theme = useTheme();

  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: theme.radius.lg,
          padding: flush ? 0 : theme.spacing.lg,
          gap: theme.spacing.md,
          overflow: 'hidden',
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}
