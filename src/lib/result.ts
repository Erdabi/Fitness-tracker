/**
 * A small Result type used at every boundary that can fail for reasons the user
 * needs to see (network, auth, validation).
 *
 * Throwing is reserved for programmer error — a failed sign-in is an expected
 * outcome, not an exception, and modelling it as a value forces call sites to
 * handle it instead of relying on a try/catch someone forgot to write.
 */

export type Result<T, E = AppError> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Every failure the UI can surface is one of these kinds. */
export type AppErrorKind =
  | 'network'
  | 'auth'
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'server'
  | 'unknown';

export interface AppError {
  readonly kind: AppErrorKind;
  /** Safe to render directly — written for the person reading it, not for a log. */
  readonly message: string;
  /** Stable identifier for tests and analytics; never shown to the user. */
  readonly code?: string;
  /** Original failure, preserved for logging. Never rendered. */
  readonly cause?: unknown;
  /** Whether retrying the same action could plausibly succeed. */
  readonly retryable: boolean;
}

export function appError(
  kind: AppErrorKind,
  message: string,
  options: { code?: string; cause?: unknown; retryable?: boolean } = {},
): AppError {
  return {
    kind,
    message,
    code: options.code,
    cause: options.cause,
    // Transient categories default to retryable; everything else does not.
    retryable:
      options.retryable ??
      (kind === 'network' || kind === 'server' || kind === 'rate_limited'),
  };
}

/**
 * Wraps a throwing async call, converting rejections into a typed error rather
 * than letting them escape into a render.
 */
export async function attempt<T>(
  fn: () => Promise<T>,
  onError: (cause: unknown) => AppError,
): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (cause) {
    return err(onError(cause));
  }
}
