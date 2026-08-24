/**
 * Cost and safety limits for AI scanning.
 *
 * Every one of these bounds a bill. Vision tokens scale with image dimensions,
 * so an unbounded upload is an unbounded charge — and the app is the only
 * thing standing between a user's camera roll and the provider's meter.
 */

/**
 * Largest accepted image, in bytes, before base64 encoding.
 *
 * 4 MB is comfortably above a well-compressed phone photo of a label and far
 * below what a modern camera produces at full resolution. The client
 * downscales before sending; this is the backstop for a client that does not.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Longest edge the client should downscale to.
 *
 * Above roughly this, extra pixels stop improving OCR accuracy and only add
 * tokens. Enforced client-side because that is where the resize can happen;
 * the byte limit above is what enforces it server-side.
 */
export const MAX_IMAGE_EDGE_PX = 1568;

export const ALLOWED_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

/**
 * Scans per user per rolling day.
 *
 * A generous ceiling for real use — nobody photographs sixty labels a day —
 * and a hard stop on a runaway client or a stolen token. Enforced in Postgres
 * so it holds across function instances, which an in-memory counter would not.
 */
export const DAILY_SCAN_LIMIT = 60;

/** How long to wait on the provider before giving up. */
export const PROVIDER_TIMEOUT_MS = 60_000;

/** Output ceiling. Both responses are small structured objects. */
export const MAX_OUTPUT_TOKENS = 4096;
