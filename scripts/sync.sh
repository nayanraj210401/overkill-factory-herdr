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
cp layouts/factory.json layouts/factory.svg "$home/layouts/"
cp themes/factory.json "$home/themes/"
for dir in mods/factory-*/; do
  name=$(basename "$dir")
  # Copies, not symlinks: Herdr refuses imports that resolve outside the mod folder.
  rsync -a --delete --exclude jsconfig.json --exclude '*.d.ts' --exclude lib/ --exclude previews/ "$dir" "$home/mods/$name/"
  mkdir -p "$home/mods/$name/lib"
  cp lib/*.js "$home/mods/$name/lib/"
  printf 'export default %s;\n' "$(cat fixtures/acme-api/status.json)" > "$home/mods/$name/lib/sample.js"
  printf 'export default %s;\n' "$(cat fixtures/acme-api/reviews.json)" > "$home/mods/$name/lib/sample-reviews.js"
  # How the window runs the factory CLI: bun + this checkout's source, so it can't go
  # stale the way a dist/factory built from an older commit can.
  printf 'export default ["%s", "%s"];\n' "$(command -v bun)" "$PWD/daemon/cli.ts" > "$home/mods/$name/lib/cli.js"
done
# The V2 Ticket page embeds factory-chat's view (mods/factory-chat/chat/): a mod can't import
# another mod's files, so the page gets its own copy, beside its lib/ as in factory-chat.
rsync -a --delete mods/factory-chat/chat/ "$home/mods/factory-ticket/chat/"
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
// Bare keys earlier versions bound (scripts/gen.mjs RETIRED_KEYS): they took letters from text boxes.
const retired = { "layout:factory": ["g f", "]", "["], terminal: ["g", "[", "]"] };
for (const [section, list] of Object.entries(retired)) {
  for (const k of list) if (theirs[section] && k in theirs[section]) delete theirs[section][k];
  if (theirs[section] && !Object.keys(theirs[section]).length) delete theirs[section];
}
fs.writeFileSync(path, JSON.stringify(theirs, null, 2) + "\n");
JS
  echo "keys merged into $home/keys.json"
else
  echo "keys.json left alone (run with --keys to merge the factory keys)"
fi
echo "synced into $home"

# The service runs this checkout's daemon: restart it so it runs the same code the mods
# just got, not what it loaded at its last start.
if [[ "$home" == "$HOME/.config/herdr-app" ]] && launchctl print "gui/$(id -u)/dev.overkill.factory" >/dev/null 2>&1; then
  bun daemon/cli.ts service restart
fi
