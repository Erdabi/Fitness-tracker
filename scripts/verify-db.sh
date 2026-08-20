#!/usr/bin/env bash
#
# Applies every migration to a throwaway PostgreSQL database and runs the RLS
# test suite against it.
#
# The point is to exercise the real SQL — signup trigger, policies, cascades,
# updated_at — before it reaches a Supabase project, where a broken policy is
# a data-exposure incident rather than a failed script.
#
# Usage:
#   scripts/verify-db.sh                          # uses $PGHOST/$PGPORT/$PGUSER
#   PGHOST=/tmp PGPORT=55432 scripts/verify-db.sh
#
# Requires: psql, and a PostgreSQL server you can create databases on.

set -euo pipefail

DB_NAME="${DB_NAME:-ft_verify_$$}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export PGHOST="${PGHOST:-/tmp}"
export PGPORT="${PGPORT:-55432}"
export PGUSER="${PGUSER:-postgres}"

# The trap must not change the script's exit status. `cleanup` ending in a
# successful command would mask a failing test suite and make this gate report
# success while the database checks were failing — which it did, before this.
cleanup() {
  local status=$?
  psql -q -d postgres -c "drop database if exists ${DB_NAME};" >/dev/null 2>&1 || true
  return "${status}"
}
trap cleanup EXIT

echo "→ creating ${DB_NAME}"
psql -q -d postgres -c "drop database if exists ${DB_NAME};" >/dev/null
psql -q -d postgres -c "create database ${DB_NAME};" >/dev/null

echo "→ loading Supabase harness (auth schema, roles, auth.uid)"
psql -q -d "${DB_NAME}" -v ON_ERROR_STOP=1 \
  -c "create extension if not exists pgcrypto;" \
  -f "${ROOT}/supabase/tests/harness.sql" >/dev/null

echo "→ applying migrations in filename order"
for migration in $(find "${ROOT}/supabase/migrations" -name '*.sql' | sort); do
  printf '   %s\n' "$(basename "${migration}")"
  psql -q -d "${DB_NAME}" -v ON_ERROR_STOP=1 -f "${migration}" >/dev/null
done

echo "→ running SQL test suites"
# Only NOTICE output carries the assertions; a failure raises and psql exits 3,
# which -e turns into a failed script.
failures=0

for suite in $(find "${ROOT}/supabase/tests" -name '*.test.sql' | sort); do
  printf '\n── %s\n' "$(basename "${suite}")"

  # Captured rather than piped: a pipeline reports the exit status of `sed`,
  # so piping straight into it would discard psql's failure.
  if output=$(psql -d "${DB_NAME}" -v ON_ERROR_STOP=1 -f "${suite}" 2>&1); then
    printf '%s\n' "${output}" | sed -n 's/^psql:[^:]*:[0-9]*: NOTICE:  //p'
  else
    printf '%s\n' "${output}" | sed -n 's/^psql:[^:]*:[0-9]*: NOTICE:  //p'
    printf '%s\n' "${output}" | grep -E 'ERROR|FAIL' || true
    failures=$((failures + 1))
  fi
done

if [ "${failures}" -gt 0 ]; then
  echo
  echo "✗ ${failures} database test suite(s) failed"
  exit 1
fi

echo
echo "✓ database verification passed"
