import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui';
import { displayEnergy, displayMacro } from '@/lib/nutrition';
import { MIN_TOUCH_TARGET, useTheme } from '@/theme';
import type { FoodSearchResult } from './types';

/**
 * One row in the food picker.
 *
 * Shows the four things that identify a food and let someone choose between
 * two similar ones — name, brand, portion, and energy with the three macros.
 * Not the full nutrition panel: eight numbers per row turns a list into a
 * spreadsheet, and the detail screen is where that belongs.
 */
export function FoodResultRow({
  result,
  onPress,
}: {
  result: FoodSearchResult;
  onPress: (result: FoodSearchResult) => void;
}) {
  const theme = useTheme();

  // Results are per base amount; the row states which, so "52 kcal" is never
  // ambiguous between a portion and 100 g.
  const basis = result.defaultServing
    ? result.defaultServing.label
    : `${result.baseAmount} ${result.baseUnit}`;

  const perBasis = result.defaultServing
    ? (result.calories / result.baseAmount) * result.defaultServing.amount
    : result.calories;

  const scale = result.defaultServing
    ? result.defaultServing.amount / result.baseAmount
    : 1;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${result.name}${result.brandName ? `, ${result.brandName}` : ''}, ${displayEnergy(perBasis)} kilocalories per ${basis}`}
      onPress={() => onPress(result)}
      style={({ pressed }) => ({
        minHeight: MIN_TOUCH_TARGET + 12,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
        backgroundColor: pressed ? theme.colors.surfaceMuted : 'transparent',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        gap: 2,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing.sm }}>
        <Text variant="bodyStrong" style={{ flex: 1 }} numberOfLines={1}>
          {result.name}
        </Text>
        <Text variant="bodyStrong" tabular>
          {displayEnergy(perBasis)}
          <Text variant="caption" color="muted">
            {' '}
            kcal
          </Text>
        </Text>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing.sm }}>
        <Text variant="caption" color="muted" style={{ flex: 1 }} numberOfLines={1}>
          {[result.brandName, basis].filter(Boolean).join(' · ')}
        </Text>
        <Text variant="caption" color="muted" tabular>
          P {displayMacro(result.protein_g * scale)} · C{' '}
          {displayMacro(result.carbohydrates_g * scale)} · F{' '}
          {displayMacro(result.fat_g * scale)}
        </Text>
      </View>

      {/*
        Provenance is shown only where it changes a decision: "yours" tells
        someone why an entry they do not recognise is in the list, and an
        unverified crowd-sourced row is worth a glance. A verified USDA row
        needs no badge — it is the baseline.
      */}
      {result.isOwn || !result.isVerified ? (
        <Text
          variant="overline"
          color={result.isOwn ? 'accent' : 'muted'}
          style={{ marginTop: 2 }}
        >
          {result.isOwn ? 'Your food' : 'Community data'}
        </Text>
      ) : null}
    </Pressable>
  );
}
