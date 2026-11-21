// The one place that reads the factory's status.json. factory-chrome's brand copy
// (always shown) runs the loader; every other mod renders from state().
import { readTextFile, setShared, shared, watchFolder, appHome, home, spaces, checking } from "herdr";
import { validateStatus } from "./status.js";
import SAMPLE from "./sample.js"; // written by scripts/sync.sh from fixtures/

const KEY = "factory.state";

// Where status.json may live, first match wins: an explicit override, the daemon's
// folder for this space (~/.factory/<space folder name>, as `factory` names it), then
// the sample data scripts/sync.sh installs.
function candidates() {
  const folder = spaces().find((s) => s.active)?.folder;
  const name = folder?.split("/").filter(Boolean).pop();
  return [shared("factory.root"), name && `${home()}/.factory/${name}`, `${appHome()}/factory-data/acme-api`].filter(Boolean);
}

// The folder the shown status came from; ticket folders and .factory/ sit beside it.
export const root = () => state().root ?? candidates().at(-1);

async function load() {
  let dir = null;
  let text = null;
  for (const d of candidates()) {
    text = await readTextFile(`${d}/status.json`);
    dir = d;
    if (text != null) break;
  }
  let status = null;
  let errors = [];
  if (text == null) errors = [`${dir}/status.json: not found`];
  else {
    try {
      status = JSON.parse(text);
      errors = validateStatus(status);
    } catch (e) {
      errors = [`status.json: ${e.message}`];
    }
  }
  // shared() is persisted: stamp it, and drop a bad status rather than show it.
  setShared(KEY, { at: Date.now(), root: dir, status: errors.length ? null : status, errors });
  return dir;
}

export function startLoader(cx) {
  cx.spawn(async (cx) => {
    let dir = await load();
    if (checking()) return;
    for (;;) {
      // Wake on a change in the folder, or every 5 s to notice a new space or a daemon starting.
      const watch = watchFolder(dir);
      await Promise.race([watch, new Promise((done) => cx.timer.after(5000, done))]);
      watch.cancel();
      dir = await load();
    }
  });
}

// `herdr-app check` renders before any load finishes and ignores shared.json, so it
// renders the bundled sample: the check then exercises every mod's data path.
export const state = () =>
  checking() ? { at: 0, status: SAMPLE, errors: [] } : shared(KEY) ?? { at: 0, status: null, errors: ["loading"] };
export const status = () => state().status;
