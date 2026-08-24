import { decodedByteLength, validateImage } from '../images.ts';
import { MAX_IMAGE_BYTES } from '../limits.ts';

/**
 * Server-side image validation.
 *
 * The client applies the same limits, but a client limit is a suggestion —
 * anyone with the anon key can call the function directly. This is the copy
 * that actually protects the provider bill, so what it *refuses* is the whole
 * point.
 *
 * Runs under the node jest project rather than under Deno: this module has no
 * Deno globals, and leaving it untested because of the runtime split would be
 * the wrong trade.
 */

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');

const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];
const WEBP_HEAD = [
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
];

describe('validateImage', () => {
  it('accepts a real JPEG', () => {
    expect(validateImage(b64(JPEG_HEAD), 'image/jpeg')).toBeNull();
  });

  it('accepts a real PNG', () => {
    expect(validateImage(b64(PNG_HEAD), 'image/png')).toBeNull();
  });

  it('accepts a real WebP', () => {
    expect(validateImage(b64(WEBP_HEAD), 'image/webp')).toBeNull();
  });

  it('rejects an empty payload', () => {
    expect(validateImage('', 'image/jpeg')?.code).toBe('empty');
  });

  it('rejects a media type it does not support', () => {
    expect(validateImage(b64(JPEG_HEAD), 'image/heic')?.code).toBe(
      'unsupported_media_type',
    );
    expect(validateImage(b64(JPEG_HEAD), 'application/pdf')?.code).toBe(
      'unsupported_media_type',
    );
  });

  it('rejects a PDF wearing a JPEG media type', () => {
    // "%PDF-1.7" — a declared media type is just a string the caller chose.
    const pdf = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37];
    expect(validateImage(b64(pdf), 'image/jpeg')?.code).toBe('malformed');
  });

  it('rejects an ELF binary wearing a PNG media type', () => {
    const elf = [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00];
    expect(validateImage(b64(elf), 'image/png')?.code).toBe('malformed');
  });

  it('rejects a PNG sent as a JPEG', () => {
    expect(validateImage(b64(PNG_HEAD), 'image/jpeg')?.code).toBe('malformed');
  });

  it('rejects a RIFF container that is not WebP', () => {
    // RIFF....WAVE — a sound file, not an image.
    const wave = [
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74,
    ];
    expect(validateImage(b64(wave), 'image/webp')?.code).toBe('malformed');
  });

  it('rejects text that is not base64 at all', () => {
    const problem = validateImage('!!!! not base64 !!!!', 'image/jpeg');
    expect(problem?.code).toBe('malformed');
  });

  it('rejects a truncated header', () => {
    // Two bytes of a JPEG signature is not a JPEG.
    expect(validateImage(b64([0xff, 0xd8]), 'image/jpeg')?.code).toBe('malformed');
  });

  it('rejects anything over the size limit before decoding it', () => {
    // Deliberately not a real image: the size check must fire first, so a
    // hostile upload is refused on its length rather than after expansion.
    const huge = 'A'.repeat(Math.ceil(((MAX_IMAGE_BYTES + 1024) * 4) / 3));
    expect(validateImage(huge, 'image/jpeg')?.code).toBe('too_large');
  });

  it('mirrors the limit the client applies', () => {
    expect(MAX_IMAGE_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe('decodedByteLength', () => {
  it('recovers the size from padded and unpadded base64 alike', () => {
    for (const size of [1, 2, 3, 4, 100, 4095]) {
      expect(decodedByteLength(Buffer.alloc(size, 7).toString('base64'))).toBe(size);
    }
  });
});
