#!/usr/bin/env bash
#
# Leak check against the built Metro bundle.
#
# Reading the source proves intent; reading the bundle proves outcome. Metro
# follows imports, so anything reachable from the app's entry point ends up
# here — including a module somebody imported "just for a type" that pulled a
# whole server file in with it.
#
# Run against a real export, not a dev server: the dev bundle is not what
# ships. Set BUNDLE to an existing build to skip the export step.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${BUNDLE_DIR:-$ROOT/.bundle-check}"
PLATFORM="${PLATFORM:-android}"

if [ -n "${BUNDLE:-}" ]; then
  BUNDLES=("$BUNDLE")
else
  echo "▸ Exporting the $PLATFORM bundle (this takes a minute)…"
  rm -rf "$OUT"
  npx expo export --platform "$PLATFORM" --output-dir "$OUT" --no-minify >/dev/null
  mapfile -t BUNDLES < <(find "$OUT" -name '*.hbc' -o -name '*.js' -o -name '*.bundle')
fi

if [ "${#BUNDLES[@]}" -eq 0 ]; then
  echo "✗ No bundle was produced — nothing to check." >&2
  exit 1
fi

echo "▸ Checking ${#BUNDLES[@]} bundle file(s)"

# Hermes stores any string containing a non-ASCII character as UTF-16, so an
# ASCII grep silently misses it. Every bundle is therefore also searched with
# the NUL bytes stripped, which turns UTF-16LE text back into something a
# byte-oriented grep can find. Verified: strings with an em dash appear only
# in this second pass.
WIDE="$(mktemp -d)"
trap 'rm -rf "$WIDE"' EXIT

SCAN=()
for bundle in "${BUNDLES[@]}"; do
  SCAN+=("$bundle")
  widened="$WIDE/$(basename "$bundle").ascii"
  tr -d '\000' < "$bundle" > "$widened"
  SCAN+=("$widened")
done

fail=0

# Each entry is  <label>|<grep -E pattern>
#
# The patterns are what a leak actually looks like, not what one is called: a
# key by its format, a role by its literal name, server-only modules by an
# identifier that exists nowhere else.
CHECKS=(
  "Anthropic API key|sk-ant-[A-Za-z0-9_-]{10,}"
  "ANTHROPIC_API_KEY reference|ANTHROPIC_API_KEY"
  "service-role key or its name|service_role|SUPABASE_SERVICE_ROLE_KEY"
  "Anthropic SDK|@anthropic-ai/sdk"
  "direct Anthropic endpoint|api\\.anthropic\\.com"
  "Edge Function prompt|LABEL_SYSTEM|PHOTO_SYSTEM"
  "ingestion tooling|tools/ingestion|importFoods"
)

for check in "${CHECKS[@]}"; do
  label="${check%%|*}"
  pattern="${check#*|}"

  if grep -aoEn "$pattern" "${SCAN[@]}" >/dev/null 2>&1; then
    echo "✗ FOUND $label in the bundle:"
    grep -aoEn "$pattern" "${SCAN[@]}" | head -5
    fail=1
  else
    echo "✓ clean: $label"
  fi
done

# The service key's *value* would be a JWT with a service_role claim. Checked
# separately because the encoded form does not contain the literal string.
if grep -aoEn 'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}' "${SCAN[@]}" >/dev/null 2>&1; then
  while read -r token; do
    payload="$(printf '%s' "$token" | cut -d. -f2)"
    # base64url, padded to a multiple of four.
    padded="$payload$(printf '%*s' $(( (4 - ${#payload} % 4) % 4 )) '' | tr ' ' '=')"
    decoded="$(printf '%s' "$padded" | tr '_-' '/+' | base64 -d 2>/dev/null || true)"

    if printf '%s' "$decoded" | grep -q 'service_role'; then
      echo "✗ A JWT in the bundle carries the service_role claim"
      fail=1
    fi
  done < <(grep -aoEh 'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}' "${SCAN[@]}" | sort -u)
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "✗ Bundle leak check FAILED" >&2
  exit 1
fi

echo
echo "✓ Bundle leak check passed"
