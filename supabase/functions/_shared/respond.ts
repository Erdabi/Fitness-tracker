/**
 * Responses and logging.
 *
 * Two rules, both about what does NOT cross a boundary.
 *
 * Outward: a provider's error text can carry request internals, model names,
 * account identifiers and occasionally fragments of the prompt. None of that
 * belongs in a phone. Errors are mapped to a small set of codes the app knows
 * how to act on, and the detail stays in the log.
 *
 * Into the log: never the image, never a key, never the extracted contents of
 * somebody's shopping. Sizes, durations, codes and counts are enough to
 * operate this, and are not a record of what anyone ate.
 */

export type ErrorCode =
  | 'unauthorized'
  | 'invalid_request'
  | 'unsupported_media_type'
  | 'image_too_large'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'invalid_model_output'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  invalid_request: 400,
  unsupported_media_type: 415,
  image_too_large: 413,
  rate_limited: 429,
  provider_unavailable: 503,
  provider_timeout: 504,
  invalid_model_output: 502,
  internal: 500,
};

/**
 * What the user is told. Deliberately plain, actionable where possible, and
 * never a restatement of a provider fault they cannot do anything about.
 */
const MESSAGES: Record<ErrorCode, string> = {
  unauthorized: 'Sign in to use scanning.',
  invalid_request: 'That request could not be read.',
  unsupported_media_type: 'Images must be JPEG, PNG or WebP.',
  image_too_large: 'That image is too large. Try again with a smaller photo.',
  rate_limited: "You've reached today's scanning limit. Try again tomorrow.",
  provider_unavailable: 'Scanning is unavailable right now. Try again shortly.',
  provider_timeout: 'That took too long to analyse. Try again.',
  invalid_model_output: 'The result could not be read reliably. Try another photo.',
  internal: 'Something went wrong. Try again.',
};

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
} as const;

export function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export function fail(code: ErrorCode, detail?: string): Response {
  // `detail` is for the log, not the body.
  return new Response(
    JSON.stringify({ error: { code, message: MESSAGES[code] } }),
    {
      status: STATUS[code],
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    },
  );
}

export interface LogFields {
  readonly operation: string;
  readonly userId?: string;
  readonly outcome: 'ok' | 'error';
  readonly code?: ErrorCode;
  readonly durationMs?: number;
  readonly imageBytes?: number;
  readonly status?: string;
  readonly confidence?: string;
  readonly itemCount?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly detail?: string;
}

/**
 * One structured line per request.
 *
 * `userId` is included because operating a per-user quota requires knowing
 * which user hit it. What the picture showed, and what was extracted from it,
 * are not logged — those are the private part.
 */
export function log(fields: LogFields): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

/**
 * Maps a thrown provider error to a code, keeping its text out of the body.
 *
 * Shapes rather than classes, because the Deno runtime receives these across
 * an npm interop boundary where `instanceof` is not dependable.
 */
export function classifyProviderError(error: unknown): ErrorCode {
  const status = (error as { status?: number } | null)?.status;
  const name = (error as { name?: string } | null)?.name ?? '';

  if (name === 'AbortError' || name === 'TimeoutError') return 'provider_timeout';
  if (status === 401 || status === 403) return 'internal'; // Our key, not theirs.
  if (status === 429) return 'provider_unavailable';
  if (typeof status === 'number' && status >= 500) return 'provider_unavailable';
  if (typeof status === 'number' && status >= 400) return 'internal';

  return 'provider_unavailable';
}

/** Trims a thrown value to something loggable without leaking a payload. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300);
  return String(error).slice(0, 300);
}
