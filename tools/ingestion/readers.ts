import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

/**
 * Streaming readers.
 *
 * Source exports are large — the Open Food Facts JSONL dump is tens of
 * gigabytes — so records are yielded one at a time and never accumulated.
 * `JSON.parse` on the whole file is not an option at that size.
 */

/**
 * Yields one parsed object per line of a newline-delimited JSON file.
 * `.gz` is detected by extension and decompressed on the fly.
 *
 * A line that does not parse is skipped rather than fatal: a truncated final
 * line is common in a partially-downloaded dump, and one bad line should not
 * discard the millions before it.
 */
export async function* readNdjson<T>(
  path: string,
  onBadLine?: (lineNumber: number) => void,
): AsyncGenerator<T> {
  const fileStream = createReadStream(path);
  const stream = path.endsWith('.gz') ? fileStream.pipe(createGunzip()) : fileStream;

  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      yield JSON.parse(trimmed) as T;
    } catch {
      onBadLine?.(lineNumber);
    }
  }
}

/**
 * Yields the elements of a top-level JSON array, or of a named array property.
 *
 * USDA ships its exports this way. This does buffer the file, so it suits the
 * USDA subsets (tens of MB) but not the OFF full dump — use NDJSON there.
 */
export async function* readJsonArray<T>(
  path: string,
  arrayKey?: string,
): AsyncGenerator<T> {
  const { readFile } = await import('node:fs/promises');
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));

  const items = arrayKey
    ? (parsed as Record<string, unknown>)[arrayKey]
    : parsed;

  if (!Array.isArray(items)) {
    throw new Error(
      arrayKey
        ? `Expected an array at "${arrayKey}" in ${path}`
        : `Expected a top-level array in ${path}`,
    );
  }

  for (const item of items) yield item as T;
}
