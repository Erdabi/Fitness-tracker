import { act, renderHook } from '@testing-library/react-native';

import {
  notImplementedProvider,
  setAIProvider,
  type AIProvider,
  type ScanImage,
} from '@/features/ai/provider';
import type { LabelExtraction, MealEstimation } from '@/features/ai/schemas';
import { appError, err, ok } from '@/lib/result';
import { useLabelAnalysis, usePhotoAnalysis } from '../useScanAnalysis';

/**
 * Running one analysis.
 *
 * The behaviour worth pinning down is the absence of one: there is no queue
 * and no retry loop. A scan is a foreground action somebody is watching, and
 * silently repeating a paid request after they have walked away is the wrong
 * default — so a failure has to arrive as a failure.
 */

const image: ScanImage = { data: 'AAAA', mediaType: 'image/jpeg', byteLength: 3 };

const LABEL = {
  status: 'success',
  confidence: 'high',
  productName: 'Rolled oats',
  brand: null,
  servingSize: null,
  servingsPerContainer: null,
  basis: 'per_100g',
  nutrients: {
    energy: { kcal: 379, kj: null },
    protein_g: 13.2,
    carbohydrates_g: 67.7,
    sugars_g: 1,
    fiber_g: 10.1,
    fat_g: 6.5,
    saturated_fat_g: 1.1,
    sodium_mg: 6,
    salt_g: null,
  },
  barcode: null,
  warnings: [],
} as LabelExtraction;

const MEAL = {
  status: 'success',
  confidence: 'medium',
  items: [],
  warnings: [],
} as MealEstimation;

function stubProvider(overrides: Partial<AIProvider>): jest.Mock {
  const label = jest.fn(async () => ok(LABEL));
  setAIProvider({
    analyzeNutritionLabel: label as never,
    analyzeFoodPhoto: async () => ok(MEAL),
    ...overrides,
  });
  return label;
}

afterEach(() => setAIProvider(notImplementedProvider));

describe('useLabelAnalysis', () => {
  it('starts idle with nothing to show', () => {
    stubProvider({});
    const { result } = renderHook(() => useLabelAnalysis());

    expect(result.current.phase).toBe('idle');
    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('reaches done with the extraction', async () => {
    stubProvider({});
    const { result } = renderHook(() => useLabelAnalysis());

    await act(async () => {
      await result.current.analyze(image);
    });

    expect(result.current.phase).toBe('done');
    expect(result.current.result?.productName).toBe('Rolled oats');
  });

  it('goes through the injected provider, never a provider of its own', async () => {
    const label = stubProvider({});
    const { result } = renderHook(() => useLabelAnalysis());

    await act(async () => {
      await result.current.analyze(image);
    });

    expect(label).toHaveBeenCalledWith(image);
  });

  it('surfaces a failure rather than retrying it', async () => {
    const failure = appError('server', 'Scanning failed.', {
      code: 'ai_failed',
      retryable: true,
    });
    const label = jest.fn(async () => err(failure));
    stubProvider({ analyzeNutritionLabel: label as never });

    const { result } = renderHook(() => useLabelAnalysis());
    await act(async () => {
      await result.current.analyze(image);
    });

    expect(result.current.phase).toBe('failed');
    expect(result.current.error).toBe(failure);
    // Once. A paid request is not repeated behind the user's back.
    expect(label).toHaveBeenCalledTimes(1);
  });

  it('clears a failure on reset so a retry starts clean', async () => {
    stubProvider({
      analyzeNutritionLabel: (async () =>
        err(appError('server', 'nope', { code: 'x', retryable: true }))) as never,
    });

    const { result } = renderHook(() => useLabelAnalysis());
    await act(async () => {
      await result.current.analyze(image);
    });

    act(() => result.current.reset());

    expect(result.current.phase).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('drops a previous result the moment a new analysis starts', async () => {
    stubProvider({});
    const { result } = renderHook(() => useLabelAnalysis());

    await act(async () => {
      await result.current.analyze(image);
    });
    expect(result.current.result).not.toBeNull();

    // A stale result showing under a new spinner is how somebody saves the
    // wrong food.
    let resolve: (() => void) | null = null;
    stubProvider({
      analyzeNutritionLabel: (async () => {
        await new Promise<void>((done) => {
          resolve = done;
        });
        return ok(LABEL);
      }) as never,
    });

    const { result: second } = renderHook(() => useLabelAnalysis());
    act(() => {
      void second.current.analyze(image);
    });

    expect(second.current.phase).toBe('analyzing');
    expect(second.current.result).toBeNull();

    await act(async () => {
      resolve?.();
    });
  });
});

describe('usePhotoAnalysis', () => {
  it('calls the photo side of the provider', async () => {
    const photo = jest.fn(async () => ok(MEAL));
    stubProvider({ analyzeFoodPhoto: photo as never });

    const { result } = renderHook(() => usePhotoAnalysis());
    await act(async () => {
      await result.current.analyze(image);
    });

    expect(photo).toHaveBeenCalledWith(image);
    expect(result.current.result?.items).toEqual([]);
  });

  it('fails loudly when no provider has been registered', async () => {
    setAIProvider(notImplementedProvider);
    const { result } = renderHook(() => usePhotoAnalysis());

    await act(async () => {
      await result.current.analyze(image);
    });

    expect(result.current.phase).toBe('failed');
    expect(result.current.error?.code).toMatch(/not_implemented/);
  });
});
