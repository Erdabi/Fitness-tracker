import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';

import { Button, Card, Screen, Text, TextField } from '@/components/ui';
import { getDatabase } from '@/db/client';
import { cacheFood } from '@/db/repositories/foodRecents';
import { useAuth } from '@/features/auth/AuthProvider';
import { createCustomFood } from '@/features/food/customFoodService';
import { NutrientFieldset } from '@/features/scan/NutrientFieldset';
import type { NutrientKey } from '@/features/scan/nutrientFields';
import { BlockingProblems } from '@/features/scan/ScanStates';
import {
  EMPTY_LABEL_DRAFT,
  resolveLabelDraft,
  type LabelDraft,
} from '@/features/scan/labelDraft';
import type { AppError } from '@/lib/result';
import { logger } from '@/lib/logger';
import { useTheme } from '@/theme';

/**
 * Entering a food by hand.
 *
 * The fallback behind every scanning route, and the reason none of them is a
 * dead end: a barcode with no match, a label too worn to read, a photo the
 * model cannot make sense of all end here with whatever was already known
 * carried across.
 *
 * It shares `labelDraft` with the label review rather than having its own
 * form logic. The two are the same job — turn typed text into a food, refusing
 * what cannot be right — and a second copy of those rules would eventually
 * disagree with the first about what a valid food is.
 */
export default function CustomFoodScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { userId } = useAuth();

  const { barcode: barcodeParam, name: nameParam } = useLocalSearchParams<{
    barcode?: string;
    name?: string;
  }>();

  const [draft, setDraft] = useState<LabelDraft>(() => ({
    ...EMPTY_LABEL_DRAFT,
    name: nameParam ?? '',
    barcode: barcodeParam ?? '',
  }));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  const resolution = useMemo(() => resolveLabelDraft(draft), [draft]);

  const editNutrient = useCallback((key: NutrientKey, value: string) => {
    setDraft((current) => ({
      ...current,
      nutrients: { ...current.nutrients, [key]: value },
    }));
  }, []);

  const candidate = resolution.candidate;

  return (
    <Screen scrollable keyboardAvoiding>
      <View style={{ paddingTop: theme.spacing.lg, gap: theme.spacing.xs }}>
        <Text variant="displayMedium">Add your own food</Text>
        <Text variant="body" color="secondary">
          Copy the values from the packet. Leave anything it does not state
          empty — an empty field stays empty rather than becoming a zero.
        </Text>
      </View>

      {barcodeParam ? (
        <Card>
          <Text variant="overline" color="secondary">
            From the barcode you scanned
          </Text>
          <Text variant="body">{barcodeParam}</Text>
          <Text variant="caption" color="muted">
            It will be attached to this food, so scanning that packet again
            finds it straight away.
          </Text>
        </Card>
      ) : null}

      <TextField
        label="Name"
        value={draft.name}
        onChangeText={(value) => setDraft({ ...draft, name: value })}
        error={resolution.fieldErrors.name}
        autoCapitalize="sentences"
        autoFocus={!nameParam}
      />
      <TextField
        label="Brand (optional)"
        value={draft.brand}
        onChangeText={(value) => setDraft({ ...draft, brand: value })}
        autoCapitalize="sentences"
      />

      <UnitPicker
        value={draft.baseUnit}
        onChange={(baseUnit) => setDraft({ ...draft, baseUnit })}
      />

      <NutrientFieldset
        draft={draft.nutrients}
        errors={resolution.fieldErrors}
        basisLabel={
          draft.baseUnit === 'item' ? 'Per item' : `Per 100 ${draft.baseUnit}`
        }
        onChange={editNutrient}
      />

      <View style={{ gap: theme.spacing.md }}>
        <Text variant="overline" color="secondary">
          Portion (optional)
        </Text>
        <TextField
          label={`Serving size (${draft.baseUnit})`}
          value={draft.servingAmount}
          onChangeText={(value) => setDraft({ ...draft, servingAmount: value })}
          keyboardType="decimal-pad"
          inputMode="decimal"
          error={resolution.fieldErrors.servingAmount}
        />
        <TextField
          label="Serving name"
          value={draft.servingLabel}
          onChangeText={(value) => setDraft({ ...draft, servingLabel: value })}
          placeholder="1 slice, 1 bar…"
        />
        <TextField
          label="Barcode (optional)"
          value={draft.barcode}
          onChangeText={(value) => setDraft({ ...draft, barcode: value })}
          keyboardType="number-pad"
          inputMode="numeric"
          error={resolution.fieldErrors.barcode}
        />
      </View>

      <BlockingProblems problems={resolution.problems} />

      {error ? (
        <Text variant="caption" color="danger" accessibilityLiveRegion="polite">
          {error.message}
        </Text>
      ) : null}

      <Text variant="caption" color="muted">
        Saving needs a connection — your own foods live in the same catalogue
        the app searches. Once saved, it works offline like any other food.
      </Text>

      <Button
        label="Save this food"
        disabled={!candidate}
        loading={isSaving}
        onPress={() => {
          if (!candidate || !userId || isSaving) return;
          setIsSaving(true);
          setError(null);

          void createCustomFood({
            name: candidate.name,
            brandName: candidate.brandName,
            baseUnit: candidate.baseUnit,
            baseAmount: candidate.baseAmount,
            nutrition: candidate.nutrition,
            servings: candidate.serving ? [candidate.serving] : undefined,
            barcode: candidate.barcode,
            // Typed by a person from a packet. Never `ai_estimated`, and the
            // database refuses `is_verified` on anything owned regardless.
            source: 'user',
          }).then((result) => {
            if (!result.ok) {
              setIsSaving(false);
              setError(result.error);
              return;
            }

            // Cached immediately so the food it just created is available
            // offline, the same as one arrived at through search.
            try {
              cacheFood(
                result.value,
                candidate.serving ? [candidate.serving] : [],
                getDatabase(),
                candidate.barcode ?? undefined,
              );
            } catch (cause) {
              logger.warn('Could not cache new custom food', {
                reason: cause instanceof Error ? cause.name : 'unknown',
              });
            }

            // Straight to the food, where the portion is chosen and it is
            // logged — the same screen every other route ends on.
            router.replace({
              pathname: '/food/[id]',
              params: { id: result.value.foodId },
            });
          });
        }}
      />

      <Button label="Cancel" variant="ghost" onPress={() => router.back()} />
    </Screen>
  );
}

/**
 * What the food is measured in.
 *
 * `item` is offered here and not on the label review because a hand-entered
 * food is often countable — one egg, one bar — where a printed panel is always
 * per 100 g or 100 ml.
 */
function UnitPicker({
  value,
  onChange,
}: {
  value: 'g' | 'ml' | 'item';
  onChange: (unit: 'g' | 'ml' | 'item') => void;
}) {
  const theme = useTheme();

  const LABELS = {
    g: 'Grams',
    ml: 'Millilitres',
    item: 'Per item',
  } as const;

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="overline" color="secondary">
        Measured in
      </Text>
      <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
        {(['g', 'ml', 'item'] as const).map((unit) => {
          const selected = unit === value;
          return (
            <Text
              key={unit}
              variant="callout"
              color={selected ? 'accent' : 'secondary'}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={LABELS[unit]}
              onPress={() => onChange(unit)}
              style={{
                flex: 1,
                textAlign: 'center',
                paddingVertical: theme.spacing.sm,
                borderRadius: theme.radius.md,
                borderWidth: selected ? 2 : 1,
                borderColor: selected ? theme.colors.accent : theme.colors.border,
              }}
            >
              {LABELS[unit]}
            </Text>
          );
        })}
      </View>
    </View>
  );
}
