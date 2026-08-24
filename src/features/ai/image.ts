import { appError, err, ok, type Result } from '@/lib/result';
import type { ScanImage } from './provider';

/**
 * Preparing an image for analysis.
 *
 * Two jobs, both about cost and both done before anything leaves the device:
 * bound the size, and reject what a vision model cannot use. Every pixel sent
 * is billed, so an unbounded upload is an unbounded charge — and the app is
 * the only thing between a camera roll and the provider's meter.
 *
 * These limits mirror `supabase/functions/_shared/limits.ts`, which enforces
 * them again server-side. The client copy exists so a user finds out before
 * spending thirty seconds uploading; the server copy exists because a client
 * limit is a suggestion.
 */

/** Mirrors MAX_IMAGE_BYTES in the Edge Function's limits. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Longest edge to capture at.
 *
 * Above roughly this, extra pixels stop improving how well a label reads and
 * only add tokens. Passed to the camera and the picker rather than resizing
 * afterwards, which would mean decoding a full-resolution bitmap on a phone.
 */
export const MAX_IMAGE_EDGE_PX = 1568;

/**
 * Capture quality for the camera and picker.
 *
 * 0.7 JPEG keeps printed text legible while roughly halving the bytes of a
 * quality-1 capture. Label reading is the demanding case and it survives this
 * comfortably; food photos need far less.
 */
export const CAPTURE_QUALITY = 0.7;

export type ScanMediaType = ScanImage['mediaType'];

const MEDIA_TYPES: Record<string, ScanMediaType> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/** Base64 expands by 4/3; this recovers the original size without decoding. */
export function decodedByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * Reads a media type from a URI or a declared mime type.
 *
 * Falls back to JPEG rather than failing, because both the camera and the
 * picker produce JPEG by default and a missing extension is far more likely to
 * be an unhelpful URI than an exotic format. The server checks the actual
 * magic bytes regardless, so a wrong guess here is caught rather than trusted.
 */
export function resolveMediaType(source: {
  mimeType?: string | null;
  uri?: string | null;
}): ScanMediaType | null {
  const declared = source.mimeType?.toLowerCase();
  if (declared) {
    if (declared === 'image/jpg') return 'image/jpeg';
    if (declared in MEDIA_TYPES) return MEDIA_TYPES[declared] as ScanMediaType;
    if (declared === 'image/jpeg' || declared === 'image/png' || declared === 'image/webp') {
      return declared;
    }
    // A declared type we do not support is a definite no, not a guess.
    if (declared.startsWith('image/')) return null;
  }

  const extension = source.uri?.split('?')[0]?.split('.').pop()?.toLowerCase();
  if (extension && extension in MEDIA_TYPES) {
    return MEDIA_TYPES[extension] as ScanMediaType;
  }

  return source.uri ? 'image/jpeg' : null;
}

/**
 * Turns a captured or picked image into something sendable.
 *
 * Returns a `Result` rather than throwing, because "that photo is too big" is
 * an ordinary thing for a user to do and deserves an ordinary message rather
 * than an error boundary.
 */
export function prepareImage(source: {
  base64?: string | null;
  mimeType?: string | null;
  uri?: string | null;
}): Result<ScanImage> {
  if (!source.base64) {
    return err(
      appError('validation', 'That image could not be read. Try taking it again.', {
        code: 'image_unreadable',
        retryable: true,
      }),
    );
  }

  const mediaType = resolveMediaType(source);
  if (!mediaType) {
    return err(
      appError('validation', 'Images must be JPEG, PNG or WebP.', {
        code: 'unsupported_media_type',
        retryable: false,
      }),
    );
  }

  const byteLength = decodedByteLength(source.base64);
  if (byteLength > MAX_IMAGE_BYTES) {
    return err(
      appError(
        'validation',
        `That image is ${Math.round(byteLength / 1024 / 1024 * 10) / 10} MB. Take the photo again — the app will capture it at a smaller size.`,
        { code: 'image_too_large', retryable: false },
      ),
    );
  }

  if (byteLength === 0) {
    return err(
      appError('validation', 'That image is empty. Try taking it again.', {
        code: 'image_empty',
        retryable: true,
      }),
    );
  }

  return ok({ data: source.base64, mediaType, byteLength });
}
