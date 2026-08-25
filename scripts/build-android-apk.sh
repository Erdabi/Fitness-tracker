#!/usr/bin/env bash
#
# Builds an installable Android APK via EAS Build's "preview" profile and
# downloads it locally.
#
# Called by .github/workflows/release-android.yml on every version tag, and
# runnable by hand the same way — the release pipeline is exactly what a
# developer would type themselves, nothing CI-only about it. Useful for
# trying a preview build from a branch before ever cutting a tag.
#
# Requires:
#   EXPO_TOKEN      An EAS access token (expo.dev → Account settings →
#                    Access Tokens). Read directly by eas-cli; no `eas login`
#                    needed.
#   EAS_PROJECT_ID  This project's EAS project id. Run `eas init` once (see
#                    docs/android-builds.md) to obtain it.
#
# Optional:
#   APP_VERSION     Overrides the app version baked into this build (see
#                    app.config.cjs). Defaults to app.config.cjs's own default
#                    when unset — this script never invents a version.
#
# Usage:
#   scripts/build-android-apk.sh [output-path]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Pinned for reproducibility — the same command produces a build from the
# same toolchain regardless of when it runs. Bump deliberately, matching the
# ">=" floor in eas.json's cli.version.
EAS_CLI_VERSION="22.4.0"

OUTPUT="${1:-fitness-tracker-preview.apk}"

: "${EXPO_TOKEN:?EXPO_TOKEN is not set — see docs/android-builds.md}"
: "${EAS_PROJECT_ID:?EAS_PROJECT_ID is not set — run 'eas init' once, see docs/android-builds.md}"

echo "▸ Building Android APK (profile: preview, version: ${APP_VERSION:-<app.config.cjs default>})"

RESULT_JSON="$(mktemp)"
trap 'rm -f "$RESULT_JSON"' EXIT

npx --yes "eas-cli@${EAS_CLI_VERSION}" build \
  --platform android \
  --profile preview \
  --non-interactive \
  --wait \
  --json >"$RESULT_JSON"

# `eas build --json` prints a JSON array, one entry per platform requested —
# one element here, since this always asks for exactly `--platform android`.
STATUS="$(node -p "require('$RESULT_JSON')[0].status")"
if [ "$STATUS" != "FINISHED" ]; then
  echo "✗ EAS build did not finish successfully (status: $STATUS)" >&2
  node -p "JSON.stringify(require('$RESULT_JSON')[0].error, null, 2)" >&2 || true
  exit 1
fi

APK_URL="$(node -p "require('$RESULT_JSON')[0].artifacts.applicationArchiveUrl")"
if [ -z "$APK_URL" ] || [ "$APK_URL" = "undefined" ]; then
  echo "✗ Build finished but reported no APK download URL" >&2
  cat "$RESULT_JSON" >&2
  exit 1
fi

echo "▸ Downloading APK…"
curl -fSL "$APK_URL" -o "$OUTPUT"

echo "✓ APK written to $OUTPUT"
