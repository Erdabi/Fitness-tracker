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

cleanup() {
  psql -q -d postgres -c "drop database if exists ${DB_NAME};" >/dev/null 2>&1 || true
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

echo "→ running RLS test suite"
# Only NOTICE output carries the assertions; a failure raises and psql exits 3.
psql -d "${DB_NAME}" -v ON_ERROR_STOP=1 -f "${ROOT}/supabase/tests/rls.test.sql" 2>&1 |
  sed -n 's/^psql:[^:]*:[0-9]*: NOTICE:  //p'

echo
echo "✓ database verification passed"
