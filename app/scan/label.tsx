import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';

import { Button, Card, Screen, Text, TextField } from '@/components/ui';
import type { MealSlot } from '@/db/schema';
import { normalizeLabel } from '@/features/ai/normalize';
import type { LabelExtraction } from '@/features/ai/schemas';
import { isUnusable } from '@/features/ai/schemas';
import { useAuth } from '@/features/auth/AuthProvider';
import { describeDay } from '@/features/diary/DayNavigator';
import { MealPicker, defaultMealFor } from '@/features/diary/MealPicker';
import { useDiaryMutations, useDiaryTimeZone, useToday } from '@/features/diary/useDiary';
import { ServingSelector } from '@/features/food/ServingSelector';
import { confirmScannedFood } from '@/features/scan/confirmScan';
import {
  draftFromLabel,
  resolveLabelDraft,
  type LabelDraft,
} from '@/features/scan/labelDraft';
import { NutrientFieldset } from '@/features/scan/NutrientFieldset';
import type { NutrientKey } from '@/features/scan/nutrientFields';
import {
  AnalyzingState,
  BlockingProblems,
  ConfidenceNotice,
  ScanErrorState,
  ScanWarnings,
} from '@/features/scan/ScanStates';
import { useImageCapture } from '@/features/scan/useImageCapture';
import { useLabelAnalysis } from '@/features/scan/useScanAnalysis';
import { isLocalDay, type LocalDay } from '@/lib/date';
import { servingOptions, type Serving } from '@/lib/nutrition';
import { appError, type AppError } from '@/lib/result';
import { logger } from '@/lib/logger';
import { useTheme } from '@/theme';

/**
 * Photograph a nutrition panel, check what was read, then log it.
 *
 * Capture, analysis and review live on one screen rather than three routes.
 * The alternative would mean serialising a whole extraction through navigation
 * params — lossy, and it would put the model's output somewhere a deep link
 * could forge. Here the result never leaves the component that received it.
 *
 * Nothing is written anywhere until the user presses the button at the bottom.
 * The analysis produces a form, not a record.
 */
export default function LabelScanScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { userId } = useAuth();
  const timeZone = useDiaryTimeZone();
  const today = useToday();
  const { logFood } = useDiaryMutations();

  const { barcode: barcodeParam, meal: mealParam, day: dayParam } =
    useLocalSearchParams<{ barcode?: string; meal?: string; day?: string }>();

  const capture = useImageCapture();
  const analysis = useLabelAnalysis();

  const [draft, setDraft] = useState<LabelDraft | null>(null);
  const [extraction, setExtraction] = useState<LabelExtraction | null>(null);
  const [meal, setMeal] = useState<MealSlot>(() =>
    asMeal(mealParam) ?? defaultMealFor(new Date(), timeZone),
  );
  const [selection, setSelection] = useState<{
    quantity: number;
    serving: Serving | null;
  } | null>(null);
  const [saveToCatalogue, setSaveToCatalogue] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<AppError | null>(null);

  const targetDay: LocalDay = dayParam && isLocalDay(dayParam) ? dayParam : today;

  const normalized = useMemo(
    () => (extraction ? normalizeLabel(extraction) : null),
    [extraction],
  );

  const resolution = useMemo(
    () => (draft ? resolveLabelDraft(draft) : null),
    [draft],
  );

  const start = useCallback(
    async (source: 'camera' | 'library') => {
      const image = await capture.capture(source);
      // Null means the user backed out of the picker. Not an error, not a
      // state change — the screen simply stays where it was.
      if (!image || !image.ok) return;

      setSaveError(null);
      const outcome = await analysis.analyze(image.value);
      if (!outcome.ok) return;

      setExtraction(outcome.value);
      setDraft(draftFromLabel(normalizeLabel(outcome.value), barcodeParam ?? null));
    },
    [analysis, barcodeParam, capture],
  );

  const editNutrient = useCallback((key: NutrientKey, value: string) => {
    setDraft((current) =>
      current ? { ...current, nutrients: { ...current.nutrients, [key]: value } } : current,
    );
  }, []);

  /* ------------------------------------------------------------- capturing */

  if (analysis.phase === 'analyzing') {
    return (
      <Screen>
        <AnalyzingState label="Reading the nutrition panel" />
      </Screen>
    );
  }

  if (!draft || !normalized) {
    const error = analysis.error ?? capture.error;

    return (
      <Screen scrollable>
        <View style={{ paddingTop: theme.spacing.lg, gap: theme.spacing.xs }}>
          <Text variant="displayMedium">Scan a nutrition label</Text>
          <Text variant="body" color="secondary">
            Photograph the nutrition panel straight on, filling most of the
            frame. You will see everything that was read before anything is
            saved.
          </Text>
        </View>

        {error ? (
          <ScanErrorState
            error={error}
            onRetry={() => {
              capture.clearError();
              analysis.reset();
            }}
            onSearch={() => router.replace('/food/search')}
            onManual={() =>
              router.replace({
                pathname: '/food/custom',
                params: barcodeParam ? { barcode: barcodeParam } : {},
              })
            }
          />
        ) : null}

        {extraction && isUnusable(extraction) ? (
          <Card>
            <Text variant="headline">Nothing readable in that photo</Text>
            <Text variant="body" color="secondary">
              {extraction.warnings[0] ??
                'The nutrition panel could not be made out. A straighter, closer photo in better light usually fixes it.'}
            </Text>
          </Card>
        ) : null}

        <Button
          label="Take a photo"
          loading={capture.isBusy}
          onPress={() => void start('camera')}
        />
        <Button
          label="Choose an existing photo"
          variant="secondary"
          onPress={() => void start('library')}
        />
        <Button label="Cancel" variant="ghost" onPress={() => router.back()} />
      </Screen>
    );
  }

  /* --------------------------------------------------------------- review */

  const candidate = resolution?.candidate ?? null;
  const servings = candidate?.serving ? [candidate.serving] : [];

  const chosen =
    selection ??
    (candidate
      ? {
          quantity: 1,
          serving: servingOptions(
            { baseUnit: candidate.baseUnit, baseAmount: candidate.baseAmount },
            servings,
          )[0]!,
        }
      : null);

  return (
    <Screen scrollable keyboardAvoiding>
      <View style={{ paddingTop: theme.spacing.lg, gap: theme.spacing.xs }}>
        <Text variant="displayMedium">Check what was read</Text>
        <Text variant="body" color="secondary">
          Every value below can be corrected. Nothing is saved until you add it.
        </Text>
      </View>

      {extraction ? (
        <ConfidenceNotice confidence={extraction.confidence} kind="label" />
      ) : null}

      {normalized.notes.length > 0 ? (
        <View style={{ gap: theme.spacing.xs }}>
          <Text variant="overline" color="secondary">
            What was converted
          </Text>
          {normalized.notes.map((note) => (
            <Text key={note} variant="caption" color="secondary">
              • {note}
            </Text>
          ))}
        </View>
      ) : null}

      {extraction ? <ScanWarnings warnings={extraction.warnings} /> : null}

      <TextField
        label="Name"
        value={draft.name}
        onChangeText={(value) => setDraft({ ...draft, name: value })}
        error={resolution?.fieldErrors.name}
        autoCapitalize="sentences"
      />
      <TextField
        label="Brand (optional)"
        value={draft.brand}
        onChangeText={(value) => setDraft({ ...draft, brand: value })}
        autoCapitalize="sentences"
      />

      <BasisPicker
        value={draft.baseUnit}
        onChange={(baseUnit) => setDraft({ ...draft, baseUnit })}
      />

      <NutrientFieldset
        draft={draft.nutrients}
        errors={resolution?.fieldErrors ?? {}}
        basisLabel={`Per 100 ${draft.baseUnit}`}
        missing={normalized.missing}
        onChange={editNutrient}
      />

      <View style={{ gap: theme.spacing.md }}>
        <Text variant="overline" color="secondary">
          Serving on the packet (optional)
        </Text>
        <TextField
          label={`Serving size (${draft.baseUnit})`}
          value={draft.servingAmount}
          onChangeText={(value) => setDraft({ ...draft, servingAmount: value })}
          keyboardType="decimal-pad"
          inputMode="decimal"
          error={resolution?.fieldErrors.servingAmount}
        />
        <TextField
          label="Serving name"
          value={draft.servingLabel}
          onChangeText={(value) => setDraft({ ...draft, servingLabel: value })}
          placeholder="1 biscuit, 1 slice…"
        />
        <TextField
          label="Barcode (optional)"
          value={draft.barcode}
          onChangeText={(value) => setDraft({ ...draft, barcode: value })}
          keyboardType="number-pad"
          inputMode="numeric"
          error={resolution?.fieldErrors.barcode}
          hint="Attaching it means the next scan of this packet finds it instantly."
        />
      </View>

      <BlockingProblems problems={resolution?.problems ?? []} />

      {candidate && chosen ? (
        <>
          <ServingSelector
            food={{ baseUnit: candidate.baseUnit, baseAmount: candidate.baseAmount }}
            nutrition={candidate.nutrition}
            servings={servings}
            onChange={setSelection}
          />

          <MealPicker value={meal} onChange={setMeal} />

          <SaveToggle value={saveToCatalogue} onChange={setSaveToCatalogue} />

          {saveError ? (
            <Text variant="caption" color="danger" accessibilityLiveRegion="polite">
              {saveError.message}
            </Text>
          ) : null}

          <Button
            label={`Add to ${describeDay(targetDay, today).toLowerCase()}`}
            loading={isSaving}
            onPress={() => {
              if (!userId || isSaving) return;
              setIsSaving(true);
              setSaveError(null);

              void confirmScannedFood({
                candidate,
                // Read off a printed panel, then checked by a person. That is
                // the user's own data, not an AI estimate — and it is
                // certainly not USDA or Open Food Facts.
                source: 'user',
                saveToCatalogue,
              })
                .then((outcome) => {
                  logFood({
                    meal,
                    food: outcome.food,
                    nutrition: candidate.nutrition,
                    quantity: chosen.quantity,
                    serving: chosen.serving,
                    timeZone,
                    diaryDate: targetDay,
                  });

                  if (outcome.catalogueError) {
                    // The entry is in the diary; only the reusable copy
                    // failed. Saying so is more useful than a silent partial
                    // success, and the diary entry is already safe.
                    logger.warn('Scanned food logged but not saved to catalogue', {
                      reason: outcome.catalogueError.code,
                    });
                  }

                  router.replace('/(tabs)/diary');
                })
                .catch((cause: unknown) => {
                  setIsSaving(false);
                  logger.error('Could not log scanned label', {
                    reason: cause instanceof Error ? cause.message : 'unknown',
                  });
                  setSaveError(
                    appError('unknown', 'That could not be added. Try again.', {
                      code: 'log_failed',
                      retryable: true,
                    }),
                  );
                });
            }}
          />
        </>
      ) : (
        <Text variant="caption" color="muted">
          Fill in what is missing above and the portion picker will appear.
        </Text>
      )}

      <Button
        label="Take a different photo"
        variant="ghost"
        onPress={() => {
          setDraft(null);
          setExtraction(null);
          setSelection(null);
          analysis.reset();
        }}
      />
    </Screen>
  );
}

/**
 * Whether the panel is per 100 g or per 100 ml.
 *
 * Offered rather than inferred beyond the model's read, because g and ml are
 * not interchangeable and there is no density to convert with — a drink
 * mislabelled as grams produces portions that are wrong by whatever its
 * density is, quietly, forever.
 */
function BasisPicker({
  value,
  onChange,
}: {
  value: 'g' | 'ml' | 'item';
  onChange: (unit: 'g' | 'ml') => void;
}) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="overline" color="secondary">
        Measured in
      </Text>
      <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
        {(['g', 'ml'] as const).map((unit) => {
          const selected = unit === value;
          return (
            <Text
              key={unit}
              variant="callout"
              color={selected ? 'accent' : 'secondary'}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={unit === 'g' ? 'Grams' : 'Millilitres'}
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
              {unit === 'g' ? 'Grams (100 g)' : 'Millilitres (100 ml)'}
            </Text>
          );
        })}
      </View>
    </View>
  );
}

/** Whether to keep the food for next time, as well as logging it now. */
function SaveToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const theme = useTheme();

  return (
    <Card>
      <Text
        variant="callout"
        accessibilityRole="checkbox"
        accessibilityState={{ checked: value }}
        accessibilityHint="Saves this as one of your own foods so you can log it again without scanning."
        onPress={() => onChange(!value)}
        style={{ paddingVertical: theme.spacing.xs }}
      >
        {value ? '☑' : '☐'}  Also save it to my foods
      </Text>
      <Text variant="caption" color="muted">
        Needs a connection. If it fails, the diary entry is still added.
      </Text>
    </Card>
  );
}

function asMeal(value: string | undefined): MealSlot | null {
  return value === 'breakfast' || value === 'lunch' || value === 'dinner' || value === 'snack'
    ? value
    : null;
}
