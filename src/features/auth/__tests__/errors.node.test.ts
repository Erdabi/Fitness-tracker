import { mapAuthError } from '../errors';

describe('mapAuthError', () => {
  it.each([
    ['invalid_credentials', 'auth', false],
    ['email_not_confirmed', 'auth', false],
    ['user_already_exists', 'conflict', false],
    ['weak_password', 'validation', false],
    ['over_request_rate_limit', 'rate_limited', true],
    ['session_expired', 'auth', false],
  ])('maps %s to a %s error', (code, kind, retryable) => {
    const result = mapAuthError({ code, message: 'raw message' });

    expect(result.kind).toBe(kind);
    expect(result.retryable).toBe(retryable);
  });

  it('never leaks the raw Supabase message to the user', () => {
    const result = mapAuthError({
      code: 'invalid_credentials',
      message: 'AuthApiError: Invalid login credentials',
    });

    expect(result.message).not.toMatch(/AuthApiError/);
    expect(result.message).toBe('That email or password is not right.');
  });

  it('detects a network failure thrown as a TypeError', () => {
    const result = mapAuthError(new TypeError('Network request failed'));

    expect(result.kind).toBe('network');
    expect(result.retryable).toBe(true);
  });

  it('detects a network failure reported by message', () => {
    expect(mapAuthError({ message: 'Failed to fetch' }).kind).toBe('network');
  });

  it('falls back to message matching for releases without a code', () => {
    const result = mapAuthError({ message: 'Invalid login credentials' });

    expect(result.kind).toBe('auth');
    expect(result.code).toBe('invalid_credentials');
  });

  it('treats a 5xx as a retryable server error', () => {
    const result = mapAuthError({ message: 'Internal error', status: 503 });

    expect(result.kind).toBe('server');
    expect(result.retryable).toBe(true);
  });

  it('degrades gracefully on an unrecognised shape', () => {
    const result = mapAuthError(null);

    expect(result.kind).toBe('unknown');
    expect(result.message).toBeTruthy();
  });

  it('preserves the original error for logging without showing it', () => {
    const cause = { code: 'invalid_credentials', message: 'raw' };
    expect(mapAuthError(cause).cause).toBe(cause);
  });
});
