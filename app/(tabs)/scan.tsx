import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';

import { Card, Screen, Text } from '@/components/ui';
import { useTheme } from '@/theme';

/**
 * The Scan hub.
 *
 * Three entry points, each a different job. They are deliberately separate
 * rather than one "scan something" button that guesses: reading a barcode,
 * reading printed numbers off a panel, and estimating a plate from its
 * appearance need different capture behaviour and produce results with
 * different reliability. Asking the user which one they mean costs one tap and
 * removes an entire class of wrong answer.
 */
export default function ScanScreen() {
  const theme = useTheme();
  const router = useRouter();

  return (
    <Screen scrollable>
      <View style={{ paddingTop: theme.spacing.lg, gap: theme.spacing.xs }}>
        <Text variant="displayMedium">Scan</Text>
        <Text variant="body" color="secondary">
          Nothing is added to your diary until you have seen it and confirmed it.
        </Text>
      </View>

      <View style={{ gap: theme.spacing.md, paddingTop: theme.spacing.lg }}>
        <ScanOption
          title="Scan barcode"
          description="Point the camera at a product barcode to find it in the food database."
          detail="Works offline for foods you have scanned before."
          onPress={() => router.push('/scan/barcode')}
        />

        <ScanOption
          title="Scan nutrition label"
          description="Photograph the nutrition panel and the values are read from it."
          detail="Needs an internet connection. You check every value before it is saved."
          onPress={() => router.push('/scan/label')}
        />

        <ScanOption
          title="Take a food photo"
          description="Photograph a meal for an estimate of what is in it and roughly how much."
          detail="Needs an internet connection. Estimates only — always worth adjusting."
          onPress={() => router.push('/scan/photo')}
        />
      </View>

      <View style={{ paddingTop: theme.spacing.lg }}>
        <Card>
          <Text variant="overline" color="secondary">
            Nothing to scan?
          </Text>
          <Text variant="body" color="secondary">
            You can search the food database or enter a food by hand — both work
            without a connection.
          </Text>
          <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
            <Text
              variant="callout"
              color="accent"
              onPress={() => router.push('/food/search')}
              accessibilityRole="button"
            >
              Search foods
            </Text>
            <Text
              variant="callout"
              color="accent"
              onPress={() => router.push('/food/custom')}
              accessibilityRole="button"
            >
              Enter by hand
            </Text>
          </View>
        </Card>
      </View>
    </Screen>
  );
}

function ScanOption({
  title,
  description,
  detail,
  onPress,
}: {
  title: string;
  description: string;
  detail: string;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={`${description} ${detail}`}
      style={({ pressed }) => ({
        padding: theme.spacing.lg,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: pressed ? theme.colors.accent : theme.colors.border,
        backgroundColor: pressed ? theme.colors.accentMuted : theme.colors.surface,
        gap: theme.spacing.xs,
        // Comfortably above the 44pt minimum: these are the primary actions.
        minHeight: 88,
      })}
    >
      <Text variant="headline">{title}</Text>
      <Text variant="callout" color="secondary">
        {description}
      </Text>
      <Text variant="caption" color="muted">
        {detail}
      </Text>
    </Pressable>
  );
}
