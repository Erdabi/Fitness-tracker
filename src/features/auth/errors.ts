import { appError, type AppError } from '@/lib/result';

/**
 * Translates Supabase auth failures into messages a person can act on.
 *
 * Raw errors either leak implementation detail ("AuthApiError: Invalid login
 * credentials") or say nothing useful. Each message here states what happened
 * and what to do next.
 */

interface SupabaseAuthErrorShape {
  message?: string;
  code?: string;
  status?: number;
}

export function mapAuthError(cause: unknown): AppError {
  const raw = cause as SupabaseAuthErrorShape | null;
  const code = raw?.code ?? '';
  const message = raw?.message ?? '';
  const status = raw?.status ?? 0;

  // Network failures reach us before the API assigns a code.
  if (isNetworkFailure(cause, message)) {
    return appError('network', 'No connection. Check your network and try again.', {
      code: 'network',
      cause,
      retryable: true,
    });
  }

  switch (code) {
    case 'invalid_credentials':
      return appError('auth', 'That email or password is not right.', {
        code,
        cause,
        retryable: false,
      });

    case 'email_not_confirmed':
      return appError(
        'auth',
        'Confirm your email first — check your inbox for the link we sent.',
        { code, cause, retryable: false },
      );

    case 'user_already_exists':
    case 'email_exists':
      return appError('conflict', 'That email already has an account. Sign in instead.', {
        code,
        cause,
        retryable: false,
      });

    case 'weak_password':
      return appError('validation', 'Pick a longer password — at least 8 characters.', {
        code,
        cause,
        retryable: false,
      });

    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return appError('rate_limited', 'Too many attempts. Wait a minute and try again.', {
        code,
        cause,
        retryable: true,
      });

    case 'session_expired':
    case 'refresh_token_not_found':
      return appError('auth', 'Your session expired. Sign in again.', {
        code,
        cause,
        retryable: false,
      });

    default:
      break;
  }

  // Older releases report some failures by message only.
  if (/invalid login credentials/i.test(message)) {
    return appError('auth', 'That email or password is not right.', {
      code: 'invalid_credentials',
      cause,
      retryable: false,
    });
  }

  if (/email not confirmed/i.test(message)) {
    return appError(
      'auth',
      'Confirm your email first — check your inbox for the link we sent.',
      { code: 'email_not_confirmed', cause, retryable: false },
    );
  }

  if (status >= 500) {
    return appError('server', 'Something went wrong on our side. Try again shortly.', {
      code: String(status),
      cause,
      retryable: true,
    });
  }

  return appError('unknown', 'Something went wrong. Try again.', {
    code: code || undefined,
    cause,
    retryable: true,
  });
}

function isNetworkFailure(cause: unknown, message: string): boolean {
  if (cause instanceof TypeError && /fetch/i.test(cause.message)) return true;
  return /network request failed|failed to fetch|network error/i.test(message);
}
