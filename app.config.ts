import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Dynamic Expo config.
 *
 * Public configuration is read from `EXPO_PUBLIC_*` environment variables and
 * surfaced through `extra`. Anything placed here is compiled into the app
 * bundle and is readable by anyone who unpacks the IPA/APK — only values that
 * are safe to publish belong in this file.
 *
 * Server-side secrets (Supabase service-role key, model provider API keys) are
 * configured as Supabase Edge Function secrets and must never appear here.
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Fitness Tracker',
  slug: 'fitness-tracker',
  /*
   * Defaults to the last hand-set release version for local dev, `expo
   * start`, and tests. The Android release workflow overrides it with the
   * pushed git tag (see .github/workflows/release-android.yml), so the app's
   * version and the APK that built it always match the tag that triggered
   * it — never incremented automatically outside of that one explicit path.
   * The Android versionCode itself is managed remotely by EAS instead of
   * here; see the `appVersionSource` note in eas.json.
   */
  version: process.env.APP_VERSION ?? '0.1.0',
  orientation: 'portrait',
  scheme: 'fitnesstracker',
  userInterfaceStyle: 'automatic',
  icon: './assets/images/icon.png',

  ios: {
    supportsTablet: false,
    bundleIdentifier: 'com.fitnesstracker.app',
    infoPlist: {
      // Required for barcode scanning and the AI label/meal capture flows.
      NSCameraUsageDescription:
        'Fitness Tracker uses the camera to scan barcodes and photograph nutrition labels and meals so you can log food without typing it in.',
      NSPhotoLibraryUsageDescription:
        'Fitness Tracker can read nutrition labels and meal photos from your photo library so you can log food you already photographed.',
      ITSAppUsesNonExemptEncryption: false,
    },
  },

  android: {
    package: 'com.fitnesstracker.app',
    adaptiveIcon: {
      backgroundColor: '#0E1116',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    permissions: ['android.permission.CAMERA'],
    // The app never records audio; opt out explicitly so the store listing
    // does not advertise a microphone permission users would have to justify.
    blockedPermissions: ['android.permission.RECORD_AUDIO'],
  },

  web: {
    output: 'static',
    favicon: './assets/images/favicon.png',
  },

  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-sqlite',
    [
      'expo-camera',
      {
        cameraPermission:
          'Fitness Tracker uses the camera to scan barcodes and photograph nutrition labels and meals.',
        recordAudioAndroid: false,
      },
    ],
    [
      'expo-splash-screen',
      {
        backgroundColor: '#0E1116',
        image: './assets/images/splash-icon.png',
        imageWidth: 84,
      },
    ],
  ],

  experiments: {
    typedRoutes: true,
  },

  extra: {
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    // Surfaced so the app can label non-production builds in the UI.
    appEnv: process.env.EXPO_PUBLIC_APP_ENV ?? 'development',
    /*
     * Links this project to an EAS project on expo.dev, so `eas build` knows
     * where to send a build request. Not a secret — a project id is public
     * information embedded in every build's manifest regardless of who set
     * it. Left unset (and therefore absent from `extra`) until the one-time
     * `eas init` has been run; see docs/android-builds.md. `eas build` fails
     * with an explicit, readable error rather than silently creating a
     * project when it is missing.
     */
    ...(process.env.EAS_PROJECT_ID
      ? { eas: { projectId: process.env.EAS_PROJECT_ID } }
      : {}),
  },
});
