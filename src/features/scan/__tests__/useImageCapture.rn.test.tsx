import { act, renderHook, waitFor } from '@testing-library/react-native';

import { MAX_IMAGE_BYTES } from '@/features/ai/image';
import type { ScanImage } from '@/features/ai/provider';
import type { Result } from '@/lib/result';
import { useImageCapture } from '../useImageCapture';

const mockRequestCamera = jest.fn();
const mockRequestLibrary = jest.fn();
const mockLaunchCamera = jest.fn();
const mockLaunchLibrary = jest.fn();

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: () => mockRequestCamera(),
  requestMediaLibraryPermissionsAsync: () => mockRequestLibrary(),
  launchCameraAsync: (options: unknown) => mockLaunchCamera(options),
  launchImageLibraryAsync: (options: unknown) => mockLaunchLibrary(options),
}));

/**
 * Getting an image out of the device.
 *
 * The permission states are the interesting part: "not yet asked", "denied,
 * ask again" and "denied for good" need different things from the user, and
 * showing the wrong one makes the feature look broken rather than blocked.
 */

const asset = (overrides: Record<string, unknown> = {}) => ({
  canceled: false,
  assets: [
    {
      base64: Buffer.alloc(2048, 1).toString('base64'),
      mimeType: 'image/jpeg',
      uri: 'file:///tmp/scan.jpg',
      ...overrides,
    },
  ],
});

/**
 * Runs a capture and hands back what it returned.
 *
 * The cast is unavoidable: TypeScript cannot see that the callback passed to
 * `act` runs synchronously with respect to the assignment, so it narrows the
 * variable to `never`. Confined to this one helper rather than repeated at
 * every call site.
 */
async function capture(
  hook: { current: ReturnType<typeof useImageCapture> },
  source: 'camera' | 'library',
): Promise<Result<ScanImage> | null> {
  let outcome: Result<ScanImage> | null = null;

  await act(async () => {
    outcome = await hook.current.capture(source);
  });

  return outcome as Result<ScanImage> | null;
}

beforeEach(() => {
  mockRequestCamera.mockReset().mockResolvedValue({ granted: true, canAskAgain: true });
  mockRequestLibrary.mockReset().mockResolvedValue({ granted: true, canAskAgain: true });
  mockLaunchCamera.mockReset().mockResolvedValue(asset());
  mockLaunchLibrary.mockReset().mockResolvedValue(asset());
});

describe('useImageCapture', () => {
  it('returns a prepared image from the camera', async () => {
    const { result } = renderHook(() => useImageCapture());

    const outcome = await capture(result, 'camera');

    expect(outcome).not.toBeNull();
    expect(outcome?.ok).toBe(true);
    if (outcome && outcome.ok) {
      expect(outcome.value.mediaType).toBe('image/jpeg');
      expect(outcome.value.byteLength).toBe(2048);
    }
  });

  it('asks for the camera before opening it', async () => {
    const { result } = renderHook(() => useImageCapture());
    await capture(result, 'camera');

    expect(mockRequestCamera).toHaveBeenCalled();
    expect(mockRequestLibrary).not.toHaveBeenCalled();
  });

  it('asks for the library when picking an existing photo', async () => {
    const { result } = renderHook(() => useImageCapture());
    await capture(result, 'library');

    expect(mockRequestLibrary).toHaveBeenCalled();
    expect(mockLaunchLibrary).toHaveBeenCalled();
  });

  it('does not open the camera when permission is refused', async () => {
    mockRequestCamera.mockResolvedValue({ granted: false, canAskAgain: true });
    const { result } = renderHook(() => useImageCapture());

    const outcome = await capture(result, 'camera');

    expect(mockLaunchCamera).not.toHaveBeenCalled();
    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) {
      expect(outcome.error.code).toBe('permission_denied');
      // Asking again is worth a try, so the UI may offer one.
      expect(outcome.error.retryable).toBe(true);
    }
  });

  it('says to go to Settings when permission cannot be asked for again', async () => {
    mockRequestCamera.mockResolvedValue({ granted: false, canAskAgain: false });
    const { result } = renderHook(() => useImageCapture());

    const outcome = await capture(result, 'camera');

    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) {
      expect(outcome.error.code).toBe('permission_blocked');
      expect(outcome.error.message).toMatch(/Settings/);
      expect(outcome.error.message).toMatch(/by hand/);
      // Retrying the prompt would do nothing, so the UI must not offer it.
      expect(outcome.error.retryable).toBe(false);
    }
  });

  it('treats cancelling as a change of mind, not a failure', async () => {
    mockLaunchCamera.mockResolvedValue({ canceled: true, assets: null });
    const { result } = renderHook(() => useImageCapture());

    const outcome = await capture(result, 'camera');

    expect(outcome).toBeNull();
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it('rejects an image that is too large to send', async () => {
    mockLaunchLibrary.mockResolvedValue(
      asset({ base64: Buffer.alloc(MAX_IMAGE_BYTES + 1024, 1).toString('base64') }),
    );
    const { result } = renderHook(() => useImageCapture());

    const outcome = await capture(result, 'library');

    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) expect(outcome.error.code).toBe('image_too_large');
  });

  it('rejects a format the provider cannot read', async () => {
    mockLaunchLibrary.mockResolvedValue(
      asset({ mimeType: 'image/heic', uri: 'file:///tmp/a.heic' }),
    );
    const { result } = renderHook(() => useImageCapture());

    const outcome = await capture(result, 'library');

    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) {
      expect(outcome.error.code).toBe('unsupported_media_type');
    }
  });

  it('survives the picker throwing', async () => {
    mockLaunchCamera.mockRejectedValue(new Error('camera unavailable'));
    const { result } = renderHook(() => useImageCapture());

    const outcome = await capture(result, 'camera');

    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) expect(outcome.error.code).toBe('capture_failed');
  });

  it('captures at a bounded quality rather than full resolution', async () => {
    const { result } = renderHook(() => useImageCapture());
    await capture(result, 'camera');

    const options = mockLaunchCamera.mock.calls[0]![0] as Record<string, unknown>;

    expect(options.base64).toBe(true);
    expect(options.quality).toBeLessThan(1);
    expect(options.allowsMultipleSelection).toBe(false);
    // Location and camera metadata are not needed to read a label.
    expect(options.exif).toBe(false);
  });

  it('clears a previous error so the next attempt starts clean', async () => {
    mockRequestCamera.mockResolvedValue({ granted: false, canAskAgain: true });
    const { result } = renderHook(() => useImageCapture());

    await capture(result, 'camera');
    await waitFor(() => expect(result.current.error).not.toBeNull());

    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});
