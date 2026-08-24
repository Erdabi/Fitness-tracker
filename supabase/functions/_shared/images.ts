import { ALLOWED_MEDIA_TYPES, MAX_IMAGE_BYTES } from './limits.ts';

/**
 * Image validation, before anything reaches the provider.
 *
 * Runs on the encoded payload rather than the decoded bytes wherever possible,
 * so a hostile 100 MB upload is rejected on its length rather than after being
 * expanded in memory.
 */

export interface ImageProblem {
  readonly code:
    | 'unsupported_media_type'
    | 'too_large'
    | 'malformed'
    | 'empty';
  readonly message: string;
}

/** Base64 expands by 4/3; this recovers the original size without decoding. */
export function decodedByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * The magic bytes each accepted format begins with.
 *
 * Checked because a declared media type is just a string the caller chose. A
 * PDF or an executable labelled `image/jpeg` should be refused here rather
 * than sent to a vision model to see what happens.
 */
const SIGNATURES: Record<string, readonly number[][]> = {
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  // RIFF....WEBP — the four bytes at offset 8 are checked separately.
  'image/webp': [[0x52, 0x49, 0x46, 0x46]],
};

export function validateImage(
  data: string,
  mediaType: string,
): ImageProblem | null {
  if (data.length === 0) {
    return { code: 'empty', message: 'No image data was supplied.' };
  }

  if (!ALLOWED_MEDIA_TYPES.includes(mediaType as (typeof ALLOWED_MEDIA_TYPES)[number])) {
    return {
      code: 'unsupported_media_type',
      message: `Images must be JPEG, PNG or WebP. Received ${mediaType}.`,
    };
  }

  const bytes = decodedByteLength(data);
  if (bytes > MAX_IMAGE_BYTES) {
    return {
      code: 'too_large',
      message: `Image is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_IMAGE_BYTES / 1024} KB.`,
    };
  }

  let head: Uint8Array;
  try {
    head = decodeHead(data, 16);
  } catch {
    return { code: 'malformed', message: 'Image data is not valid base64.' };
  }

  if (!matchesSignature(head, mediaType)) {
    return {
      code: 'malformed',
      message: `Data does not look like a ${mediaType} image.`,
    };
  }

  return null;
}

/** Decodes only the first `count` bytes — enough to check a signature. */
function decodeHead(base64: string, count: number): Uint8Array {
  // Base64 works in 4-character groups producing 3 bytes each.
  const groups = Math.ceil(count / 3);
  const slice = base64.slice(0, groups * 4);
  const binary = atob(slice);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function matchesSignature(head: Uint8Array, mediaType: string): boolean {
  const candidates = SIGNATURES[mediaType];
  if (!candidates) return false;

  const matched = candidates.some((signature) =>
    signature.every((byte, index) => head[index] === byte),
  );
  if (!matched) return false;

  if (mediaType === 'image/webp') {
    // "WEBP" at offset 8, after the RIFF header and length.
    const tag = [0x57, 0x45, 0x42, 0x50];
    return tag.every((byte, index) => head[8 + index] === byte);
  }

  return true;
}
