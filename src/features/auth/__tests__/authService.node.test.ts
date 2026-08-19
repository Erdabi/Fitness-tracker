import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/api/database.types';
import {
  getSession,
  requestPasswordReset,
  signIn,
  signOut,
  signUp,
} from '../authService';

// The module under test imports the real client for its default argument,
// which would pull in expo-constants and react-native. Every test passes an
// explicit stub, so the default is never exercised.
jest.mock('@/api/supabase', () => ({ supabase: {} }));

/**
 * Builds a stub Supabase client.
 *
 * Only the auth methods used here are implemented; anything else is a
 * programmer error and should fail loudly rather than return undefined.
 */
function stubClient(auth: Partial<SupabaseClient<Database>['auth']>) {
  return { auth } as unknown as SupabaseClient<Database>;
}

const fakeSession = {
  access_token: 'token',
  refresh_token: 'refresh',
  expires_in: 3600,
  token_type: 'bearer',
  user: { id: 'user-1', email: 'sam@example.com' },
} as never;

describe('signIn', () => {
  it('returns the session on success', async () => {
    const client = stubClient({
      signInWithPassword: jest
        .fn()
        .mockResolvedValue({ data: { session: fakeSession }, error: null }),
    });

    const result = await signIn(
      { email: 'sam@example.com', password: 'correct-horse' },
      client,
    );

    expect(result.ok).toBe(true);
  });

  it('rejects a malformed email before making a request', async () => {
    const signInWithPassword = jest.fn();
    const client = stubClient({ signInWithPassword });

    const result = await signIn({ email: 'not-an-email', password: 'x' }, client);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('validation');
    // The point of validating first: no round trip for an obvious mistake.
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it('maps bad credentials to a message worth showing', async () => {
    const client = stubClient({
      signInWithPassword: jest.fn().mockResolvedValue({
        data: { session: null },
        error: { code: 'invalid_credentials', message: 'Invalid login credentials' },
      }),
    });

    const result = await signIn({ email: 'sam@example.com', password: 'wrong' }, client);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('auth');
      expect(result.error.message).toBe('That email or password is not right.');
      expect(result.error.retryable).toBe(false);
    }
  });

  it('treats a thrown network failure as retryable', async () => {
    const client = stubClient({
      signInWithPassword: jest
        .fn()
        .mockRejectedValue(new TypeError('Network request failed')),
    });

    const result = await signIn(
      { email: 'sam@example.com', password: 'correct-horse' },
      client,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('network');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('fails rather than reporting success when no session comes back', async () => {
    const client = stubClient({
      signInWithPassword: jest
        .fn()
        .mockResolvedValue({ data: { session: null }, error: null }),
    });

    const result = await signIn(
      { email: 'sam@example.com', password: 'correct-horse' },
      client,
    );

    expect(result.ok).toBe(false);
  });

  it('trims whitespace around the email', async () => {
    const signInWithPassword = jest
      .fn()
      .mockResolvedValue({ data: { session: fakeSession }, error: null });
    const client = stubClient({ signInWithPassword });

    await signIn({ email: '  sam@example.com  ', password: 'correct-horse' }, client);

    expect(signInWithPassword).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'sam@example.com' }),
    );
  });
});

describe('signUp', () => {
  it('reports when email confirmation is required', async () => {
    // Supabase returns a user with no session when confirmation is on. The UI
    // must say so, or a successful sign-up looks like nothing happened.
    const client = stubClient({
      signUp: jest
        .fn()
        .mockResolvedValue({ data: { user: { id: 'u' }, session: null }, error: null }),
    });

    const result = await signUp(
      { email: 'sam@example.com', password: 'longenoughpassword' },
      client,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.needsEmailConfirmation).toBe(true);
  });

  it('reports no confirmation needed when a session is issued', async () => {
    const client = stubClient({
      signUp: jest.fn().mockResolvedValue({
        data: { user: { id: 'u' }, session: fakeSession },
        error: null,
      }),
    });

    const result = await signUp(
      { email: 'sam@example.com', password: 'longenoughpassword' },
      client,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.needsEmailConfirmation).toBe(false);
  });

  it('rejects a short password before making a request', async () => {
    const signUpFn = jest.fn();
    const client = stubClient({ signUp: signUpFn });

    const result = await signUp({ email: 'sam@example.com', password: 'short' }, client);

    expect(result.ok).toBe(false);
    expect(signUpFn).not.toHaveBeenCalled();
  });

  it('rejects a password over bcrypt’s 72-byte limit locally', async () => {
    const signUpFn = jest.fn();
    const client = stubClient({ signUp: signUpFn });

    const result = await signUp(
      { email: 'sam@example.com', password: 'a'.repeat(100) },
      client,
    );

    expect(result.ok).toBe(false);
    expect(signUpFn).not.toHaveBeenCalled();
  });

  it('points an existing user at sign-in', async () => {
    const client = stubClient({
      signUp: jest.fn().mockResolvedValue({
        data: { user: null, session: null },
        error: { code: 'user_already_exists', message: 'User already registered' },
      }),
    });

    const result = await signUp(
      { email: 'sam@example.com', password: 'longenoughpassword' },
      client,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('conflict');
      expect(result.error.message).toMatch(/sign in/i);
    }
  });
});

describe('signOut', () => {
  it('succeeds', async () => {
    const client = stubClient({ signOut: jest.fn().mockResolvedValue({ error: null }) });
    const result = await signOut(client);
    expect(result.ok).toBe(true);
  });

  it('surfaces a failure', async () => {
    const client = stubClient({
      signOut: jest.fn().mockResolvedValue({ error: { message: 'boom', status: 500 } }),
    });

    const result = await signOut(client);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.retryable).toBe(true);
  });
});

describe('requestPasswordReset', () => {
  it('sends for a valid address', async () => {
    const resetPasswordForEmail = jest.fn().mockResolvedValue({ error: null });
    const client = stubClient({ resetPasswordForEmail });

    const result = await requestPasswordReset({ email: 'sam@example.com' }, client);

    expect(result.ok).toBe(true);
    expect(resetPasswordForEmail).toHaveBeenCalledWith('sam@example.com');
  });

  it('rejects an invalid address without a request', async () => {
    const resetPasswordForEmail = jest.fn();
    const client = stubClient({ resetPasswordForEmail });

    const result = await requestPasswordReset({ email: 'nope' }, client);

    expect(result.ok).toBe(false);
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });
});

describe('getSession', () => {
  it('returns null when signed out', async () => {
    const client = stubClient({
      getSession: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
    });

    const result = await getSession(client);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it('returns the restored session', async () => {
    const client = stubClient({
      getSession: jest
        .fn()
        .mockResolvedValue({ data: { session: fakeSession }, error: null }),
    });

    const result = await getSession(client);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).not.toBeNull();
  });
});
