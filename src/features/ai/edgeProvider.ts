import { supabase } from '@/api/supabase';
import { appError, err, ok, type AppError, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { AIProvider, ScanImage } from './provider';
import {
  labelExtractionSchema,
  mealEstimationSchema,
  type LabelExtraction,
  type MealEstimation,
} from './schemas';

/**
 * The Edge Function-backed provider.
 *
 * This is the app's *entire* relationship with the model: it names a function
 * and hands it an image. There is no API key here, no provider SDK, no model
 * name and no prompt — all of that lives server-side, where the key is. A
 * change of provider is a change to the function, and this file does not move.
 *
 * The response is re-validated against the same schema the function validated
 * against. That is not redundant: the function is one deployment and the app
 * another, and a version skew between them should surface as a typed error
 * rather than as undefined fields halfway through a review screen.
 */

const FUNCTIONS = {
  label: 'analyze-nutrition-label',
  photo: 'analyze-food-photo',
} as const;

/** The error shape the functions return. See `_shared/respond.ts`. */
interface FunctionError {
  readonly error?: { readonly code?: string; readonly message?: string };
}

export function createEdgeAIProvider(client = supabase): AIProvider {
  return {
    analyzeNutritionLabel: (image) =>
      invoke(client, FUNCTIONS.label, image, labelExtractionSchema, 'label'),
    analyzeFoodPhoto: (image) =>
      invoke(client, FUNCTIONS.photo, image, mealEstimationSchema, 'photo'),
  };
}

async function invoke<T>(
  client: typeof supabase,
  name: string,
  image: ScanImage,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } },
  kind: 'label' | 'photo',
): Promise<Result<T>> {
  try {
    const { data, error } = await client.functions.invoke(name, {
      body: { image: { data: image.data, mediaType: image.mediaType } },
    });

    if (error) {
      return err(await translateInvokeError(error, kind));
    }

    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      /*
       * The function validated before responding, so reaching here means the
       * two sides disagree about the contract — a deployment skew. Logged
       * without the payload, which is somebody's shopping.
       */
      logger.error('AI response did not match the client contract', { function: name });
      return err(
        appError('server', 'The result could not be read reliably. Try again.', {
          code: 'invalid_ai_response',
          retryable: true,
        }),
      );
    }

    return ok(parsed.data as T);
  } catch (cause) {
    /*
     * `functions.invoke` throws rather than returning an error when the
     * request never left the device — which is what being offline looks like.
     */
    logger.warn('AI request failed before reaching the server', {
      reason: cause instanceof Error ? cause.name : 'unknown',
    });
    return err(offlineError(kind));
  }
}

/**
 * Turns a function's error response into something the UI can act on.
 *
 * The body carries a code chosen server-side from a fixed set; the provider's
 * own text never appears in it. Anything unrecognised falls through to a
 * generic retryable error rather than being shown raw.
 */
async function translateInvokeError(
  error: unknown,
  kind: 'label' | 'photo',
): Promise<AppError> {
  const body = await readErrorBody(error);
  const code = body?.error?.code;

  switch (code) {
    case 'unauthorized':
      return appError('auth', 'Sign in to use scanning.', {
        code,
        retryable: false,
      });
    case 'rate_limited':
      return appError('server', "You've reached today's scanning limit.", {
        code,
        retryable: false,
      });
    case 'image_too_large':
      return appError('validation', 'That image is too large. Try a smaller photo.', {
        code,
        retryable: false,
      });
    case 'unsupported_media_type':
      return appError('validation', 'Images must be JPEG, PNG or WebP.', {
        code,
        retryable: false,
      });
    case 'invalid_model_output':
      return appError(
        'server',
        kind === 'label'
          ? 'That label could not be read reliably. Try a straighter, closer photo.'
          : 'That photo could not be analysed reliably. Try again with more of the plate visible.',
        { code, retryable: true },
      );
    case 'provider_timeout':
      return appError('server', 'That took too long to analyse. Try again.', {
        code,
        retryable: true,
      });
    case 'provider_unavailable':
      return appError('server', 'Scanning is unavailable right now. Try again shortly.', {
        code,
        retryable: true,
      });
    default:
      return appError('server', 'Scanning failed. Try again.', {
        code: 'ai_failed',
        retryable: true,
      });
  }
}

/**
 * Reads the JSON body off a FunctionsHttpError.
 *
 * supabase-js puts the failing `Response` on `error.context`; older shapes put
 * the parsed body there directly. Both are handled, and anything else yields
 * null rather than throwing inside an error path.
 */
async function readErrorBody(error: unknown): Promise<FunctionError | null> {
  const context = (error as { context?: unknown } | null)?.context;
  if (!context) return null;

  if (typeof (context as Response).json === 'function') {
    try {
      return (await (context as Response).json()) as FunctionError;
    } catch {
      return null;
    }
  }

  return typeof context === 'object' ? (context as FunctionError) : null;
}

function offlineError(kind: 'label' | 'photo'): AppError {
  return appError(
    'network',
    kind === 'label'
      ? 'Reading a nutrition label needs an internet connection. You can still enter the food by hand.'
      : 'Analysing a photo needs an internet connection. You can still search for the food or enter it by hand.',
    { code: 'ai_offline', retryable: true },
  );
}

export type { LabelExtraction, MealEstimation };
