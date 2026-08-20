import { runImport, type CatalogSink, type ExistingFood } from '../pipeline';
import { decideMerge, mayReplace, SOURCE_QUALITY } from '../quality';
import type { CanonicalFood, ParseResult, SourceAdapter, SourceId } from '../types';

/** In-memory catalogue, modelling the uniqueness the database enforces. */
function createFakeSink() {
  const byKey = new Map<string, { id: string; food: CanonicalFood }>();
  const nutritionSource = new Map<string, SourceId>();
  let nextId = 1;

  const key = (source: SourceId, externalId: string) => `${source}:${externalId}`;

  const sink: CatalogSink & {
    all: () => CanonicalFood[];
    setNutritionSource: (id: string, source: SourceId) => void;
    failNextInsert: () => void;
  } = {
    async findByExternalId(source, externalId): Promise<ExistingFood | null> {
      const found = byKey.get(key(source, externalId));
      if (!found) return null;
      return {
        id: found.id,
        nutritionSource: nutritionSource.get(found.id) ?? found.food.sourceId,
        sourceUpdatedAt: found.food.sourceUpdatedAt,
      };
    },

    async insert(food) {
      if (shouldFailInsert) {
        shouldFailInsert = false;
        throw new Error('constraint violation');
      }
      const id = `food-${nextId++}`;
      byKey.set(key(food.sourceId, food.externalId), { id, food });
      nutritionSource.set(id, food.sourceId);
      return id;
    },

    async replace(id, food) {
      byKey.set(key(food.sourceId, food.externalId), { id, food });
      nutritionSource.set(id, food.sourceId);
    },

    all: () => [...byKey.values()].map((entry) => entry.food),
    setNutritionSource: (id, source) => nutritionSource.set(id, source),
    failNextInsert: () => {
      shouldFailInsert = true;
    },
  };

  let shouldFailInsert = false;
  return sink;
}

/** Minimal adapter: the record already is the canonical food, or a reason. */
const stubAdapter: SourceAdapter<CanonicalFood | { bad: true }> = {
  sourceId: 'usda',
  label: 'stub',
  parse(raw): ParseResult {
    if (raw && typeof raw === 'object' && 'bad' in raw) {
      return { ok: false, reason: 'malformed_record' };
    }
    return { ok: true, food: raw as CanonicalFood };
  },
};

function food(overrides: Partial<CanonicalFood> = {}): CanonicalFood {
  return {
    sourceId: 'usda',
    externalId: '1',
    name: 'Oats',
    normalizedName: 'oats',
    brand: null,
    kind: 'generic',
    baseUnit: 'g',
    baseAmount: 100,
    nutrition: {
      calories: 379,
      protein_g: 13,
      carbohydrates_g: 68,
      fat_g: 6,
      fiber_g: 10,
      sugar_g: 1,
      saturated_fat_g: 1,
      sodium_mg: 6,
      micronutrients: {},
    },
    servings: [],
    barcodes: [],
    sourceUrl: null,
    sourceUpdatedAt: null,
    ...overrides,
  };
}

describe('runImport', () => {
  it('inserts new records', async () => {
    const sink = createFakeSink();

    const report = await runImport(
      stubAdapter,
      [food({ externalId: '1' }), food({ externalId: '2' })],
      sink,
    );

    expect(report.read).toBe(2);
    expect(report.inserted).toBe(2);
    expect(report.replaced).toBe(0);
    expect(sink.all()).toHaveLength(2);
  });

  /**
   * The central guarantee of the pipeline: an import is safe to re-run. A
   * second pass over the same export must update rather than duplicate.
   */
  it('is idempotent across runs', async () => {
    const sink = createFakeSink();
    const records = [food({ externalId: '1' }), food({ externalId: '2' })];

    await runImport(stubAdapter, records, sink);
    const second = await runImport(stubAdapter, records, sink);

    expect(second.inserted).toBe(0);
    expect(second.replaced).toBe(2);
    expect(sink.all()).toHaveLength(2);
  });

  it('deduplicates a record repeated within one export', async () => {
    const sink = createFakeSink();

    const report = await runImport(
      stubAdapter,
      [food({ externalId: '1' }), food({ externalId: '1' })],
      sink,
    );

    expect(report.inserted).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.reasons.duplicate_in_batch).toBe(1);
    expect(sink.all()).toHaveLength(1);
  });

  it('records rejections by reason instead of failing the run', async () => {
    const sink = createFakeSink();

    const report = await runImport(
      stubAdapter,
      [food({ externalId: '1' }), { bad: true }, food({ externalId: '2' })],
      sink,
    );

    expect(report.inserted).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.reasons.malformed_record).toBe(1);
  });

  /** One bad row in a two-million-row export must not end the import. */
  it('survives a sink failure and keeps going', async () => {
    const sink = createFakeSink();
    sink.failNextInsert();

    const report = await runImport(
      stubAdapter,
      [food({ externalId: '1' }), food({ externalId: '2' })],
      sink,
    );

    expect(report.inserted).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.externalId).toBe('1');
  });

  /**
   * The guarantee the whole quality strategy exists for: a weaker source must
   * not overwrite a stronger one.
   */
  it('refuses to let a weaker source overwrite a stronger one', async () => {
    const sink = createFakeSink();
    await runImport(stubAdapter, [food({ externalId: '1' })], sink);

    const offAdapter: SourceAdapter<CanonicalFood> = {
      sourceId: 'openfoodfacts',
      label: 'off',
      parse: (raw) => ({ ok: true, food: raw }),
    };

    // Same external id, arriving from a lower-ranked source.
    const sinkWithUsdaNutrition = {
      ...sink,
      findByExternalId: async (): Promise<ExistingFood> => ({
        id: 'food-1',
        nutritionSource: 'usda',
        sourceUpdatedAt: null,
      }),
    };

    const report = await runImport(
      offAdapter,
      [food({ sourceId: 'openfoodfacts', externalId: '1', name: 'Worse Oats' })],
      sinkWithUsdaNutrition,
    );

    expect(report.replaced).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.reasons.skip_lower_quality).toBe(1);
  });

  it('honours a limit', async () => {
    const sink = createFakeSink();
    const many = Array.from({ length: 10 }, (_, i) => food({ externalId: String(i) }));

    const report = await runImport(stubAdapter, many, sink, { limit: 3 });

    expect(report.read).toBe(3);
    expect(sink.all()).toHaveLength(3);
  });

  it('writes nothing on a dry run', async () => {
    const sink = createFakeSink();

    const report = await runImport(stubAdapter, [food()], sink, { dryRun: true });

    expect(report.inserted).toBe(1);
    expect(sink.all()).toHaveLength(0);
  });

  it('reports progress', async () => {
    const sink = createFakeSink();
    const seen: number[] = [];
    const many = Array.from({ length: 5 }, (_, i) => food({ externalId: String(i) }));

    await runImport(stubAdapter, many, sink, {
      progressEvery: 2,
      onProgress: (read) => seen.push(read),
    });

    expect(seen).toEqual([2, 4]);
  });

  it('accepts an async iterable, as the streaming readers produce', async () => {
    const sink = createFakeSink();

    async function* stream() {
      yield food({ externalId: 'a' });
      yield food({ externalId: 'b' });
    }

    const report = await runImport(stubAdapter, stream(), sink);
    expect(report.inserted).toBe(2);
  });
});

describe('decideMerge', () => {
  it('inserts when nothing exists', () => {
    expect(
      decideMerge({
        incomingSource: 'usda',
        existing: null,
        incomingSourceUpdatedAt: null,
      }),
    ).toBe('insert');
  });

  it('lets a better source replace a weaker one regardless of dates', () => {
    expect(
      decideMerge({
        incomingSource: 'usda',
        existing: { source: 'ai_estimated', sourceUpdatedAt: '2030-01-01T00:00:00Z' },
        incomingSourceUpdatedAt: '2020-01-01T00:00:00Z',
      }),
    ).toBe('replace');
  });

  it('refuses a weaker source', () => {
    expect(
      decideMerge({
        incomingSource: 'ai_estimated',
        existing: { source: 'usda', sourceUpdatedAt: null },
        incomingSourceUpdatedAt: null,
      }),
    ).toBe('skip_lower_quality');
  });

  it('skips an unchanged record from the same source', () => {
    expect(
      decideMerge({
        incomingSource: 'usda',
        existing: { source: 'usda', sourceUpdatedAt: '2026-01-01T00:00:00Z' },
        incomingSourceUpdatedAt: '2026-01-01T00:00:00Z',
      }),
    ).toBe('skip_unchanged');
  });

  it('replaces when the same source reports a newer revision', () => {
    expect(
      decideMerge({
        incomingSource: 'usda',
        existing: { source: 'usda', sourceUpdatedAt: '2026-01-01T00:00:00Z' },
        incomingSourceUpdatedAt: '2026-06-01T00:00:00Z',
      }),
    ).toBe('replace');
  });

  it('replaces when neither side carries a revision date', () => {
    expect(
      decideMerge({
        incomingSource: 'usda',
        existing: { source: 'usda', sourceUpdatedAt: null },
        incomingSourceUpdatedAt: null,
      }),
    ).toBe('replace');
  });
});

describe('mayReplace', () => {
  it('ranks verified sources above estimates', () => {
    expect(mayReplace('usda', 'ai_estimated')).toBe(true);
    expect(mayReplace('ai_estimated', 'usda')).toBe(false);
    expect(mayReplace('usda', 'openfoodfacts')).toBe(true);
    expect(mayReplace('openfoodfacts', 'usda')).toBe(false);
  });

  it('allows a source to refresh itself', () => {
    expect(mayReplace('usda', 'usda')).toBe(true);
  });
});

/**
 * The ranks here must match `food_sources.quality_rank`. The database is the
 * enforcement point; this copy only lets the importer skip writes that would
 * be refused. If they drift, the importer starts attempting writes that fail.
 */
describe('SOURCE_QUALITY', () => {
  it('matches the ranks seeded in 20260820000001_food_schema.sql', () => {
    expect(SOURCE_QUALITY).toEqual({
      usda: 100,
      openfoodfacts: 70,
      user: 60,
      ai_estimated: 10,
    });
  });
});
