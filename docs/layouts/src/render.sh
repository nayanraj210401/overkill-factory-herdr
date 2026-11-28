#!/bin/sh
# Renders each mockup here to ../<name>.png with headless Chrome: sh docs/layouts/src/render.sh [name...]
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
names="$*"; [ -n "$names" ] || names=$(ls *.html | sed 's/\.html$//')
for n in $names; do
  "$CHROME" --headless=new --hide-scrollbars --force-device-scale-factor=1 --window-size=1340,1010 \
    --screenshot="$PWD/../$n.png" "file://$PWD/$n.html" 2>/dev/null && echo "$n.png"
done
