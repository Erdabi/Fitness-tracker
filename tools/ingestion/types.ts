/**
 * Canonical shapes the ingestion pipeline produces.
 *
 * Every source adapter converts its own format into these, so the pipeline,
 * the deduplication logic and the sink never know whether a record came from
 * USDA or Open Food Facts. Adding a third source means writing one adapter,
 * not touching the pipeline.
 */

export type SourceId = 'usda' | 'openfoodfacts' | 'user' | 'ai_estimated';
export type BaseUnit = 'g' | 'ml' | 'item';
export type FoodKind = 'generic' | 'branded' | 'packaged';
export type BarcodeFormat = 'ean13' | 'ean8' | 'upca' | 'upce' | 'other';

/** Values for exactly `baseAmount` of `baseUnit`. */
export interface CanonicalNutrition {
  calories: number;
  protein_g: number;
  carbohydrates_g: number;
  fat_g: number;
  /**
   * Null means the source did not report it, which is not the same as zero
   * and must never be rendered as zero.
   */
  fiber_g: number | null;
  sugar_g: number | null;
  saturated_fat_g: number | null;
  sodium_mg: number | null;
  /** Anything beyond the core eight, keyed by a stable slug. */
  micronutrients: Record<string, number>;
}

export interface CanonicalServing {
  label: string;
  /** Gram/ml equivalent. Servings without one are dropped, never guessed. */
  amount: number;
  unit: BaseUnit;
  isDefault: boolean;
}

export interface CanonicalBarcode {
  barcode: string;
  format: BarcodeFormat;
}

export interface CanonicalBrand {
  name: string;
  normalizedName: string;
}

export interface CanonicalFood {
  sourceId: SourceId;
  /** The source's own identifier. The key that makes re-import idempotent. */
  externalId: string;

  name: string;
  normalizedName: string;
  brand: CanonicalBrand | null;
  kind: FoodKind;

  baseUnit: BaseUnit;
  baseAmount: number;

  nutrition: CanonicalNutrition;
  servings: CanonicalServing[];
  barcodes: CanonicalBarcode[];

  sourceUrl: string | null;
  /** When the source last changed this record, if it says. */
  sourceUpdatedAt: string | null;
}

/**
 * A parse either yields a food or explains why it did not.
 *
 * Rejections are values rather than exceptions: a single malformed row in a
 * two-million-row export must not end the import, and the reasons are what
 * make an import report useful.
 */
export type ParseResult =
  | { ok: true; food: CanonicalFood }
  | { ok: false; reason: RejectionReason; detail?: string };

export type RejectionReason =
  | 'missing_id'
  | 'missing_name'
  | 'missing_nutrition'
  | 'implausible_nutrition'
  | 'unknown_unit'
  | 'malformed_record';

export interface SourceAdapter<TRaw = unknown> {
  readonly sourceId: SourceId;
  /** Human-readable, used in import reports. */
  readonly label: string;
  parse(raw: TRaw): ParseResult;
}
