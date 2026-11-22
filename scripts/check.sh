#!/usr/bin/env bash
# Every gate a change must pass: unit tests, generated files fresh, and
# `herdr-app check` on every mod, installed into a throwaway Herdr home.
set -euo pipefail
cd "$(dirname "$0")/.."
# The tests make throwaway repos with mkdtemp and leave them behind; give them a temp
# folder of their own and remove it on exit, so runs never pile up in the system's.
scratch=$(mktemp -d)
home=$(mktemp -d)
trap 'rm -rf "$scratch" "$home"' EXIT
export TMPDIR="$scratch"
node --test tests/*.test.mjs
bun test daemon/
node scripts/gen.mjs --check
scripts/sync.sh "$home" >/dev/null
fail=0
for dir in "$home"/mods/factory-*/; do
  HERDR_APP_HOME="$home" herdr-app check "$dir" || fail=1
done
exit $fail
