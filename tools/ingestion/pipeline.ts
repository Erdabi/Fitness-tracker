import { decideMerge, type MergeDecision } from './quality';
import type { CanonicalFood, RejectionReason, SourceAdapter, SourceId } from './types';

/**
 * The import pipeline.
 *
 * Source-agnostic: it takes an adapter and a stream of raw records and does
 * the parts every importer needs — parse, deduplicate, decide whether the
 * incoming record may replace what is stored, write, and account for
 * everything it skipped.
 *
 * Written against a `CatalogSink` rather than a database client so the whole
 * flow can be tested without a server. The idempotency guarantee in particular
 * — running the same import twice must not create duplicates — is only
 * meaningful if it is actually exercised.
 */

export interface ExistingFood {
  readonly id: string;
  readonly nutritionSource: SourceId;
  readonly sourceUpdatedAt: string | null;
}

export interface CatalogSink {
  /** Looks a food up by its source's identifier — the idempotency key. */
  findByExternalId(sourceId: SourceId, externalId: string): Promise<ExistingFood | null>;
  /** Creates a food with its nutrition, servings and barcodes. */
  insert(food: CanonicalFood): Promise<string>;
  /** Replaces an existing food's data in place, keeping its id. */
  replace(id: string, food: CanonicalFood): Promise<void>;
}

export interface ImportReport {
  readonly source: SourceId;
  readonly read: number;
  readonly inserted: number;
  readonly replaced: number;
  readonly skipped: number;
  /** Skips and rejections by cause, so a bad export is diagnosable. */
  readonly reasons: Record<string, number>;
  readonly failures: { externalId: string; error: string }[];
}

export interface ImportOptions {
  /** Stop after this many records. Useful for a smoke run over a huge export. */
  readonly limit?: number;
  /** Parse and decide, but write nothing. */
  readonly dryRun?: boolean;
  /** Called every `progressEvery` records. */
  readonly onProgress?: (read: number) => void;
  readonly progressEvery?: number;
}

export async function runImport<TRaw>(
  adapter: SourceAdapter<TRaw>,
  records: AsyncIterable<TRaw> | Iterable<TRaw>,
  sink: CatalogSink,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const { limit, dryRun = false, onProgress, progressEvery = 1000 } = options;

  let read = 0;
  let inserted = 0;
  let replaced = 0;
  let skipped = 0;

  const reasons: Record<string, number> = {};
  const failures: { externalId: string; error: string }[] = [];

  // Guards against the same record appearing twice in one export, which OFF
  // dumps in particular do. Without it the second occurrence would be written
  // as an update over the first — wasted work at best, a race at worst.
  const seenInBatch = new Set<string>();

  const note = (key: RejectionReason | MergeDecision | 'duplicate_in_batch'): void => {
    reasons[key] = (reasons[key] ?? 0) + 1;
  };

  for await (const raw of records as AsyncIterable<TRaw>) {
    if (limit !== undefined && read >= limit) break;

    read += 1;
    if (onProgress && read % progressEvery === 0) onProgress(read);

    const parsed = adapter.parse(raw);
    if (!parsed.ok) {
      skipped += 1;
      note(parsed.reason);
      continue;
    }

    const food = parsed.food;

    if (seenInBatch.has(food.externalId)) {
      skipped += 1;
      note('duplicate_in_batch');
      continue;
    }
    seenInBatch.add(food.externalId);

    try {
      const existing = await sink.findByExternalId(adapter.sourceId, food.externalId);

      const decision = decideMerge({
        incomingSource: food.sourceId,
        existing: existing
          ? {
              source: existing.nutritionSource,
              sourceUpdatedAt: existing.sourceUpdatedAt,
            }
          : null,
        incomingSourceUpdatedAt: food.sourceUpdatedAt,
      });

      if (decision === 'skip_lower_quality' || decision === 'skip_unchanged') {
        skipped += 1;
        note(decision);
        continue;
      }

      if (dryRun) {
        if (decision === 'insert') inserted += 1;
        else replaced += 1;
        continue;
      }

      if (decision === 'insert') {
        await sink.insert(food);
        inserted += 1;
      } else {
        // `existing` is non-null whenever the decision is 'replace'.
        await sink.replace(existing!.id, food);
        replaced += 1;
      }
    } catch (cause) {
      // One bad record must not end an import of two million.
      skipped += 1;
      failures.push({
        externalId: food.externalId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      note('malformed_record');
    }
  }

  return {
    source: adapter.sourceId,
    read,
    inserted,
    replaced,
    skipped,
    reasons,
    failures,
  };
}

export function formatReport(report: ImportReport): string {
  const lines = [
    `source     ${report.source}`,
    `read       ${report.read}`,
    `inserted   ${report.inserted}`,
    `replaced   ${report.replaced}`,
    `skipped    ${report.skipped}`,
  ];

  const reasons = Object.entries(report.reasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) {
    lines.push('', 'skipped by reason:');
    for (const [reason, count] of reasons) {
      lines.push(`  ${reason.padEnd(24)} ${count}`);
    }
  }

  if (report.failures.length > 0) {
    lines.push('', `failures (${report.failures.length}), first 10:`);
    for (const failure of report.failures.slice(0, 10)) {
      lines.push(`  ${failure.externalId}: ${failure.error}`);
    }
  }

  return lines.join('\n');
}
