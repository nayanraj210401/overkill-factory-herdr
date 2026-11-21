// The one place that reads the factory's status.json. factory-chrome's brand copy
// (always shown) runs the loader; every other mod renders from state().
import { readTextFile, setShared, shared, watchFolder, appHome, checking } from "herdr";
import { validateStatus } from "./status.js";
import SAMPLE from "./sample.js"; // written by scripts/sync.sh from fixtures/

const KEY = "factory.state";

// M1 reads the fixture scripts/sync.sh installs; M2 points this at the daemon's folder.
export const root = () => shared("factory.root") ?? `${appHome()}/factory-data/acme-api`;

async function load(dir) {
  const text = await readTextFile(`${dir}/status.json`);
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
}

export function startLoader(cx) {
  cx.spawn(async () => {
    const dir = root();
    await load(dir);
    if (checking()) return;
    for (;;) {
      await watchFolder(dir);
      await load(dir);
    }
  });
}

// `herdr-app check` renders before any load finishes and ignores shared.json, so it
// renders the bundled sample: the check then exercises every mod's data path.
export const state = () =>
  checking() ? { at: 0, status: SAMPLE, errors: [] } : shared(KEY) ?? { at: 0, status: null, errors: ["loading"] };
export const status = () => state().status;
