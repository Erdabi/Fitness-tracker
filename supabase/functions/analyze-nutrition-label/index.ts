import { authenticate, serviceClient } from '../_shared/auth.ts';
import { analyzeImage } from '../_shared/claude.ts';
import { analyzeRequestSchema, labelExtractionSchema } from '../_shared/contract.ts';
import { decodedByteLength, validateImage } from '../_shared/images.ts';
import { LABEL_INSTRUCTION, LABEL_SYSTEM } from '../_shared/prompts.ts';
import { checkQuota, recordScan } from '../_shared/quota.ts';
import {
  CORS_HEADERS,
  classifyProviderError,
  describeError,
  fail,
  log,
  ok,
} from '../_shared/respond.ts';

/**
 * analyzeNutritionLabel.
 *
 * One of two deliberately separate operations. Reading printed numbers and
 * estimating from appearance are different jobs with different prompts,
 * different schemas and different confidence semantics; a single endpoint
 * taking a "mode" flag would blur both and make each harder to reason about.
 *
 * Order of work matters: authenticate, then validate the image, then check the
 * quota, and only then call the provider. Everything that can reject a request
 * cheaply happens before the thing that costs money.
 */
Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return fail('invalid_request');
  }

  const started = Date.now();
  const operation = 'analyzeNutritionLabel';

  const caller = await authenticate(request);
  if (!caller) {
    log({ operation, outcome: 'error', code: 'unauthorized' });
    return fail('unauthorized');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    log({ operation, userId: caller.userId, outcome: 'error', code: 'invalid_request' });
    return fail('invalid_request');
  }

  const parsed = analyzeRequestSchema.safeParse(body);
  if (!parsed.success) {
    log({ operation, userId: caller.userId, outcome: 'error', code: 'invalid_request' });
    return fail('invalid_request');
  }

  const { image } = parsed.data;
  const imageBytes = decodedByteLength(image.data);

  const imageProblem = validateImage(image.data, image.mediaType);
  if (imageProblem) {
    const code =
      imageProblem.code === 'too_large'
        ? 'image_too_large'
        : imageProblem.code === 'unsupported_media_type'
          ? 'unsupported_media_type'
          : 'invalid_request';

    log({ operation, userId: caller.userId, outcome: 'error', code, imageBytes });
    return fail(code, imageProblem.message);
  }

  const service = serviceClient();
  if (!service) {
    log({ operation, userId: caller.userId, outcome: 'error', code: 'internal' });
    return fail('internal');
  }

  const quota = await checkQuota(service, caller.userId);
  if (!quota.allowed) {
    log({
      operation,
      userId: caller.userId,
      outcome: 'error',
      code: 'rate_limited',
      detail: `${quota.used}/${quota.limit}`,
    });
    return fail('rate_limited');
  }

  try {
    const result = await analyzeImage({
      system: LABEL_SYSTEM,
      instruction: LABEL_INSTRUCTION,
      image: { data: image.data, mediaType: image.mediaType },
      schema: labelExtractionSchema,
    });

    await recordScan(service, {
      userId: caller.userId,
      operation,
      outcome: result.value.status,
      imageBytes,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });

    log({
      operation,
      userId: caller.userId,
      outcome: 'ok',
      durationMs: Date.now() - started,
      imageBytes,
      status: result.value.status,
      confidence: result.value.confidence,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });

    return ok(result.value);
  } catch (error) {
    const code =
      (error as { name?: string }).name === 'SchemaMismatch'
        ? 'invalid_model_output'
        : classifyProviderError(error);

    log({
      operation,
      userId: caller.userId,
      outcome: 'error',
      code,
      durationMs: Date.now() - started,
      imageBytes,
      // The provider's own text, for operators. Never sent to the app.
      detail: describeError(error),
    });

    return fail(code);
  }
});
