import { View } from 'react-native';

import { useTheme } from '@/theme';

/**
 * A bar that fills to a fraction and turns amber past the target.
 *
 * Hidden from the accessibility tree on purpose: a bar cannot render past its
 * own end, so the colour is doing the work of saying "over", and colour alone
 * is not information. Every caller shows the same fact as text beside it, and
 * `label` describes the bar for anyone who reaches it.
 */
export function ProgressBar({
  fraction,
  isOver = false,
  label,
  height = 6,
}: {
  fraction: number;
  isOver?: boolean;
  label: string;
  height?: number;
}) {
  const theme = useTheme();

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
      style={{
        height,
        borderRadius: height / 2,
        backgroundColor: theme.colors.surfaceMuted,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`,
          height: '100%',
          backgroundColor: isOver ? theme.colors.warning : theme.colors.accent,
        }}
      />
    </View>
  );
}
