import type { SourceId } from './types';

/**
 * Source quality.
 *
 * Mirrors `food_sources.quality_rank` in the database. The database is the
 * enforcement point — `guard_nutrition_quality()` rejects a downgrade no
 * matter which client attempts it — and this copy exists so the importer can
 * avoid *attempting* writes that would be refused, and can report them as
 * deliberate skips rather than errors.
 *
 * A test asserts the two stay in step.
 */
export const SOURCE_QUALITY: Readonly<Record<SourceId, number>> = {
  usda: 100,
  openfoodfacts: 70,
  user: 60,
  ai_estimated: 10,
};

export type MergeDecision =
  /** No existing record; write it. */
  | 'insert'
  /** Existing record is same-or-lower quality and older; replace it. */
  | 'replace'
  /** Existing record is better; leave it alone. */
  | 'skip_lower_quality'
  /** Same source, nothing newer to say. */
  | 'skip_unchanged';

export interface MergeInput {
  readonly incomingSource: SourceId;
  readonly existing: {
    readonly source: SourceId;
    /** When the source last revised the stored record, if known. */
    readonly sourceUpdatedAt: string | null;
  } | null;
  readonly incomingSourceUpdatedAt: string | null;
}

/**
 * Decides what an importer should do with one record.
 *
 * The rule that matters: **never let a weaker source overwrite a stronger
 * one.** An Open Food Facts crowd-sourced entry must not replace a USDA
 * measurement, and an AI estimate must not replace either.
 */
export function decideMerge({
  incomingSource,
  existing,
  incomingSourceUpdatedAt,
}: MergeInput): MergeDecision {
  if (!existing) return 'insert';

  const incomingRank = SOURCE_QUALITY[incomingSource];
  const existingRank = SOURCE_QUALITY[existing.source];

  if (incomingRank < existingRank) return 'skip_lower_quality';

  // A better source always wins, regardless of dates: a measurement supersedes
  // an estimate even if the estimate was made yesterday.
  if (incomingRank > existingRank) return 'replace';

  // Same source refreshing itself. Only write when the source says the record
  // actually changed, so a re-run over an unchanged export is nearly free.
  if (incomingSourceUpdatedAt && existing.sourceUpdatedAt) {
    return Date.parse(incomingSourceUpdatedAt) > Date.parse(existing.sourceUpdatedAt)
      ? 'replace'
      : 'skip_unchanged';
  }

  // Without timestamps there is no way to tell; take the newer fetch.
  return 'replace';
}

/** Whether `incoming` may overwrite `existing` on quality grounds alone. */
export function mayReplace(incoming: SourceId, existing: SourceId): boolean {
  return SOURCE_QUALITY[incoming] >= SOURCE_QUALITY[existing];
}
