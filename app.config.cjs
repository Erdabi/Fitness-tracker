// @ts-check

/**
 * Dynamic Expo config.
 *
 * ── Why `.cjs`, not `.ts` ───────────────────────────────────────────────────
 *
 * Expo, `eas-cli`, and this file's evaluator are three separate tools, each
 * resolving its own `typescript` dependency independently — `eas-cli` (run via
 * `npx`) gets whichever version *its own* dependency tree resolves, which has
 * nothing to do with this project's own pinned `typescript` in
 * `devDependencies`. When that resolves to a `typescript` release without a
 * `transpileModule` API (true of TypeScript 7 — see
 * https://github.com/expo/expo/issues/47627, a live upstream bug at the time
 * this was written) and the machine's Node version predates native TS-stripping
 * support, `@expo/require-utils`'s loader has no way left to transpile
 * `app.config.ts` at all — it evaluates the raw, untranspiled source, and any
 * `import`/`export` or type annotation in it fails immediately as invalid
 * JavaScript: "Cannot use import statement outside a module".
 *
 * A `.ts`/`.cts` config is exposed to that failure mode by construction — it
 * always needs *some* TypeScript transpiler to be resolvable at load time, and
 * that transpiler is chosen by whichever tool is loading the file, not by this
 * project. `.cjs` sidesteps the question entirely: it is already valid,
 * directly-runnable CommonJS, so every loader takes the same fast path plain
 * `.js` always has — Node's own `require()`, no transpilation step, nothing to
 * be missing. This is one of Expo's own documented remedies for exactly this
 * failure category: "the config is transpiled to CommonJS and both .js and .ts
 * files can mix ESM and CommonJS syntax. When that mix causes import or
 * require issues, use one of the explicit extensions [.mts, .cts, .mjs, .cjs]
 * to lock the config to a single module format." (docs.expo.dev, Configure
 * with app config). `.cts`/`.mts` were tried first here and confirmed, by
 * directly driving `eas-cli`'s own loader under Node 20 with a real
 * `typescript@7` resolved (the exact failing combination), to still fail —
 * they still need a working TypeScript compiler for their type annotations,
 * just like `.ts` does. `.cjs` has none to strip, so there is nothing for a
 * missing or incompatible transpiler to fail at.
 *
 * Every other `.ts`/`.tsx` file in the project — the entire app — is
 * unaffected and unchanged; this is one non-application, never-bundled,
 * tooling-only entry point that `expo`/`eas-cli` read as a build input, never
 * a file Metro ships to a device.
 *
 * Type safety is kept via `@ts-check` plus the JSDoc annotations below, which
 * `tsc` enforces exactly as it would a `.ts` file (see the `include` entry for
 * this file in tsconfig.json) — a typo'd or missing field is still a
 * `npm run typecheck` failure, not a silent runtime surprise.
 *
 * Public configuration is read from `EXPO_PUBLIC_*` environment variables and
 * surfaced through `extra`. Anything placed here is compiled into the app
 * bundle and is readable by anyone who unpacks the IPA/APK — only values that
 * are safe to publish belong in this file.
 *
 * Server-side secrets (Supabase service-role key, model provider API keys) are
 * configured as Supabase Edge Function secrets and must never appear here.
 *
 * @param {import('expo/config').ConfigContext} ctx
 * @returns {import('expo/config').ExpoConfig}
 */
module.exports = ({ config }) => ({
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
