# Android APK releases

How a git tag becomes an installable APK, with no Android SDK on your machine.

---

## 1. The workflow, once set up

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub then, automatically:

1. Runs the full verification gate against the tagged commit — TypeScript,
   ESLint, the Jest suite, the database/RLS suite, and the bundle secret-leak
   check.
2. If all of that passes, builds an Android APK via [EAS
   Build](https://docs.expo.dev/build/introduction/).
3. Uploads the APK to the workflow run (**Actions → the run → Artifacts**).
4. Creates a GitHub Release named `v1.0.0` with the APK attached.

Download the APK from either place and drag it into LDPlayer — LDPlayer
installs a dragged-in `.apk` on drop. Nothing else to configure.

A commit with no tag never triggers this — see `.github/workflows/ci.yml` for
what runs on ordinary pushes and pull requests instead (typecheck, lint, test,
database; no build, no APK). Only `git push origin vX.Y.Z` starts a build.

---

## 2. One-time setup (do this once, before the first tag)

Nothing below touches your PC's Android SDK, `adb`, or emulator setup — it's
entirely about registering this project with EAS and telling GitHub how to
reach it.

### 2.1 Create the EAS project

```bash
npx eas-cli@22.4.0 login       # opens a browser once; creates an Expo account if needed
npx eas-cli@22.4.0 init        # registers this project on expo.dev
```

`init` prints a project id (a UUID). Because `app.config.ts` is a `.ts` file
rather than `app.json`, the CLI can't write the id back into it automatically
— it will tell you to add it yourself. Put it in `.env.local`:

```bash
# .env.local (not committed — see .gitignore)
EAS_PROJECT_ID=<the uuid eas init printed>
```

This isn't a secret — it's a public identifier embedded in every build's
manifest regardless of who set it (see the comment in `app.config.ts`). It's
kept out of the repo only so a fork doesn't inherit your project by accident.

### 2.2 Create a CI access token

**expo.dev → Account settings → Access Tokens → Create.** Copy the value —
you won't see it again.

This token authenticates the GitHub Actions workflow to EAS. It is **not** a
Supabase or Anthropic key, and the app itself never reads it — it authorises
the build *request*, not anything inside the APK.

### 2.3 Configure GitHub

**Repo → Settings → Secrets and variables → Actions:**

| Kind | Name | Value |
|---|---|---|
| **Secret** | `EXPO_TOKEN` | The access token from 2.2 |
| **Variable** | `EAS_PROJECT_ID` | The project id from 2.1 |

Secret vs. variable is deliberate: the token can build under your account and
must stay secret; the project id is public information, so it's a plain
repository *variable*, visible in workflow logs, exactly as sensitive as
nothing.

### 2.4 Give the "preview" build your Supabase values

The APK needs `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`
to run against your Supabase project — the same two values from
`.env.example`, which are safe to publish (the anon key only grants what Row
Level Security allows). Pick one:

- **Recommended — EAS Environment Variables**, scoped to the `preview`
  environment `eas.json`'s `preview` profile already declares:

  ```bash
  npx eas-cli@22.4.0 env:set preview \
    --name EXPO_PUBLIC_SUPABASE_URL --value https://your-project-ref.supabase.co \
    --visibility plaintext --non-interactive

  npx eas-cli@22.4.0 env:set preview \
    --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value your-anon-key \
    --visibility plaintext --non-interactive
  ```

  EAS pulls these in automatically for every `preview` build, on every
  machine, without touching this repo.

- **Alternative — commit them.** Since they're already documented as
  publishable, you may instead add them directly under `build.preview.env` in
  `eas.json`. Simpler, but ties the checked-in config to one specific Supabase
  project.

Until one of these is done, the APK will build but the app inside it will
fail its startup configuration check (the same `env.ts` validation that
protects local dev).

---

## 3. What's actually in `eas.json`

```json
{
  "cli": { "appVersionSource": "remote" },
  "build": {
    "preview": {
      "distribution": "internal",
      "android": { "buildType": "apk" }
    }
  }
}
```

- **`buildType: "apk"`** — an installable file, not an `.aab` (Play Store
  bundles aren't directly installable; this is what requirement 3 asked for).
- **`distribution: "internal"`** — not submitted anywhere, just a downloadable
  build.
- **`appVersionSource: "remote"`** — Android's `versionCode` is a strictly
  increasing integer the *store* cares about; EAS tracks it on its own servers
  so every build gets a fresh one automatically. This repo never hardcodes
  one.

Verified by resolving this exact profile against the real `@expo/eas-json`
package (the one `eas-cli` itself uses) rather than assumed — see the commit
that introduced it for the offline check that ran.

---

## 4. Where the version number comes from

`app.config.ts`:

```ts
version: process.env.APP_VERSION ?? '0.1.0',
```

The release workflow sets `APP_VERSION` from the tag (`v1.2.3` → `1.2.3`)
before invoking the build. Nothing increments anything — the version is
exactly what you typed in `git tag`. Locally, with `APP_VERSION` unset, the
static default is used, so `expo start`, tests, and manual `eas build` runs
are unaffected. This is the *only* thing the release pipeline overrides;
every other build (dev, CI, a manual preview build) uses the app's normal,
hand-set version.

The Android `versionCode` — a separate integer Android itself uses to decide
whether one APK supersedes another — is unrelated and left to EAS's remote
counter (§3), so it never needs to be reasoned about here.

---

## 5. Building a preview APK without tagging anything

```bash
export EXPO_TOKEN=...      # from §2.2
export EAS_PROJECT_ID=...  # or put it in .env.local
scripts/build-android-apk.sh
```

Produces `fitness-tracker-preview.apk` in the repo root. This is exactly what
the release workflow runs — same script, same profile — so it's a faithful
way to test a branch before ever pushing a tag. Pass a path as the one
argument to name the output differently.

---

## 6. Security

- **The APK never contains a Supabase service-role key or an Anthropic key.**
  Neither is read by `app.config.ts`, neither is a valid `EXPO_PUBLIC_*` name,
  and the `bundle-security` job re-proves this on every release by exporting a
  real bundle and grepping it — the identical check documented in
  `docs/scanning.md` §2, run again here rather than trusted to still hold.
- **`EXPO_TOKEN` cannot reach the APK.** It's consumed entirely by the EAS CLI
  process on the GitHub Actions runner, to authenticate the *build request*.
  It is never passed as a build-time `env` value in `eas.json`, so it is never
  a candidate for inlining, unlike `EXPO_PUBLIC_*` values.
- **`EAS_PROJECT_ID` is intentionally not secret** — see §2.1. Treating it as
  one would be the wrong kind of caution: it's already public in every build.
- All four release jobs (`verify`, `database`, `bundle-security`,
  `build-android`) must pass before an APK is built; `build-android` cannot
  start otherwise (`needs: [verify, database, bundle-security]` in
  `.github/workflows/release-android.yml`).

---

## 7. Reproducibility

- `eas-cli` is invoked as `npx eas-cli@22.4.0` — an exact pinned version, not
  `@latest` — both in `scripts/build-android-apk.sh` and as the floor in
  `eas.json`'s `cli.version`. Bump both together, deliberately, the same
  convention this repo already uses for `SET_LIMITS` and other
  duplicated-on-purpose constants.
- Given the same tag and the same EAS environment configuration, the same
  source produces the same APK modulo the versionCode (§3) and the compiler's
  own build id — nothing here introduces a random or time-based input beyond
  those two, both of which are Android/EAS's, not this pipeline's.

---

## 8. What is and isn't verified here

**Verified in this environment**, without an Expo account or network access
to Expo's build servers (neither is available here):

- `eas.json`'s `preview` profile resolves to exactly `distribution: internal`,
  `buildType: apk` — checked by loading the real `@expo/eas-json@22.0.0`
  package (matching the pinned CLI) and calling its own `resolveBuildProfile`
  function against this file, not by reading the schema and hoping.
- `eas build --json`'s output shape (`artifacts.applicationArchiveUrl`) —
  confirmed by reading `eas-cli`'s own GraphQL fragment, not assumed.
- `EXPO_TOKEN` is `eas-cli`'s documented non-interactive auth mechanism —
  confirmed by reading `SessionManager.js`.
- `app.config.ts` evaluates correctly with and without `APP_VERSION` /
  `EAS_PROJECT_ID` set (`npx expo config`, both ways, checked directly).
- The full existing verification gate — tsc, ESLint, all 1,161 Jest tests, the
  428-assertion database suite, and `check:bundle` (with `APP_VERSION` and
  `EAS_PROJECT_ID` set, mirroring the release job exactly) — all still pass.
- `.github/workflows/release-android.yml` and `scripts/build-android-apk.sh`
  pass `actionlint` (with embedded `shellcheck`) and `shellcheck` respectively
  — zero findings.

**Not verified here, and cannot be from this environment:**

- **An actual EAS build was never run.** There is no `EXPO_TOKEN` or
  registered EAS project available in this session. Everything above the
  network boundary — the request `eas build` makes, the remote build
  finishing, the APK it produces installing on a real device — is
  unavailable to test from here. The first real signal that this works end to
  end is your first pushed tag.
- **LDPlayer was not driven from here.** No emulator, no `adb`, matching
  Milestone 7's Android section.
