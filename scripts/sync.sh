#!/usr/bin/env bash
# Installs the factory layout, mods, theme and sample data into a Herdr app home.
# Usage: scripts/sync.sh [home] [--keys]
#   home    default ~/.config/herdr-app (or $HERDR_APP_HOME)
#   --keys  merge keys.json's sections into the home's keys.json (a backup is kept).
#           Without it, keys are merged only into a home that has no keys.json yet,
#           since editing keys.json stops Herdr upgrading its default shortcuts.
set -euo pipefail
cd "$(dirname "$0")/.."
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"; keys=0
for a in "$@"; do case "$a" in --keys) keys=1 ;; *) home="$a" ;; esac; done

node scripts/gen.mjs --check
mkdir -p "$home/layouts" "$home/themes" "$home/mods" "$home/factory-data"
cp layouts/factory.json "$home/layouts/"
cp themes/factory.json "$home/themes/"
for dir in mods/factory-*/; do
  name=$(basename "$dir")
  # Copies, not symlinks: Herdr refuses imports that resolve outside the mod folder.
  rsync -a --delete --exclude jsconfig.json --exclude '*.d.ts' --exclude lib/ --exclude previews/ "$dir" "$home/mods/$name/"
  mkdir -p "$home/mods/$name/lib"
  cp lib/*.js "$home/mods/$name/lib/"
  printf 'export default %s;\n' "$(cat fixtures/acme-api/status.json)" > "$home/mods/$name/lib/sample.js"
done
mkdir -p "$home/mods/factory-soon/previews"
cp docs/layouts/*.png "$home/mods/factory-soon/previews/"
rsync -a fixtures/ "$home/factory-data/"

if [[ $keys == 1 || ! -f "$home/keys.json" ]]; then
  node - "$home/keys.json" <<'JS'
const fs = require("fs");
const [path] = process.argv.slice(2);
const ours = JSON.parse(fs.readFileSync("keys.json", "utf8"));
let theirs = {};
if (fs.existsSync(path)) {
  theirs = JSON.parse(fs.readFileSync(path, "utf8"));
  fs.copyFileSync(path, `${path}.before-factory-${Date.now()}`);
}
for (const [section, keys] of Object.entries(ours)) theirs[section] = { ...theirs[section], ...keys };
fs.writeFileSync(path, JSON.stringify(theirs, null, 2) + "\n");
JS
  echo "keys merged into $home/keys.json"
else
  echo "keys.json left alone (run with --keys to merge the factory keys)"
fi
echo "synced into $home"
