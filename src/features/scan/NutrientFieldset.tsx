import { View } from 'react-native';

import { Text, TextField } from '@/components/ui';
import { useTheme } from '@/theme';
import {
  NUTRIENT_FIELDS,
  type NutrientDraft,
  type NutrientKey,
} from './nutrientFields';

/**
 * The nutrient inputs, shared by every route that creates a food.
 *
 * One component for the label review, the photo review and manual entry, so
 * the three cannot drift into offering different fields — which would mean a
 * food's completeness depended on which screen made it.
 *
 * `basisLabel` states what the numbers are per, and is not decoration: the
 * same eight fields mean "per 100 g" on a label and "this portion" on a photo,
 * and a user who reads the wrong one enters a number that is off by whatever
 * their portion happened to be.
 */
export function NutrientFieldset({
  draft,
  errors,
  basisLabel,
  missing,
  onChange,
}: {
  draft: NutrientDraft;
  errors: Readonly<Partial<Record<NutrientKey, string>>>;
  basisLabel: string;
  /** Fields the scan could not read, called out so a blank looks deliberate. */
  missing?: readonly NutrientKey[];
  onChange: (key: NutrientKey, value: string) => void;
}) {
  const theme = useTheme();
  const unread = new Set<NutrientKey>(missing ?? []);

  return (
    <View style={{ gap: theme.spacing.md }}>
      <Text variant="overline" color="secondary">
        {basisLabel}
      </Text>

      {NUTRIENT_FIELDS.map((field) => (
        <TextField
          key={field.key}
          label={`${field.label} (${field.unit})`}
          value={draft[field.key]}
          onChangeText={(value) => onChange(field.key, value)}
          keyboardType="decimal-pad"
          inputMode="decimal"
          error={errors[field.key]}
          hint={
            errors[field.key]
              ? undefined
              : unread.has(field.key)
                ? 'Could not be read — enter it from the packet.'
                : field.required
                  ? undefined
                  : 'Leave empty if the label does not say.'
          }
          placeholder={field.required ? '' : 'not stated'}
        />
      ))}
    </View>
  );
}
