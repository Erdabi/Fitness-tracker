import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';

import { Button, Card, Screen, Text, TextField } from '@/components/ui';
import type { MealSlot } from '@/db/schema';
import type { MealEstimation } from '@/features/ai/schemas';
import { isUnusable } from '@/features/ai/schemas';
import { useAuth } from '@/features/auth/AuthProvider';
import { describeDay } from '@/features/diary/DayNavigator';
import { MealPicker, defaultMealFor } from '@/features/diary/MealPicker';
import { useDiaryMutations, useDiaryTimeZone, useToday } from '@/features/diary/useDiary';
import { NutrientFieldset } from '@/features/scan/NutrientFieldset';
import type { NutrientKey } from '@/features/scan/nutrientFields';
import {
  changeQuantity,
  draftsFromMeal,
  editNutrient,
  resolvePhotoDraft,
  type PhotoItemDraft,
} from '@/features/scan/photoDraft';
import {
  AnalyzingState,
  BlockingProblems,
  ConfidenceNotice,
  ScanErrorState,
  ScanWarnings,
} from '@/features/scan/ScanStates';
import { useImageCapture } from '@/features/scan/useImageCapture';
import { usePhotoAnalysis } from '@/features/scan/useScanAnalysis';
import { isLocalDay, type LocalDay } from '@/lib/date';
import { appError, type AppError } from '@/lib/result';
import { logger } from '@/lib/logger';
import { useTheme } from '@/theme';

/**
 * Photograph a meal, check the estimate, then log what is actually right.
 *
 * The whole screen exists to make one thing unmissable: these are estimates.
 * Every item carries its own confidence, low-confidence items start switched
 * off, and every number is editable before anything is written.
 *
 * Items are logged as separate diary entries, not as one "meal". That matches
 * how the diary already works, and it means correcting the rice later does not
 * disturb the chicken.
 */
export default function PhotoScanScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { userId } = useAuth();
  const timeZone = useDiaryTimeZone();
  const today = useToday();
  const { logFood } = useDiaryMutations();

  const { meal: mealParam, day: dayParam } = useLocalSearchParams<{
    meal?: string;
    day?: string;
  }>();

  const capture = useImageCapture();
  const analysis = usePhotoAnalysis();

  const [estimation, setEstimation] = useState<MealEstimation | null>(null);
  const [drafts, setDrafts] = useState<PhotoItemDraft[] | null>(null);
  const [meal, setMeal] = useState<MealSlot>(() =>
    asMeal(mealParam) ?? defaultMealFor(new Date(), timeZone),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<AppError | null>(null);

  const targetDay: LocalDay = dayParam && isLocalDay(dayParam) ? dayParam : today;

  const start = useCallback(
    async (source: 'camera' | 'library') => {
      const image = await capture.capture(source);
      if (!image || !image.ok) return;

      setSaveError(null);
      const outcome = await analysis.analyze(image.value);
      if (!outcome.ok) return;

      setEstimation(outcome.value);
      // An empty list is a legitimate answer — "I cannot tell what this is" —
      // and it must not become a review screen with nothing in it.
      setDrafts(outcome.value.items.length > 0 ? draftsFromMeal(outcome.value) : null);
    },
    [analysis, capture],
  );

  const editDraft = useCallback((key: string, patch: (draft: PhotoItemDraft) => PhotoItemDraft) => {
    setDrafts((current) =>
      current ? current.map((draft) => (draft.key === key ? patch(draft) : draft)) : current,
    );
  }, []);

  const reset = useCallback(() => {
    setDrafts(null);
    setEstimation(null);
    setSaveError(null);
    analysis.reset();
  }, [analysis]);

  const resolutions = useMemo(
    () => (drafts ?? []).map((draft) => ({ draft, resolved: resolvePhotoDraft(draft) })),
    [drafts],
  );

  const chosen = useMemo(
    () => resolutions.filter((entry) => entry.draft.include),
    [resolutions],
  );

  const blocked = chosen.some((entry) => entry.resolved.candidate === null);

  /* ------------------------------------------------------------- capturing */

  if (analysis.phase === 'analyzing') {
    return (
      <Screen>
        <AnalyzingState label="Looking at your meal" />
      </Screen>
    );
  }

  if (!drafts) {
    const error = analysis.error ?? capture.error;

    return (
      <Screen scrollable>
        <View style={{ paddingTop: theme.spacing.lg, gap: theme.spacing.xs }}>
          <Text variant="displayMedium">Photograph a meal</Text>
          <Text variant="body" color="secondary">
            You will get an estimate of what is on the plate and roughly how
            much. Portions from a photo are guesses — you check and correct them
            before anything is logged.
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
            onManual={() => router.replace('/food/custom')}
          />
        ) : null}

        {estimation && (isUnusable(estimation) || estimation.items.length === 0) ? (
          <Card>
            <Text variant="headline">Could not tell what that is</Text>
            <Text variant="body" color="secondary">
              {estimation.warnings[0] ??
                'Nothing identifiable was found in the photo. A clearer shot from above, with the whole plate in frame, works better.'}
            </Text>
            <Button
              label="Search for it instead"
              variant="secondary"
              onPress={() => router.replace('/food/search')}
            />
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

  return (
    <Screen scrollable keyboardAvoiding>
      <View style={{ paddingTop: theme.spacing.lg, gap: theme.spacing.xs }}>
        <Text variant="displayMedium">Check the estimate</Text>
        <Text variant="body" color="secondary">
          Turn off anything that is not there, correct the amounts, then add
          what is left.
        </Text>
      </View>

      {estimation ? (
        <>
          <ConfidenceNotice confidence={estimation.confidence} kind="photo" />
          <ScanWarnings warnings={estimation.warnings} />
        </>
      ) : null}

      {resolutions.map(({ draft, resolved }) => (
        <ItemCard
          key={draft.key}
          draft={draft}
          fieldErrors={resolved.fieldErrors}
          problems={resolved.problems}
          portionSummary={
            resolved.candidate
              ? `${Math.round(resolved.candidate.portion.calories)} kcal for this portion`
              : null
          }
          onToggle={() =>
            editDraft(draft.key, (current) => ({ ...current, include: !current.include }))
          }
          onName={(name) => editDraft(draft.key, (current) => ({ ...current, name }))}
          onQuantity={(quantity) =>
            editDraft(draft.key, (current) => changeQuantity(current, quantity))
          }
          onNutrient={(key, value) =>
            editDraft(draft.key, (current) => editNutrient(current, key, value))
          }
          onSearchInstead={() =>
            router.replace({
              pathname: '/food/search',
              params: { q: draft.name, meal, day: targetDay },
            })
          }
        />
      ))}

      <MealPicker value={meal} onChange={setMeal} />

      {saveError ? (
        <Text variant="caption" color="danger" accessibilityLiveRegion="polite">
          {saveError.message}
        </Text>
      ) : null}

      <Button
        label={
          chosen.length === 0
            ? 'Nothing selected'
            : `Add ${chosen.length === 1 ? 'this item' : `these ${chosen.length} items`} to ${describeDay(targetDay, today).toLowerCase()}`
        }
        disabled={chosen.length === 0 || blocked}
        loading={isSaving}
        onPress={() => {
          if (!userId || isSaving) return;
          setIsSaving(true);
          setSaveError(null);

          try {
            for (const entry of chosen) {
              const candidate = entry.resolved.candidate;
              if (!candidate) continue;

              logFood({
                meal,
                food: {
                  // No catalogue row. An estimate from a photograph is not a
                  // food anyone else should find in search, and the diary
                  // snapshot carries everything the entry needs. See
                  // `confirmScan.ts` for why this is sound.
                  foodId: null,
                  name: candidate.name,
                  brandName: null,
                  sourceId: 'ai_estimated',
                  isVerified: false,
                  baseUnit: candidate.unit,
                  baseAmount: candidate.baseAmount,
                },
                nutrition: candidate.nutrition,
                quantity: candidate.quantity,
                // The quantity is already in base units — "180 g" — so there
                // is no portion to resolve through.
                serving: null,
                timeZone,
                diaryDate: targetDay,
              });
            }

            router.replace('/(tabs)/diary');
          } catch (cause) {
            setIsSaving(false);
            logger.error('Could not log estimated meal', {
              reason: cause instanceof Error ? cause.message : 'unknown',
            });
            setSaveError(
              appError('unknown', 'Those items could not be added. Try again.', {
                code: 'log_failed',
                retryable: true,
              }),
            );
          }
        }}
      />

      {blocked ? (
        <Text variant="caption" color="danger">
          Fix the highlighted values on the selected items first.
        </Text>
      ) : null}

      <Button label="Take a different photo" variant="ghost" onPress={reset} />
    </Screen>
  );
}

/**
 * One estimated item.
 *
 * The include switch is the first control in the card and reads as a checkbox
 * to a screen reader, because deciding whether this food is on the plate at
 * all comes before deciding how much of it there was.
 */
function ItemCard({
  draft,
  fieldErrors,
  problems,
  portionSummary,
  onToggle,
  onName,
  onQuantity,
  onNutrient,
  onSearchInstead,
}: {
  draft: PhotoItemDraft;
  fieldErrors: Readonly<Partial<Record<NutrientKey | 'name' | 'quantity', string>>>;
  problems: readonly { field: string; message: string }[];
  portionSummary: string | null;
  onToggle: () => void;
  onName: (value: string) => void;
  onQuantity: (value: string) => void;
  onNutrient: (key: NutrientKey, value: string) => void;
  onSearchInstead: () => void;
}) {
  const theme = useTheme();

  const confidenceWord =
    draft.confidence === 'high'
      ? 'Fairly sure'
      : draft.confidence === 'medium'
        ? 'Not certain'
        : 'A guess';

  return (
    <Card>
      <Text
        variant="headline"
        accessibilityRole="checkbox"
        accessibilityState={{ checked: draft.include }}
        accessibilityLabel={`${draft.name}. ${confidenceWord}.`}
        accessibilityHint="Turns this item on or off for logging."
        onPress={onToggle}
        style={{ paddingVertical: theme.spacing.xs }}
      >
        {draft.include ? '☑' : '☐'}  {draft.name}
      </Text>

      <Text
        variant="caption"
        color={
          draft.confidence === 'high'
            ? 'success'
            : draft.confidence === 'medium'
              ? 'warning'
              : 'danger'
        }
      >
        {confidenceWord}
        {draft.confidence === 'low' ? ' — off by default, turn it on if it is right' : ''}
      </Text>

      {draft.include ? (
        <View style={{ gap: theme.spacing.md, marginTop: theme.spacing.sm }}>
          <TextField
            label="Name"
            value={draft.name}
            onChangeText={onName}
            error={fieldErrors.name}
            autoCapitalize="sentences"
          />

          <TextField
            label={draft.unit === 'item' ? 'How many' : `Amount (${draft.unit})`}
            value={draft.quantity}
            onChangeText={onQuantity}
            keyboardType="decimal-pad"
            inputMode="decimal"
            error={fieldErrors.quantity}
            hint="Changing this adjusts the nutrition with it."
          />

          <NutrientFieldset
            draft={draft.nutrients}
            errors={fieldErrors}
            basisLabel="For this portion"
            onChange={onNutrient}
          />

          <BlockingProblems problems={problems} />

          {portionSummary ? (
            <Text variant="caption" color="muted">
              {portionSummary}
            </Text>
          ) : null}

          <Text
            variant="caption"
            color="accent"
            accessibilityRole="button"
            accessibilityHint="Leaves this estimate and searches the food database instead."
            onPress={onSearchInstead}
          >
            Look this up in the food database instead
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

function asMeal(value: string | undefined): MealSlot | null {
  return value === 'breakfast' || value === 'lunch' || value === 'dinner' || value === 'snack'
    ? value
    : null;
}
