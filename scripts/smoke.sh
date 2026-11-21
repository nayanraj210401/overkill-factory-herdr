#!/usr/bin/env bash
# Opens the factory layout in a second, isolated Herdr window (its own app home,
# never yours), screenshots every page, switches to Herdr's main layout and back,
# and fails on any error the window reports. Usage: scripts/smoke.sh [out-dir]
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-smoke-out}"; mkdir -p "$out"
home=$(mktemp -d -t hf)   # short: the socket path must fit macOS's limit
export HERDR_APP_HOME="$home"
scripts/sync.sh "$home" >/dev/null
echo '{"layout":"factory","frame.welcomed":"finished"}' > "$home/shared.json"
herdr-app > "$home.log" 2>&1 &
app=$!
trap 'kill $app 2>/dev/null; rm -rf "$home" "$home.log"' EXIT
for _ in $(seq 1 60); do [[ -S "$home/herdr-app.sock" ]] && break; sleep 0.5; done

errors() { herdr-app status | node -e 'const s=JSON.parse(require("fs").readFileSync(0));if(s.errors?.length){console.error(JSON.stringify(s.errors));process.exit(1)}'; }
pages=$(node -e 'import("./lib/pages.js").then(m=>console.log(m.PAGES.map(p=>p.id).join(" ")))')
sleep 2
for p in $pages; do
  herdr-app do layout.select "{\"stack\":\"pages\",\"child\":\"$p\"}" >/dev/null
  sleep 0.7
  herdr-app shot "$out/$p.png" >/dev/null
  errors
done
# The dialog every ticket action opens: plain (no props), then with b's text box,
# shown through a one-block layout since only a layout can hand a mod props.
herdr-app do mod.open '{"name":"factory-ask"}' >/dev/null; sleep 0.7
herdr-app shot "$out/ask.png" >/dev/null
errors
herdr-app do overlay.close '{}' >/dev/null; sleep 0.3
node -e 'import("./lib/actions.js").then(({ budgetAsk }) => {
  const props = budgetAsk({ id: 412, title: "Rate-limit login", state: "running", tokens: { input: 1.2e6, output: 64e3 }, budget: { input: 3e6, output: 2e5 } });
  console.log(JSON.stringify({ id: "root", type: "row", children: [{ id: "ask", type: "block", content: { mod: "factory-ask", props } }] }));
})' > "$home/layouts/factory-ask-test.json"
herdr-app do layout.switch '{"name":"factory-ask-test"}' >/dev/null; sleep 1.3
herdr-app shot "$out/ask-input.png" >/dev/null
errors
# Metrics' other tabs, which check never reaches (it renders the first one).
for tab in Cost Quality; do
  echo "{\"id\":\"root\",\"type\":\"row\",\"children\":[{\"id\":\"m\",\"type\":\"block\",\"content\":{\"mod\":\"factory-metrics\",\"props\":{\"tab\":\"$tab\"}}}]}" > "$home/layouts/factory-metrics-test.json"
  herdr-app do layout.switch '{"name":"factory-metrics-test"}' >/dev/null; sleep 1.3
  herdr-app shot "$out/metrics-$tab.png" >/dev/null
  errors
  herdr-app do layout.switch '{"name":"factory"}' >/dev/null; sleep 0.5
done
herdr-app do layout.switch '{"name":"main"}' >/dev/null; sleep 0.7
[[ $(herdr-app status | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).layout)') == main ]]
herdr-app do layout.switch '{"name":"factory"}' >/dev/null; sleep 0.7
[[ $(herdr-app status | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).layout)') == factory ]]
errors
echo "smoke passed: $(ls "$out" | wc -l | tr -d ' ') screenshots in $out"
