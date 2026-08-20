import { lookupBarcode, listRecentFoods, searchFoods } from '../searchService';

// The `mock` prefix is required: jest.mock factories are hoisted above the
// declarations, so only mock-prefixed names may be referenced from inside one.
const mockRpc = jest.fn();
jest.mock('@/api/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));

/** A row as PostgREST delivers it: numerics arrive as strings. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    food_id: 'food-1',
    name: 'Apple',
    brand_name: null,
    source_id: 'usda',
    is_verified: true,
    is_own: false,
    base_unit: 'g',
    base_amount: '100',
    calories: '52.00',
    protein_g: '0.300',
    carbohydrates_g: '13.800',
    fat_g: '0.200',
    serving_label: '1 medium',
    serving_amount: '182.000',
    serving_unit: 'g',
    match_kind: 'exact_name',
    score: '735.5',
    ...overrides,
  };
}

beforeEach(() => mockRpc.mockReset());

describe('searchFoods', () => {
  /**
   * Postgres sends `numeric` as a string to avoid float precision loss. If the
   * boundary did not convert, every downstream calculation would do string
   * concatenation instead of arithmetic.
   */
  it('converts numeric strings to numbers at the boundary', async () => {
    mockRpc.mockResolvedValue({ data: [row()], error: null });

    const result = await searchFoods('apple');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const first = result.value.results[0]!;
    expect(first.calories).toBe(52);
    expect(first.baseAmount).toBe(100);
    expect(first.defaultServing).toEqual({ label: '1 medium', amount: 182, unit: 'g' });
    expect(typeof first.score).toBe('number');
  });

  /** The client normalises with the same rules that wrote normalized_name. */
  it('normalises the query before sending it', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    await searchFoods('  Crème Fraîche  ');

    expect(mockRpc).toHaveBeenCalledWith(
      'search_foods',
      expect.objectContaining({ p_query: 'creme fraiche' }),
    );
  });

  it('does not call the server for a query below the minimum length', async () => {
    const result = await searchFoods('a');

    expect(mockRpc).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.results).toEqual([]);
  });

  it('returns a cursor when the page is full', async () => {
    mockRpc.mockResolvedValue({
      data: Array.from({ length: 2 }, (_, i) => row({ food_id: `f${i}`, score: `${100 - i}` })),
      error: null,
    });

    const result = await searchFoods('apple', { limit: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.nextCursor).toEqual({ score: 99, foodId: 'f1' });
  });

  /** A short page means the end; offering another page would return nothing. */
  it('returns no cursor when the page is short', async () => {
    mockRpc.mockResolvedValue({ data: [row()], error: null });

    const result = await searchFoods('apple', { limit: 25 });
    if (!result.ok) throw new Error('expected success');
    expect(result.value.nextCursor).toBeNull();
  });

  it('passes a cursor through for the next page', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    await searchFoods('apple', { cursor: { score: 500, foodId: 'f9' } });

    expect(mockRpc).toHaveBeenCalledWith(
      'search_foods',
      expect.objectContaining({ p_cursor_score: 500, p_cursor_id: 'f9' }),
    );
  });

  /**
   * Offline must be distinguishable from broken: the UI tells the user that
   * search needs a connection while their recents still work.
   */
  it('reports a network failure as an offline condition', async () => {
    mockRpc.mockRejectedValue(new TypeError('Network request failed'));

    const result = await searchFoods('apple');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('network');
    expect(result.error.message).toMatch(/internet connection/i);
    expect(result.error.retryable).toBe(true);
  });

  it('reports a server error separately', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const result = await searchFoods('apple');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('server');
  });

  it('handles a null default serving', async () => {
    mockRpc.mockResolvedValue({
      data: [row({ serving_label: null, serving_amount: null, serving_unit: null })],
      error: null,
    });

    const result = await searchFoods('apple');
    if (!result.ok) throw new Error('expected success');
    expect(result.value.results[0]?.defaultServing).toBeNull();
  });
});

describe('lookupBarcode', () => {
  it('normalises before lookup and widens UPC-A', async () => {
    mockRpc.mockResolvedValue({ data: [{ result: row(), duplicate_count: 1 }], error: null });

    await lookupBarcode('012345678905');

    expect(mockRpc).toHaveBeenCalledWith(
      'lookup_barcode',
      expect.objectContaining({ p_barcode: '0012345678905' }),
    );
  });

  it('rejects an unusable barcode without a round trip', async () => {
    const result = await lookupBarcode('abc');

    expect(mockRpc).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('validation');
  });

  it('reports a miss as an empty result rather than an error', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });

    const result = await lookupBarcode('5000159484695');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toBeNull();
    expect(result.value.duplicateCount).toBe(0);
  });

  /** A duplicated barcode is a data fault the UI must be able to surface. */
  it('surfaces the duplicate count', async () => {
    mockRpc.mockResolvedValue({ data: [{ result: row(), duplicate_count: 3 }], error: null });

    const result = await lookupBarcode('5000159484695');
    if (!result.ok) throw new Error('expected success');
    expect(result.value.duplicateCount).toBe(3);
    expect(result.value.result?.name).toBe('Apple');
  });
});

describe('listRecentFoods', () => {
  it('requests the recent ordering by default', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await listRecentFoods();
    expect(mockRpc).toHaveBeenCalledWith(
      'list_recent_foods',
      expect.objectContaining({ p_order: 'recent' }),
    );
  });

  it('requests the frequent ordering when asked', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    await listRecentFoods('frequent', 5);
    expect(mockRpc).toHaveBeenCalledWith('list_recent_foods', {
      p_limit: 5,
      p_order: 'frequent',
    });
  });
});
