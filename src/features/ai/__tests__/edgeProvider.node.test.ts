import { createEdgeAIProvider } from '../edgeProvider';
import type { ScanImage } from '../provider';

// The module reads `supabase` only as a default argument; every test injects
// its own client. Stubbed so the node project does not have to load the
// React Native client just to reach a function that is never called.
jest.mock('@/api/supabase', () => ({ supabase: {} }));

/**
 * The client half of the AI boundary.
 *
 * Two things are being tested and neither is the model: that a failure from
 * the server becomes a specific, actionable error rather than raw provider
 * text, and that a response which does not match the contract is refused even
 * though the server said it was fine.
 */

const image: ScanImage = {
  data: Buffer.from('not really a jpeg').toString('base64'),
  mediaType: 'image/jpeg',
  byteLength: 17,
};

const validLabel = {
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
};

/** A minimal stand-in for the parts of supabase-js this file touches. */
function clientReturning(response: {
  data?: unknown;
  error?: unknown;
  throws?: unknown;
}) {
  const invoke = jest.fn(async () => {
    if (response.throws) throw response.throws;
    return { data: response.data ?? null, error: response.error ?? null };
  });

  return {
    client: { functions: { invoke } } as never,
    invoke,
  };
}

/** Mimics the FunctionsHttpError shape: the failing Response on `.context`. */
const httpError = (code: string, status = 400) => ({
  name: 'FunctionsHttpError',
  context: {
    status,
    json: async () => ({ error: { code, message: 'server-side wording' } }),
  },
});

describe('createEdgeAIProvider', () => {
  it('sends only the image, never a key or a model name', async () => {
    const { client, invoke } = clientReturning({ data: validLabel });

    await createEdgeAIProvider(client).analyzeNutritionLabel(image);

    expect(invoke).toHaveBeenCalledWith('analyze-nutrition-label', {
      body: { image: { data: image.data, mediaType: 'image/jpeg' } },
    });

    const sent = JSON.stringify(invoke.mock.calls[0]);
    expect(sent).not.toMatch(/anthropic/i);
    expect(sent).not.toMatch(/api[_-]?key/i);
    expect(sent).not.toMatch(/claude/i);
  });

  it('returns a validated extraction on success', async () => {
    const { client } = clientReturning({ data: validLabel });

    const result = await createEdgeAIProvider(client).analyzeNutritionLabel(image);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.nutrients.energy.kcal).toBe(379);
  });

  it('refuses a response the contract does not accept, even with no error', async () => {
    const { client } = clientReturning({
      data: { ...validLabel, nutrients: { ...validLabel.nutrients, protein_g: 'lots' } },
    });

    const result = await createEdgeAIProvider(client).analyzeNutritionLabel(image);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_ai_response');
  });

  it('refuses a response that is missing fields entirely', async () => {
    const { client } = clientReturning({ data: { status: 'success' } });

    const result = await createEdgeAIProvider(client).analyzeNutritionLabel(image);
    expect(result.ok).toBe(false);
  });

  it('treats an unauthenticated rejection as an auth error, not a retry', async () => {
    const { client } = clientReturning({ error: httpError('unauthorized', 401) });

    const result = await createEdgeAIProvider(client).analyzeNutritionLabel(image);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('auth');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('surfaces the daily limit as a non-retryable message', async () => {
    const { client } = clientReturning({ error: httpError('rate_limited', 429) });

    const result = await createEdgeAIProvider(client).analyzeNutritionLabel(image);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toMatch(/limit/i);
    }
  });

  it('never shows the provider’s own wording to the user', async () => {
    const { client } = clientReturning({ error: httpError('provider_unavailable', 503) });

    const result = await createEdgeAIProvider(client).analyzeNutritionLabel(image);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain('server-side wording');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('falls back to a generic retryable error for an unknown code', async () => {
    const { client } = clientReturning({ error: httpError('something_new', 500) });

    const result = await createEdgeAIProvider(client).analyzeNutritionLabel(image);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ai_failed');
  });

  it('reports being offline as being offline, with a usable alternative', async () => {
    const { client } = clientReturning({ throws: new TypeError('Network request failed') });

    const result = await createEdgeAIProvider(client).analyzeFoodPhoto(image);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('network');
      expect(result.error.message).toMatch(/by hand|search/i);
    }
  });

  it('calls the photo function for a photo', async () => {
    const { client, invoke } = clientReturning({
      data: { status: 'success', confidence: 'high', items: [], warnings: [] },
    });

    await createEdgeAIProvider(client).analyzeFoodPhoto(image);

    expect(invoke).toHaveBeenCalledWith('analyze-food-photo', expect.anything());
  });
});
