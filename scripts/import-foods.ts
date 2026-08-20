#!/usr/bin/env node
/**
 * Food catalogue importer.
 *
 *   npx tsx scripts/import-foods.ts --source usda --file data/usda.json --key FoundationFoods
 *   npx tsx scripts/import-foods.ts --source openfoodfacts --file data/off.jsonl.gz --limit 50000
 *   npx tsx scripts/import-foods.ts --source usda --file data/usda.json --dry-run
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. See
 * docs/food-data-sources.md for where to download each export and what the
 * licences require.
 *
 * Safe to re-run: records are matched on (source, external_id), so a second
 * pass updates rather than duplicates.
 */

import { openFoodFactsAdapter } from '../tools/ingestion/sources/openfoodfacts';
import { usdaAdapter } from '../tools/ingestion/sources/usda';
import { readJsonArray, readNdjson } from '../tools/ingestion/readers';
import { formatReport, runImport } from '../tools/ingestion/pipeline';
import { createSupabaseSink } from '../tools/ingestion/supabaseSink';
import type { SourceAdapter } from '../tools/ingestion/types';

interface Args {
  source: string;
  file: string;
  key?: string;
  limit?: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { dryRun: false };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    switch (flag) {
      case '--source': args.source = value; index += 1; break;
      case '--file':   args.file = value;   index += 1; break;
      case '--key':    args.key = value;    index += 1; break;
      case '--limit':  args.limit = Number(value); index += 1; break;
      case '--dry-run': args.dryRun = true; break;
      default: break;
    }
  }

  if (!args.source || !args.file) {
    throw new Error(
      'Usage: import-foods --source <usda|openfoodfacts> --file <path> ' +
        '[--key <jsonArrayKey>] [--limit N] [--dry-run]',
    );
  }

  return args as Args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const adapters: Record<string, SourceAdapter<never>> = {
    usda: usdaAdapter as SourceAdapter<never>,
    openfoodfacts: openFoodFactsAdapter as SourceAdapter<never>,
  };

  const adapter = adapters[args.source];
  if (!adapter) {
    throw new Error(`Unknown source "${args.source}". Use usda or openfoodfacts.`);
  }

  let badLines = 0;
  const records = args.file.endsWith('.json')
    ? readJsonArray<never>(args.file, args.key)
    : readNdjson<never>(args.file, () => { badLines += 1; });

  // A dry run needs no credentials, so it can be used to validate an export
  // before anyone handles the service role key.
  const sink = args.dryRun
    ? {
        findByExternalId: async () => null,
        insert: async () => 'dry-run',
        replace: async () => undefined,
      }
    : createSupabaseSink();

  console.log(`Importing ${adapter.label} from ${args.file}${args.dryRun ? ' (dry run)' : ''}`);

  const started = Date.now();
  const report = await runImport(adapter, records, sink, {
    limit: args.limit,
    dryRun: args.dryRun,
    onProgress: (read) => process.stdout.write(`\r  read ${read}…`),
  });

  process.stdout.write('\r');
  console.log(formatReport(report));
  if (badLines > 0) console.log(`unparseable lines  ${badLines}`);
  console.log(`elapsed            ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
