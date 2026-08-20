import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { Button, Screen, Text } from '@/components/ui';
import { useTheme } from '@/theme';

/**
 * Diary tab.
 *
 * The day view itself arrives in the next milestone. Until then this is the
 * way into food search, which is complete and usable — rather than a
 * placeholder that hides working functionality behind a "coming soon".
 */
export default function DiaryScreen() {
  const theme = useTheme();
  const router = useRouter();

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', gap: theme.spacing.md }}>
        <Text variant="overline" color="accent">
          Phase 1
        </Text>
        <Text variant="displayMedium">Diary</Text>
        <Text variant="body" color="secondary">
          Meals, running totals and editing land in the next milestone. Food
          search works now — try it out.
        </Text>

        <View style={{ marginTop: theme.spacing.lg }}>
          <Button label="Search foods" onPress={() => router.push('/food/search')} />
        </View>
      </View>
    </Screen>
  );
}
