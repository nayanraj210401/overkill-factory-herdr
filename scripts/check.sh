#!/usr/bin/env bash
# Every gate a change must pass: unit tests, generated files fresh, and
# `herdr-app check` on every mod, installed into a throwaway Herdr home.
set -euo pipefail
cd "$(dirname "$0")/.."
node --test tests/*.test.mjs
node scripts/gen.mjs --check
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT
scripts/sync.sh "$home" >/dev/null
fail=0
for dir in "$home"/mods/factory-*/; do
  HERDR_APP_HOME="$home" herdr-app check "$dir" || fail=1
done
exit $fail
