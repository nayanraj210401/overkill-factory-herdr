// The one place that reads the factory's status.json. factory-chrome's brand copy
// (always shown) runs the loader; every other mod renders from state().
import { readTextFile, setShared, shared, watchFolder, appHome, home, spaces, checking, run, notify, openOverlay, layout } from "herdr";
import { STACK, activePage } from "./pages.js";
import { validateStatus } from "./status.js";
import { factoryOf } from "./model.js";
import { factoryCounts, pickerRows, stepNeeding, switchTarget } from "./factories.js";
import { newAsk, pauseAsk, mergeAsk, budgetAsk, sendBackAsk, answerAsk, regroomAsk, cloudAsk, cloudAllAsk, localAsk, undoOverrideAsk } from "./actions.js";
import { parseReviews } from "./reviews.js";
import SAMPLE from "./sample.js"; // written by scripts/sync.sh from fixtures/
import SAMPLE_REVIEWS from "./sample-reviews.js"; // likewise

const KEY = "factory.state";

// Where status.json may live, first match wins: an explicit override, then the daemon's
// folder for this space's factory (~/.factory/<name>; see factoryOf and factories()). The sample data
// scripts/sync.sh installs comes last only once you ask for it (showSample): a repo with
// no factory gets the "start a factory here" screen, not someone else's tickets.
const SAMPLE_KEY = "factory.sample";
// Every factory on this machine with its repos' checkouts: agents-live.json's factories,
// which the daemon rewrites each tick. Shared, so every mod (the factory picker too) sees it.
const INDEX_KEY = "factory.index";
export const factories = () => shared(INDEX_KEY) ?? [];
let indexText = null;
async function loadIndex() {
  const text = await readTextFile(`${home()}/.factory/agents-live.json`);
  if (text === indexText) return;
  indexText = text;
  let list = [];
  let agents = [];
  try {
    const doc = JSON.parse(text ?? "null");
    list = (doc?.factories ?? []).filter((f) => f && typeof f.name === "string");
    agents = (doc?.agents ?? []).filter((a) => a && typeof a.status === "string");
  } catch { list = []; agents = []; }
  setShared(INDEX_KEY, list);
  setShared(LIVE_KEY, agents);
}
// The live roster's agents (agents-live.json's agents): the sidebar's global agents come from it.
// `herdr-app check` gets a maintainer at work and Overwatch asking, so it draws both kinds of row.
const LIVE_KEY = "factory.live";
const CHECK_LIVE = [
  { factory: null, agent: "maintainer", tier: "global", ticket: null, stage: null, status: "working", terminal: "t9", started_at: "2026-11-21T09:59:00Z" },
  { factory: null, agent: "overwatch", tier: "global", ticket: null, stage: null, status: "waiting", terminal: "t3", started_at: "2026-11-21T08:00:00Z" },
];
export const liveAgents = () => (checking() ? CHECK_LIVE : shared(LIVE_KEY) ?? []);
// Every factory's counts (factoryCounts of its own status.json), by name, for the picker and
// the brand's "another factory needs you" line. Read on each load, written only on a change.
const COUNTS_KEY = "factory.counts";
let countsText = null;
async function loadCounts() {
  const counts = {};
  for (const f of factories()) {
    if (typeof f.dir !== "string") continue;
    let s = null;
    try { s = JSON.parse((await readTextFile(`${f.dir}/status.json`)) ?? "null"); } catch { s = null; }
    counts[f.name] = factoryCounts(s);
  }
  const text = JSON.stringify(counts);
  if (text === countsText) return;
  countsText = text;
  setShared(COUNTS_KEY, counts);
}
// The picker's rows: every factory, its repos and counts, the shown one marked.
// `herdr-app check` has no index: it gets the sample factory and a second one that needs you.
export function factoryRows() {
  if (checking()) {
    const repos = (SAMPLE.factory.repos ?? [SAMPLE.factory.repo]).map((slug, i) => ({ slug, path: `/sample/${slug}`, lead: !i }));
    const list = [{ name: SAMPLE.factory.name, dir: "", repos }, { name: "shop", dir: "", repos: [{ slug: "acme/shop", path: "/sample/shop", lead: true }] }];
    return pickerRows(list, { [SAMPLE.factory.name]: factoryCounts(SAMPLE), shop: { running: 0, needs: 1, review: 0 } }, SAMPLE.factory.name);
  }
  return pickerRows(factories(), shared(COUNTS_KEY) ?? {}, space().name);
}

// Show a factory: focus a space in its lead repo, else make one there. The window follows the
// space, and the loader notices the new space at once (wake()).
export function switchFactory(name) {
  const f = factories().find((x) => x.name === name);
  const to = f && switchTarget(f, spaces(), home(), factories());
  if (!to) return notify({ title: `No checkout for ${name} on this machine`, level: "info", timeout: 2500 });
  if (f.name !== space().name) run(to.command, to.args);
}
// ] / [: the next or previous factory that needs you.
export function stepFactory(delta) {
  const r = stepNeeding(factoryRows(), space().name, delta);
  if (r) switchFactory(r.name);
  else notify({ title: "No other factory needs you", level: "info", timeout: 2000 });
}

function space() {
  const folder = spaces().find((s) => s.active)?.folder ?? null;
  return { folder, name: factoryOf(folder, home(), factories()) };
}
function candidates() {
  const { name } = space();
  return [shared("factory.root"), name && `${home()}/.factory/${name}`, shared(SAMPLE_KEY) && `${appHome()}/factory-data/acme-api`].filter(Boolean);
}
export const sampleOn = () => !!shared(SAMPLE_KEY);
export function showSample(on, cx) {
  setShared(SAMPLE_KEY, on || null);
  last = null; // reload now rather than at the next 5 s wake
  cx.spawn(async () => { await load(); });
}

// The folder the shown status came from; ticket folders and .factory/ sit beside it.
export const root = () => state().root ?? candidates().at(-1);

let last = null; // the root and text shown now: an unchanged reload redraws nothing

// Where you were, per factory: the ticket you picked and the page you had open, keyed by the
// factory's folder. One window shows one factory at a time, so a single "picked ticket" or "page"
// was overwritten by the other factory and lost on the way back.
const PICK_KEY = "factory.picked"; // { [root]: ticket id }
const PLACE_KEY = "factory.place"; // { [root]: page id }
export const pickedTicket = () => (shared(PICK_KEY) ?? {})[root()] ?? null;
export function pickTicket(id) {
  setShared(PICK_KEY, { ...(shared(PICK_KEY) ?? {}), [root()]: id });
}
// Switching factory: the page shown is the one you left; the new factory opens on the page
// you left it on (or stays put the first time).
let shownRoot = null;
function switched(to) {
  const from = shownRoot;
  shownRoot = to;
  if (!from || !to || from === to || checking()) return;
  let here = null;
  try { here = activePage(layout())?.id ?? null; } catch {}
  const place = { ...(shared(PLACE_KEY) ?? {}) };
  if (here) place[from] = here;
  setShared(PLACE_KEY, place);
  const back = place[to];
  if (back && back !== here) { try { run("layout.select", { stack: STACK, child: back }); } catch {} }
}

async function load() {
  await loadIndex();
  await loadCounts();
  shownFolder = space().folder;
  let dir = null;
  let text = null;
  for (const d of candidates()) {
    text = await readTextFile(`${d}/status.json`);
    dir = d;
    if (text != null) break;
  }
  // No factory for this space (no status.json in its folder), no override, sample off:
  // Home offers to start one here.
  if (text == null && !shared("factory.root")) {
    const { folder, name } = space();
    const key = `none\n${folder}`;
    if (key === last && shared(KEY)) return dir;
    last = key;
    setShared(KEY, { at: Date.now(), root: null, status: null, none: { folder, name }, errors: [name ? `no factory "${name}" yet` : "no space open"] });
    return dir; // watched: the folder appears when factory init writes status.json
  }
  const key = `${dir}\n${text}`;
  if (key === last && shared(KEY)) return dir;
  last = key;
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
  switched(dir);
  return dir;
}

// The brand copy calls wake() on every render (spaces changed, say): when the shown space's
// folder isn't the one last loaded, the loader reloads now rather than at its next 5 s wake.
let shownFolder = null;
let poke = null;
export function wake() {
  if (poke && space().folder !== shownFolder) { poke(); poke = null; }
}

export function startLoader(cx) {
  cx.spawn(async (cx) => {
    let dir = await load();
    if (checking()) return;
    for (;;) {
      // Wake on a change in the folder, or every 5 s to notice a new space or a daemon starting.
      // A folder that doesn't exist yet (no factory) can't be watched: the 5 s wake finds it.
      const never = new Promise(() => {});
      const watch = dir ? watchFolder(dir) : null;
      const poked = new Promise((done) => { poke = done; });
      await Promise.race([(watch ?? never).catch(() => never), poked, new Promise((done) => cx.timer.after(5000, done))]);
      watch?.cancel();
      dir = await load();
    }
  });
}

// `herdr-app check` renders before any load finishes and ignores shared.json, so it
// renders the bundled sample: the check then exercises every mod's data path.
export const state = () =>
  checking() ? { at: 0, status: SAMPLE, errors: [] } : shared(KEY) ?? { at: 0, status: null, errors: ["loading"] };
export const status = () => state().status;

// reviews.json beside status.json, as parseReviews reads it. `herdr-app check` gets the
// bundled sample so the Reviews page and the sidebar render real rows there.
export async function readReviews() {
  if (checking()) return { doc: SAMPLE_REVIEWS, error: null, missing: false };
  return parseReviews(await readTextFile(`${root()}/reviews.json`));
}

// An action key on a ticket (keyAction's result), the same on every page.
export function act(a, ticket) {
  if (a.kind === "terminal") return peekAgent(ticket);
  if (a.kind === "soon") return notify({ title: `${a.label}: coming in ${a.milestone}`, level: "info", timeout: 2500 });
  if (a.kind === "new") return ask(newAsk());
  if (a.kind === "diff") return showDiff(ticket);
  if (a.kind === "pause") return ask(pauseAsk(ticket));
  if (a.kind === "regroom") return ask(regroomAsk(ticket));
  if (a.kind === "merge") return ask(mergeAsk(ticket));
  if (a.kind === "budget") return ask(budgetAsk(ticket));
  if (a.kind === "send-back") return ask(sendBackAsk(ticket));
  if (a.kind === "answer") { const r = answerAsk(ticket); return r.terminal ? peekAgent(ticket) : ask(r); }
  if (a.kind === "cloud") return ask(cloudAsk(ticket));
  if (a.kind === "local") return ask(localAsk(ticket));
  if (a.kind === "cloud-all") return ask(cloudAllAsk(status()?.tickets ?? []));
  if (a.kind === "undo-override") return ask(undoOverrideAsk(ticket)); // Config passes an override, not a ticket
}

function showDiff(ticket) {
  if (!ticket) return notify({ title: "No ticket selected", level: "info", timeout: 2500 });
  if (["grooming", "queued"].includes(ticket.state)) return notify({ title: `#${ticket.id} hasn't started; no diff yet`, level: "info", timeout: 2500 });
  if (status()?.source !== "daemon") return notify({ title: "This is sample data", body: "Start a factory (factory init) to see a ticket's diff.", level: "info", timeout: 3500 });
  openOverlay({ mod: "factory-diff", kind: "window", key: "factory-diff", width: 0.8, height: 0.85, props: { id: ticket.id, title: ticket.title, root: root() } });
}

// Changes go through the factory-ask dialog, which runs the CLI on the shown folder.
export function ask(a) {
  if (a.error) return notify({ title: a.error, level: "info", timeout: 2500 });
  if (status()?.source !== "daemon") return notify({ title: "This is sample data", body: "Start a factory (factory init) to act on tickets.", level: "info", timeout: 3500 });
  openOverlay({ mod: "factory-ask", kind: "dialog", width: 460, height: a.input ? 280 : 200, props: { ...a, root: root() } });
}

// `e`: the ticket's live agent terminal, over the page (keep turns it into a tab).
export function peekAgent(ticket) {
  if (ticket?.terminal) run("terminal.peek", { terminal: ticket.terminal });
  else notify({ title: ticket ? `#${ticket.id} has no agent running` : "No ticket selected", level: "info", timeout: 2500 });
}
