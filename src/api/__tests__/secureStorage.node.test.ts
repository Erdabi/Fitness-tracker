import { createChunkedStore, type SecureStoreLike } from '../secureStorage';

// The module imports expo-secure-store for its default backing store. Every
// test injects a fake, so the native module is never called.
// (babel-jest hoists jest.mock above the imports, so placement here is safe.)
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

/** In-memory SecureStore that enforces the real 2048-byte platform limit. */
function fakeSecureStore(limit = 2048): SecureStoreLike & {
  map: Map<string, string>;
} {
  const map = new Map<string, string>();

  return {
    map,
    async getItemAsync(key) {
      return map.get(key) ?? null;
    },
    async setItemAsync(key, value) {
      if (new TextEncoder().encode(value).length > limit) {
        // Matches how expo-secure-store fails on Android.
        throw new Error('Value too large for SecureStore');
      }
      map.set(key, value);
    },
    async deleteItemAsync(key) {
      map.delete(key);
    },
  };
}

describe('chunked secure storage', () => {
  it('stores and reads a small value inline', async () => {
    const backing = fakeSecureStore();
    const store = createChunkedStore(backing);

    await store.setItem('session', 'hello');

    expect(await store.getItem('session')).toBe('hello');
    expect(backing.map.get('session')).toBe('hello');
  });

  /**
   * The bug this exists to prevent: a Supabase session exceeds SecureStore's
   * 2048-byte limit, the write throws, and the user is silently signed out on
   * next launch.
   */
  it('stores a value larger than the platform limit', async () => {
    const backing = fakeSecureStore();
    const store = createChunkedStore(backing);
    const session = JSON.stringify({ access_token: 'x'.repeat(6000) });

    await store.setItem('session', session);

    expect(await store.getItem('session')).toBe(session);
  });

  it('keeps every individual chunk under the limit', async () => {
    const backing = fakeSecureStore();
    const store = createChunkedStore(backing);

    await store.setItem('session', 'y'.repeat(10_000));

    for (const value of backing.map.values()) {
      expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(2048);
    }
  });

  it('returns null for a key that was never written', async () => {
    const store = createChunkedStore(fakeSecureStore());
    expect(await store.getItem('missing')).toBeNull();
  });

  it('removes a chunked value completely', async () => {
    const backing = fakeSecureStore();
    const store = createChunkedStore(backing);

    await store.setItem('session', 'z'.repeat(6000));
    await store.removeItem('session');

    expect(await store.getItem('session')).toBeNull();
    expect(backing.map.size).toBe(0);
  });

  /**
   * A shrinking value must not leave chunks behind — a later read that found
   * a stale trailing chunk would return a corrupt session.
   */
  it('cleans up stale chunks when a value shrinks', async () => {
    const backing = fakeSecureStore();
    const store = createChunkedStore(backing);

    await store.setItem('session', 'a'.repeat(9000));
    await store.setItem('session', 'b'.repeat(20));

    expect(await store.getItem('session')).toBe('b'.repeat(20));
    expect(backing.map.size).toBe(1);
  });

  it('cleans up when a value shrinks but stays chunked', async () => {
    const backing = fakeSecureStore();
    const store = createChunkedStore(backing);

    await store.setItem('session', 'a'.repeat(12_000));
    await store.setItem('session', 'b'.repeat(4_000));

    expect(await store.getItem('session')).toBe('b'.repeat(4_000));
  });

  it('grows from inline to chunked correctly', async () => {
    const backing = fakeSecureStore();
    const store = createChunkedStore(backing);

    await store.setItem('session', 'small');
    await store.setItem('session', 'c'.repeat(8000));

    expect(await store.getItem('session')).toBe('c'.repeat(8000));
  });

  /**
   * Splitting by character count would overflow the byte limit on non-ASCII
   * content — a display name in Japanese is three bytes per character.
   */
  it('splits multi-byte content on byte boundaries', async () => {
    const backing = fakeSecureStore();
    const store = createChunkedStore(backing);
    const value = '日本語のテキスト'.repeat(500);

    await store.setItem('session', value);

    expect(await store.getItem('session')).toBe(value);
    for (const stored of backing.map.values()) {
      expect(new TextEncoder().encode(stored).length).toBeLessThanOrEqual(2048);
    }
  });

  it('preserves emoji across a chunk boundary', async () => {
    const backing = fakeSecureStore();
    const store = createChunkedStore(backing);
    const value = '🏋️‍♀️'.repeat(400);

    await store.setItem('session', value);

    expect(await store.getItem('session')).toBe(value);
  });

  it('reports null rather than a truncated value when a chunk is missing', async () => {
    const backing = fakeSecureStore();
    const store = createChunkedStore(backing);

    await store.setItem('session', 'd'.repeat(6000));
    // Simulate a write interrupted partway through.
    backing.map.delete('session.1');

    expect(await store.getItem('session')).toBeNull();
  });

  it('round-trips a realistic Supabase session payload', async () => {
    const backing = fakeSecureStore();
    const store = createChunkedStore(backing);
    const session = JSON.stringify({
      access_token: `header.${'p'.repeat(1200)}.signature`,
      refresh_token: 'r'.repeat(120),
      expires_at: 1_800_000_000,
      user: {
        id: '00000000-0000-4000-8000-000000000000',
        email: 'sam@example.com',
        user_metadata: { display_name: 'Sam' },
      },
    });

    await store.setItem('sb-auth-token', session);

    expect(JSON.parse((await store.getItem('sb-auth-token')) ?? '{}')).toEqual(
      JSON.parse(session),
    );
  });
});
