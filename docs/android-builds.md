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

## 2. Why the config is `app.config.cjs`, not `app.config.ts`

`eas init`, `eas build:configure`, and `eas build` all need to read the
project's config before doing anything else — and, unlike `expo start`/`npx
expo config`, they don't use this project's own installed `typescript`
(`~6.0.3`) to do it. Each `npx eas-cli@…` invocation resolves its **own**,
separate `typescript` dependency, independent of this repo's
`devDependencies` — and at the time this was fixed, that resolved to
**TypeScript 7**, a release that dropped the `ts.transpileModule` API
`eas-cli`'s config loader (`@expo/require-utils`) depends on to transpile a
`.ts` file. This is a confirmed, then-open upstream bug — [expo/expo#47627,
"expo doesn't compile `app.config.ts` when using typescript 7"][47627], with
a fix already in flight there (expo/expo#47759) but not yet released in the
`eas-cli` versions available when this repo hit it.

With that transpiler unavailable, `@expo/require-utils` falls back to Node's
own native TypeScript-stripping (`node:module`'s `stripTypeScriptTypes`) —
but that API doesn't exist on Node versions before roughly 22.6, and even
where it does, it wasn't enough on its own (see the failure-mode note below).
With **both** unavailable, the loader evaluates `app.config.ts`'s raw,
untranspiled source as plain CommonJS. The first line was
`import type { ConfigContext, ExpoConfig } from 'expo/config';` — plain
CommonJS has no idea what `import` is — and Node's error for exactly that
shape is: **`Cannot use import statement outside a module`**.

Nothing about this was specific to how this file was written; any dynamic
`app.config.ts` hits the identical failure under the same
Node-version/`eas-cli`-resolved-`typescript` combination, since writing one
at all requires `import`/`export` syntax.

**The fix — `app.config.cjs` — was chosen and verified like this:**

- Expo's own docs already name this failure category and its remedy: *"the
  config is transpiled to CommonJS and both .js and .ts files can mix ESM and
  CommonJS syntax. When that mix causes import or require issues, use one of
  the explicit extensions [`.mts`, `.cts`, `.mjs`, `.cjs`] to lock the config
  to a single module format."* (Configure with app config,
  docs.expo.dev/workflow/configuration).
- `.cts` (TypeScript, forced to CommonJS output) was tried first, as the
  option closest to the original file. It was **confirmed insufficient**: it
  still needs a working TypeScript transpiler for its type annotations, and
  under the exact failing combination (a real Node 20.18.1, a real
  `eas-cli@22.4.0`, a real resolved `typescript@7.0.2`, driving `eas-cli`'s
  own unmodified loader directly) it failed with the identical error class as
  `.ts` did. This was tested, not assumed.
- `.cjs` — plain CommonJS, no TypeScript syntax to strip at all — takes the
  same code path plain `.js` always has: Node's native `require()`, no
  transpiler involved, nothing that can be missing. Verified the same way:
  under the identical real Node 20.18.1 + real `eas-cli@22.4.0` + real
  `typescript@7.0.2` combination, `@expo/require-utils`'s own loader — and,
  one layer up, `@expo/config`'s own `getConfig()`, the function `eas-cli`
  actually calls — both load `app.config.cjs` and return the correct config,
  including a working `APP_VERSION`/`EAS_PROJECT_ID` override.

Type safety is not given up: `app.config.cjs` starts with `// @ts-check` and
JSDoc `@param`/`@returns` annotations naming `ConfigContext`/`ExpoConfig`
(from `expo/config`), and is explicitly listed in `tsconfig.json`'s
`include`. `npm run typecheck` catches a wrong or misspelled field in it
exactly as it would in a `.ts` file — confirmed by deliberately introducing
one and watching `tsc` report it, then removing it again.

No application code changed. This is one non-application, never-bundled,
tooling-only file that `expo`/`eas-cli` read as a build input — never
something Metro ships to a device — so this is not a project-wide CommonJS
conversion; every other `.ts`/`.tsx` file is untouched.

[47627]: https://github.com/expo/expo/issues/47627

---

## 3. One-time setup (do this once, before the first tag)

Nothing below touches your PC's Android SDK, `adb`, or emulator setup — it's
entirely about registering this project with EAS and telling GitHub how to
reach it.

### 3.1 Create the EAS project

```bash
npx eas-cli@22.4.0 login       # opens a browser once; creates an Expo account if needed
npx eas-cli@22.4.0 init        # finds or creates the project on expo.dev
```

Because `app.config.cjs` is a dynamic config rather than `app.json`, `init`
can't write the project id back into it automatically. It still finds (or
creates) the project and prints its id — a UUID — but then **warns and exits
non-zero**:

```
Warning: Your project uses dynamic app configuration, and the EAS project ID
can't automatically be added to it.
Cannot automatically write to dynamic config at: app.config.cjs
```

That failure is expected and does not mean the project wasn't created —
by the time it appears, the project already exists on expo.dev under the
printed id. It only means `init` couldn't persist that id into the config
file itself, which is exactly why `app.config.cjs` already reads it from
`process.env.EAS_PROJECT_ID` instead (see the comment in that file) — this
is Expo's own documented pattern for a dynamic config, not a workaround.

**Two places need that id, and they behave differently:**

```bash
# .env.local (not committed — see .gitignore)
EAS_PROJECT_ID=<the uuid eas init printed>
```

`.env.local` alone is enough for anything that goes through Expo's own config
loading — `npx expo config`, `expo start`, `scripts/build-android-apk.sh`
once you've exported it into the shell (see below) — but **not** for `eas
init` itself. `eas-cli` resolves the project id for its own linking checks by
shelling out to `expo config` with dotenv loading explicitly disabled
(`EXPO_NO_DOTENV=1`), so a value that only lives in `.env.local` is invisible
to that one step — confirmed by driving `eas-cli`'s real, unmodified config
loader directly: with `EAS_PROJECT_ID` only in `.env.local` it still resolved
`extra.eas.projectId` as `undefined`. It has to be a real environment
variable in the shell that runs `eas init`:

```bash
export EAS_PROJECT_ID=<the uuid eas init printed>   # or: set -a; source .env.local; set +a
npx eas-cli@22.4.0 init
```

With the id already exported, `init` now resolves `extra.eas.projectId` to a
value that already matches the existing project, reports "Project already
linked", and returns without ever trying to write to `app.config.cjs` — no
warning, no error, and no second project is created. Do this once; every
later command (`build:configure`, `build`) only needs `EAS_PROJECT_ID`
exported the same way, which `scripts/build-android-apk.sh` already requires
(§3.3 below is unaffected — CI sets it as a real GitHub Actions `env:` value,
not a dotenv file, so it was never exposed to this issue).

This id isn't a secret — it's a public identifier embedded in every build's
manifest regardless of who set it (see the comment in `app.config.cjs`). It's
kept out of the repo only so a fork doesn't inherit your project by accident.

### 3.2 Create a CI access token

**expo.dev → Account settings → Access Tokens → Create.** Copy the value —
you won't see it again.

This token authenticates the GitHub Actions workflow to EAS. It is **not** a
Supabase or Anthropic key, and the app itself never reads it — it authorises
the build *request*, not anything inside the APK.

### 3.3 Configure GitHub

**Repo → Settings → Secrets and variables → Actions:**

| Kind | Name | Value |
|---|---|---|
| **Secret** | `EXPO_TOKEN` | The access token from 3.2 |
| **Variable** | `EAS_PROJECT_ID` | The project id from 3.1 |

Secret vs. variable is deliberate: the token can build under your account and
must stay secret; the project id is public information, so it's a plain
repository *variable*, visible in workflow logs, exactly as sensitive as
nothing.

### 3.4 Give the "preview" build your Supabase values

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

## 4. What's actually in `eas.json`

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

## 5. Where the version number comes from

`app.config.cjs`:

```js
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
counter (§4), so it never needs to be reasoned about here.

---

## 6. Building a preview APK without tagging anything

```bash
export EXPO_TOKEN=...      # from §3.2
export EAS_PROJECT_ID=...  # or put it in .env.local
scripts/build-android-apk.sh
```

Produces `fitness-tracker-preview.apk` in the repo root. This is exactly what
the release workflow runs — same script, same profile — so it's a faithful
way to test a branch before ever pushing a tag. Pass a path as the one
argument to name the output differently.

---

## 7. Security

- **The APK never contains a Supabase service-role key or an Anthropic key.**
  Neither is read by `app.config.cjs`, neither is a valid `EXPO_PUBLIC_*`
  name, and the `bundle-security` job re-proves this on every release by
  exporting a real bundle and grepping it — the identical check documented in
  `docs/scanning.md` §2, run again here rather than trusted to still hold.
- **`EXPO_TOKEN` cannot reach the APK.** It's consumed entirely by the EAS CLI
  process on the GitHub Actions runner, to authenticate the *build request*.
  It is never passed as a build-time `env` value in `eas.json`, so it is never
  a candidate for inlining, unlike `EXPO_PUBLIC_*` values.
- **`EAS_PROJECT_ID` is intentionally not secret** — see §3.1. Treating it as
  one would be the wrong kind of caution: it's already public in every build.
- All four release jobs (`verify`, `database`, `bundle-security`,
  `build-android`) must pass before an APK is built; `build-android` cannot
  start otherwise (`needs: [verify, database, bundle-security]` in
  `.github/workflows/release-android.yml`).

---

## 8. Reproducibility

- `eas-cli` is invoked as `npx eas-cli@22.4.0` — an exact pinned version, not
  `@latest` — both in `scripts/build-android-apk.sh` and as the floor in
  `eas.json`'s `cli.version`. Bump both together, deliberately, the same
  convention this repo already uses for `SET_LIMITS` and other
  duplicated-on-purpose constants.
- That pin does not, by itself, pin what `typescript` version `eas-cli`
  resolves — see §2 — which is exactly why the config no longer depends on
  one being resolvable at all.
- Given the same tag and the same EAS environment configuration, the same
  source produces the same APK modulo the versionCode (§4) and the compiler's
  own build id — nothing here introduces a random or time-based input beyond
  those two, both of which are Android/EAS's, not this pipeline's.

---

## 9. What is and isn't verified here

**Verified in this environment**, without an Expo account or network access
to Expo's build servers (neither is available here):

- The exact reported failure — reproduced, not assumed. A real Node 20.18.1
  and a real `eas-cli@22.4.0` install (which really does resolve
  `typescript@7.0.2`, confirmed by reading its `node_modules` directly) were
  used to drive `@expo/require-utils`'s own unmodified loader against the old
  `app.config.ts` content: it failed with the reported error class. The same
  loader, and separately `@expo/config`'s `getConfig()` — the function
  `eas-cli` actually calls — were then run against the real, final
  `app.config.cjs`: both succeeded, returning the correct `name`, `slug`, and
  `version`.
- `APP_VERSION` and `EAS_PROJECT_ID` still override correctly through that
  same real, previously-failing toolchain — not just under this project's own
  newer local Node.
- The `eas init` dynamic-config warning (§3.1) — reproduced and its fix
  confirmed the same way: the real `eas-cli@22.4.0` install's own
  `getPrivateExpoConfigAsync` was called directly against this project. With
  `EAS_PROJECT_ID` unset it resolved `extra.eas.projectId` as `undefined` —
  the exact precondition that makes `eas init` try to write to the config and
  fail. With `EAS_PROJECT_ID` exported as a real environment variable it
  resolved correctly. With the same value placed only in `.env.local` (not
  exported) it was `undefined` again, confirming that step's config
  resolution ignores dotenv files (`eas-cli` passes `EXPO_NO_DOTENV=1` when
  it shells out to `expo config` internally) — read directly out of
  `eas-cli`'s own source, not inferred from behavior.
- `eas.json`'s `preview` profile resolves to exactly `distribution: internal`,
  `buildType: apk` — checked by loading the real `@expo/eas-json@22.0.0`
  package (matching the pinned CLI) and calling its own `resolveBuildProfile`
  function against this file, not by reading the schema and hoping.
- `eas build --json`'s output shape (`artifacts.applicationArchiveUrl`) —
  confirmed by reading `eas-cli`'s own GraphQL fragment, not assumed.
- `EXPO_TOKEN` is `eas-cli`'s documented non-interactive auth mechanism —
  confirmed by reading `SessionManager.js`.
- `npx expo config` — this project's own toolchain, the thing that already
  worked before any of this — still resolves `app.config.cjs` correctly,
  including the `APP_VERSION`/`EAS_PROJECT_ID` overrides.
- Type-checking is unweakened: a deliberately introduced bad field in
  `app.config.cjs` was caught by `tsc` and reported with a normal `error
  TS2353`, then removed again.
- ESLint coverage is unweakened: `app.config.cjs` is genuinely linted (not
  silently skipped) — proven by planting an unused variable and watching
  ESLint report it, the same test used to confirm coverage, not assumed from
  config alone.
- The full existing verification gate — tsc, ESLint, all 1,161 Jest tests, the
  428-assertion database suite, and `check:bundle` (with `APP_VERSION` and
  `EAS_PROJECT_ID` set, mirroring the release job exactly) — all still pass.
- `.github/workflows/release-android.yml` and `scripts/build-android-apk.sh`
  pass `actionlint` (with embedded `shellcheck`) and `shellcheck` respectively
  — zero findings.

**Not verified here, and cannot be from this environment:**

- **An actual authenticated EAS build was never run.** There is no
  `EXPO_TOKEN` or registered EAS project available in this session. The
  specific thing that was broken — reading the project's config — has been
  reproduced and fixed and proven against the real, unmodified `eas-cli`
  code; what remains untested from here is everything past that point: the
  network request itself, the remote build finishing, and the APK it
  produces installing on a real device. The first true end-to-end signal is
  your first pushed tag.
- **LDPlayer was not driven from here.** No emulator, no `adb`, matching
  Milestone 7's Android section.
