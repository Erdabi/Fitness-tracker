import {
  MAX_IMAGE_BYTES,
  decodedByteLength,
  prepareImage,
  resolveMediaType,
} from '../image';

/**
 * What is allowed to leave the device.
 *
 * Every pixel sent is billed, and every byte accepted here is a byte the
 * server has to handle, so these limits are a cost control as much as a
 * validation. The server enforces them again — this copy exists so a user
 * finds out before uploading, not after.
 */

/** Base64 of some bytes, without decoding anything at test time. */
const base64OfSize = (bytes: number): string =>
  Buffer.alloc(bytes, 1).toString('base64');

describe('decodedByteLength', () => {
  it('recovers the original size without decoding', () => {
    for (const size of [1, 2, 3, 100, 4095, 4096]) {
      expect(decodedByteLength(base64OfSize(size))).toBe(size);
    }
  });
});

describe('resolveMediaType', () => {
  it('normalises the non-standard image/jpg', () => {
    expect(resolveMediaType({ mimeType: 'image/jpg' })).toBe('image/jpeg');
  });

  it('accepts the three supported types', () => {
    expect(resolveMediaType({ mimeType: 'image/png' })).toBe('image/png');
    expect(resolveMediaType({ mimeType: 'image/webp' })).toBe('image/webp');
    expect(resolveMediaType({ mimeType: 'image/jpeg' })).toBe('image/jpeg');
  });

  it('refuses an image type it does not support rather than guessing', () => {
    expect(resolveMediaType({ mimeType: 'image/heic' })).toBeNull();
    expect(resolveMediaType({ mimeType: 'image/gif' })).toBeNull();
  });

  it('falls back to the file extension when no type is declared', () => {
    expect(resolveMediaType({ uri: 'file:///tmp/label.png' })).toBe('image/png');
    expect(resolveMediaType({ uri: 'file:///tmp/label.PNG' })).toBe('image/png');
    expect(resolveMediaType({ uri: 'file:///tmp/label.png?v=2' })).toBe('image/png');
  });

  it('assumes JPEG for an extensionless URI, which the camera produces', () => {
    expect(resolveMediaType({ uri: 'file:///tmp/IMG_0001' })).toBe('image/jpeg');
  });

  it('resolves nothing from nothing', () => {
    expect(resolveMediaType({})).toBeNull();
  });
});

describe('prepareImage', () => {
  it('accepts an ordinary capture', () => {
    const result = prepareImage({
      base64: base64OfSize(1024),
      mimeType: 'image/jpeg',
      uri: 'file:///tmp/a.jpg',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mediaType).toBe('image/jpeg');
      expect(result.value.byteLength).toBe(1024);
      // No data: prefix — the wire format the function expects.
      expect(result.value.data.startsWith('data:')).toBe(false);
    }
  });

  it('rejects a capture that came back with no data', () => {
    const result = prepareImage({ base64: null, mimeType: 'image/jpeg' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('image_unreadable');
  });

  it('rejects an empty image', () => {
    const result = prepareImage({ base64: '', uri: 'file:///tmp/a.jpg' });
    // An empty string is unreadable rather than zero-length; either way it
    // does not reach the provider.
    expect(result.ok).toBe(false);
  });

  it('rejects an unsupported format', () => {
    const result = prepareImage({ base64: base64OfSize(10), mimeType: 'image/heic' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unsupported_media_type');
  });

  it('rejects anything over the size limit', () => {
    const result = prepareImage({
      base64: base64OfSize(MAX_IMAGE_BYTES + 1),
      mimeType: 'image/jpeg',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('image_too_large');
      // Not retryable: taking the same photo again produces the same bytes.
      expect(result.error.retryable).toBe(false);
    }
  });

  it('accepts an image exactly on the limit', () => {
    const result = prepareImage({
      base64: base64OfSize(MAX_IMAGE_BYTES),
      mimeType: 'image/jpeg',
    });

    expect(result.ok).toBe(true);
  });

  it('mirrors the limit the Edge Function enforces', () => {
    expect(MAX_IMAGE_BYTES).toBe(4 * 1024 * 1024);
  });
});
