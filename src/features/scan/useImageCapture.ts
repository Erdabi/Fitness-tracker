import * as ImagePicker from 'expo-image-picker';
import { useCallback, useState } from 'react';

import { CAPTURE_QUALITY, prepareImage } from '@/features/ai/image';
import type { ScanImage } from '@/features/ai/provider';
import { appError, type AppError, type Result } from '@/lib/result';

/**
 * Getting an image, from the camera or the library.
 *
 * Both routes end in `prepareImage`, so the size and format rules are applied
 * once regardless of where the picture came from — a 12 MP shot from the
 * gallery is subject to the same limits as a fresh capture.
 *
 * `expo-image-picker` is used for both rather than driving `CameraView`
 * directly: it hands back base64 and handles the permission prompt, the
 * system camera UI and cancellation, all of which would otherwise be three
 * more states to get right for no gain. The live `CameraView` is reserved for
 * barcode scanning, where continuous frame analysis is the whole point.
 */

export type CaptureSource = 'camera' | 'library';

export interface CaptureState {
  readonly isBusy: boolean;
  readonly error: AppError | null;
}

/**
 * Compression and sizing, applied at capture.
 *
 * Resizing here rather than afterwards means a full-resolution bitmap is never
 * decoded on the device. Vision cost scales with pixels, so this is the single
 * biggest lever on what a scan costs.
 */
const OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  base64: true,
  quality: CAPTURE_QUALITY,
  // One image per scan. Multiple foods in one photo are handled by the model,
  // not by multiple uploads.
  allowsMultipleSelection: false,
  exif: false,
};

export function useImageCapture() {
  const [state, setState] = useState<CaptureState>({ isBusy: false, error: null });

  const capture = useCallback(
    async (source: CaptureSource): Promise<Result<ScanImage> | null> => {
      setState({ isBusy: true, error: null });

      try {
        const permission =
          source === 'camera'
            ? await ImagePicker.requestCameraPermissionsAsync()
            : await ImagePicker.requestMediaLibraryPermissionsAsync();

        if (!permission.granted) {
          const error = permissionError(source, permission.canAskAgain);
          setState({ isBusy: false, error });
          return { ok: false, error };
        }

        const result =
          source === 'camera'
            ? await ImagePicker.launchCameraAsync(OPTIONS)
            : await ImagePicker.launchImageLibraryAsync(OPTIONS);

        // Cancelling is not an error — the user changed their mind, and the
        // screen should simply go back to where it was.
        if (result.canceled) {
          setState({ isBusy: false, error: null });
          return null;
        }

        const asset = result.assets[0];
        if (!asset) {
          const error = appError('validation', 'No image was returned.', {
            code: 'no_asset',
            retryable: true,
          });
          setState({ isBusy: false, error });
          return { ok: false, error };
        }

        const prepared = prepareImage({
          base64: asset.base64,
          mimeType: asset.mimeType,
          uri: asset.uri,
        });

        setState({ isBusy: false, error: prepared.ok ? null : prepared.error });
        return prepared;
      } catch {
        const error = appError('unknown', 'The camera could not be opened.', {
          code: 'capture_failed',
          retryable: true,
        });
        setState({ isBusy: false, error });
        return { ok: false, error };
      }
    },
    [],
  );

  const clearError = useCallback(() => {
    setState((current) => ({ ...current, error: null }));
  }, []);

  return { ...state, capture, clearError };
}

/**
 * Permission refusal, worded by whether it can be asked for again.
 *
 * "Denied, ask again" and "denied permanently" need different things from the
 * user — one is another tap, the other is a trip to Settings — and telling
 * them the wrong one is how a feature looks broken.
 */
function permissionError(source: CaptureSource, canAskAgain: boolean): AppError {
  const subject = source === 'camera' ? 'camera' : 'photo library';

  return appError(
    'validation',
    canAskAgain
      ? `Scanning needs access to your ${subject}.`
      : `Access to your ${subject} is turned off. You can enable it in Settings, or enter the food by hand.`,
    { code: canAskAgain ? 'permission_denied' : 'permission_blocked', retryable: canAskAgain },
  );
}
