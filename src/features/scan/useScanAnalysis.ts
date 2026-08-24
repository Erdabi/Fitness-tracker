import { useCallback, useState } from 'react';

import { getAIProvider } from '@/features/ai/provider';
import type { ScanImage } from '@/features/ai/provider';
import type { LabelExtraction, MealEstimation } from '@/features/ai/schemas';
import type { AppError } from '@/lib/result';

/**
 * Running one analysis.
 *
 * Goes through `getAIProvider()` rather than importing the Edge provider
 * directly, so tests inject a stub and the app has exactly one place where a
 * provider is chosen. There is no queue and no retry loop here on purpose: an
 * AI scan is a foreground action a user is watching, and quietly retrying a
 * paid request they may have walked away from is the wrong default. Failure
 * surfaces immediately with a Try again button.
 */

export type AnalysisPhase = 'idle' | 'analyzing' | 'done' | 'failed';

export interface AnalysisState<T> {
  readonly phase: AnalysisPhase;
  readonly result: T | null;
  readonly error: AppError | null;
}

function initial<T>(): AnalysisState<T> {
  return { phase: 'idle', result: null, error: null };
}

export function useLabelAnalysis() {
  return useAnalysis<LabelExtraction>((image) =>
    getAIProvider().analyzeNutritionLabel(image),
  );
}

export function usePhotoAnalysis() {
  return useAnalysis<MealEstimation>((image) =>
    getAIProvider().analyzeFoodPhoto(image),
  );
}

function useAnalysis<T>(
  run: (image: ScanImage) => Promise<
    { ok: true; value: T } | { ok: false; error: AppError }
  >,
) {
  const [state, setState] = useState<AnalysisState<T>>(initial<T>());

  const analyze = useCallback(
    async (image: ScanImage) => {
      setState({ phase: 'analyzing', result: null, error: null });

      const outcome = await run(image);

      setState(
        outcome.ok
          ? { phase: 'done', result: outcome.value, error: null }
          : { phase: 'failed', result: null, error: outcome.error },
      );

      return outcome;
    },
    [run],
  );

  const reset = useCallback(() => setState(initial<T>()), []);

  return { ...state, analyze, reset };
}
