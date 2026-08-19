import { View } from 'react-native';

import { Screen, Text } from './ui';
import { useTheme } from '@/theme';

/**
 * Placeholder for tabs whose features land in later phases.
 *
 * Named for what it is: these screens are scaffolding, and saying so keeps
 * anyone from mistaking an intentionally empty tab for a broken one.
 */
export function PhasePlaceholder({
  title,
  description,
  phase,
}: {
  title: string;
  description: string;
  phase: string;
}) {
  const theme = useTheme();

  return (
    <Screen>
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          gap: theme.spacing.sm,
        }}
      >
        <Text variant="overline" color="accent">
          {phase}
        </Text>
        <Text variant="displayMedium">{title}</Text>
        <Text variant="body" color="secondary">
          {description}
        </Text>
      </View>
    </Screen>
  );
}
