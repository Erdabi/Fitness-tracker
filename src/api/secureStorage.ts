import * as SecureStore from 'expo-secure-store';

/**
 * Chunked SecureStore adapter for the Supabase auth session.
 *
 * expo-secure-store refuses values larger than 2048 bytes on Android. A
 * Supabase session — access token, refresh token, and the user object with its
 * metadata — routinely exceeds that, so writing it directly fails and the user
 * is silently signed out on next launch.
 *
 * Values are split across `key.0 … key.n` with a small header at `key`
 * recording the chunk count. Small values are stored inline so the common case
 * costs one read.
 */

/** Kept below the 2048-byte limit to leave room for multi-byte UTF-8. */
const CHUNK_SIZE = 1536;
const CHUNKED_PREFIX = '__chunked__:';

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** The subset of expo-secure-store used here; injectable for tests. */
export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export function createChunkedStore(store: SecureStoreLike = SecureStore): KeyValueStore {
  async function clearChunks(key: string, count: number): Promise<void> {
    const removals: Promise<void>[] = [];
    for (let index = 0; index < count; index += 1) {
      removals.push(store.deleteItemAsync(chunkKey(key, index)));
    }
    await Promise.all(removals);
  }

  /**
   * Chunk count from a previous write, so a value that shrinks does not leave
   * orphaned chunks behind that a later read could mistake for current data.
   */
  async function previousChunkCount(key: string): Promise<number> {
    const header = await store.getItemAsync(key);
    return header ? parseChunkCount(header) : 0;
  }

  return {
    async getItem(key) {
      const header = await store.getItemAsync(key);
      if (header === null) return null;

      const count = parseChunkCount(header);
      if (count === 0) return header; // stored inline

      const parts = await Promise.all(
        Array.from({ length: count }, (_, index) =>
          store.getItemAsync(chunkKey(key, index)),
        ),
      );

      // A missing chunk means the value is unrecoverable — most likely a write
      // interrupted mid-way. Report absent rather than returning a truncated
      // session that would fail to parse downstream.
      if (parts.some((part) => part === null)) return null;

      return parts.join('');
    },

    async setItem(key, value) {
      const staleCount = await previousChunkCount(key);

      if (byteLength(value) <= CHUNK_SIZE) {
        await store.setItemAsync(key, value);
        if (staleCount > 0) await clearChunks(key, staleCount);
        return;
      }

      const chunks = splitByBytes(value, CHUNK_SIZE);

      await Promise.all(
        chunks.map((chunk, index) => store.setItemAsync(chunkKey(key, index), chunk)),
      );
      // Header last: until it lands, a reader sees the old value rather than a
      // partially written new one.
      await store.setItemAsync(key, `${CHUNKED_PREFIX}${chunks.length}`);

      if (staleCount > chunks.length) {
        const removals: Promise<void>[] = [];
        for (let index = chunks.length; index < staleCount; index += 1) {
          removals.push(store.deleteItemAsync(chunkKey(key, index)));
        }
        await Promise.all(removals);
      }
    },

    async removeItem(key) {
      const count = await previousChunkCount(key);
      await store.deleteItemAsync(key);
      if (count > 0) await clearChunks(key, count);
    },
  };
}

/* ----------------------------------------------------------------- utils -- */

function chunkKey(key: string, index: number): string {
  return `${key}.${index}`;
}

function parseChunkCount(header: string): number {
  if (!header.startsWith(CHUNKED_PREFIX)) return 0;
  const count = Number.parseInt(header.slice(CHUNKED_PREFIX.length), 10);
  return Number.isInteger(count) && count > 0 ? count : 0;
}

function byteLength(value: string): number {
  // SecureStore's limit is on bytes, not characters.
  return new TextEncoder().encode(value).length;
}

/**
 * Splits on character boundaries while keeping each piece within the byte
 * budget. Splitting purely by character count would overflow on non-ASCII
 * content such as a display name in Japanese.
 */
function splitByBytes(value: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const character of value) {
    const size = byteLength(character);
    if (currentBytes + size > maxBytes && current.length > 0) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += character;
    currentBytes += size;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

export const secureSessionStore = createChunkedStore();
