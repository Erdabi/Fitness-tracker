import type { Session, SupabaseClient } from '@supabase/supabase-js';

import { supabase as defaultClient } from '@/api/supabase';
import type { Database } from '@/api/database.types';
import { err, ok, type Result } from '@/lib/result';
import { mapAuthError } from './errors';
import {
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
  type ResetPasswordInput,
  type SignInInput,
  type SignUpInput,
} from './validation';
import { appError } from '@/lib/result';

/**
 * Authentication operations.
 *
 * Every function takes the client as an argument (defaulted) so tests can pass
 * a stub, and every one returns a `Result` rather than throwing — a wrong
 * password is an expected outcome, not an exception.
 */

type Client = SupabaseClient<Database>;

export interface SignUpOutcome {
  /**
   * True when the project requires email confirmation, meaning no session was
   * issued and the user must click a link before signing in. The UI has to say
   * so — otherwise sign-up looks like it silently failed.
   */
  readonly needsEmailConfirmation: boolean;
}

export async function signUp(
  input: SignUpInput,
  client: Client = defaultClient,
): Promise<Result<SignUpOutcome>> {
  const parsed = signUpSchema.safeParse(input);
  if (!parsed.success) {
    return err(validationError(parsed.error.issues[0]?.message));
  }

  try {
    const { data, error } = await client.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
    });

    if (error) return err(mapAuthError(error));

    // Supabase returns a user with no session when confirmation is required.
    return ok({ needsEmailConfirmation: data.session === null });
  } catch (cause) {
    return err(mapAuthError(cause));
  }
}

export async function signIn(
  input: SignInInput,
  client: Client = defaultClient,
): Promise<Result<Session>> {
  const parsed = signInSchema.safeParse(input);
  if (!parsed.success) {
    return err(validationError(parsed.error.issues[0]?.message));
  }

  try {
    const { data, error } = await client.auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });

    if (error) return err(mapAuthError(error));
    if (!data.session) {
      return err(
        appError('auth', 'Could not start a session. Try again.', {
          code: 'no_session',
          retryable: true,
        }),
      );
    }

    return ok(data.session);
  } catch (cause) {
    return err(mapAuthError(cause));
  }
}

export async function signOut(client: Client = defaultClient): Promise<Result<void>> {
  try {
    const { error } = await client.auth.signOut();
    if (error) return err(mapAuthError(error));
    return ok(undefined);
  } catch (cause) {
    return err(mapAuthError(cause));
  }
}

export async function requestPasswordReset(
  input: ResetPasswordInput,
  client: Client = defaultClient,
): Promise<Result<void>> {
  const parsed = resetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return err(validationError(parsed.error.issues[0]?.message));
  }

  try {
    const { error } = await client.auth.resetPasswordForEmail(parsed.data.email);
    if (error) return err(mapAuthError(error));
    return ok(undefined);
  } catch (cause) {
    return err(mapAuthError(cause));
  }
}

export async function getSession(
  client: Client = defaultClient,
): Promise<Result<Session | null>> {
  try {
    const { data, error } = await client.auth.getSession();
    if (error) return err(mapAuthError(error));
    return ok(data.session);
  } catch (cause) {
    return err(mapAuthError(cause));
  }
}

function validationError(message: string | undefined) {
  return appError('validation', message ?? 'Check the details you entered.', {
    code: 'validation',
    retryable: false,
  });
}
