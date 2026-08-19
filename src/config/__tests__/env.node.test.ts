import { parseEnv } from '../env';

// `env` is validated at module load so a misconfigured build fails fast. That
// means importing this module requires a valid config, even though the tests
// below exercise `parseEnv` directly.
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {
      extra: {
        supabaseUrl: 'https://test-project.supabase.co',
        supabaseAnonKey: 'test-anon-key-long-enough-to-validate',
        appEnv: 'test',
      },
    },
  },
}));

const valid = {
  supabaseUrl: 'https://abcdefgh.supabase.co',
  supabaseAnonKey: 'a-key-long-enough-to-be-plausible',
  appEnv: 'development',
};

describe('parseEnv', () => {
  it('accepts a complete configuration', () => {
    expect(parseEnv(valid)).toMatchObject({
      supabaseUrl: valid.supabaseUrl,
      appEnv: 'development',
    });
  });

  it('defaults appEnv when it is absent', () => {
    const { appEnv: _ignored, ...withoutEnv } = valid;
    expect(parseEnv(withoutEnv).appEnv).toBe('development');
  });

  /**
   * Failing at load with a specific message is the point: without it, a
   * missing URL surfaces much later as a request to `undefined/auth/v1/token`.
   */
  it('names the missing variable', () => {
    const { supabaseUrl: _ignored, ...withoutUrl } = valid;
    expect(() => parseEnv(withoutUrl)).toThrow(/EXPO_PUBLIC_SUPABASE_URL/);
  });

  it('rejects a URL that is not a URL', () => {
    expect(() => parseEnv({ ...valid, supabaseUrl: 'abcdefgh.supabase.co' })).toThrow(
      /EXPO_PUBLIC_SUPABASE_URL/,
    );
  });

  it('rejects a truncated anon key', () => {
    expect(() => parseEnv({ ...valid, supabaseAnonKey: 'short' })).toThrow(
      /EXPO_PUBLIC_SUPABASE_ANON_KEY/,
    );
  });

  it('rejects an unknown appEnv rather than guessing', () => {
    expect(() => parseEnv({ ...valid, appEnv: 'staging' })).toThrow();
  });

  it('tells the reader how to fix it', () => {
    expect(() => parseEnv({})).toThrow(/\.env\.example/);
  });

  it('reports every problem at once', () => {
    let message = '';
    try {
      parseEnv({ supabaseUrl: 'nope', supabaseAnonKey: 'x' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toMatch(/EXPO_PUBLIC_SUPABASE_URL/);
    expect(message).toMatch(/EXPO_PUBLIC_SUPABASE_ANON_KEY/);
  });
});
