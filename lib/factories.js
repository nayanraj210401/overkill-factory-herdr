// Every factory on this machine, for the factory picker and the brand row: each one's live
// counts, which one needs you, and the Herdr space to show when you pick one. Pure: the
// store reads the files, the mods draw. No Herdr imports.
import { factoryOf, needsYou, overwatchNotes } from "./model.js";

// One factory's numbers from its status.json: running tickets, what Home's "Needs you" lists
// (questions, parked, ready to merge, an agent waiting in its terminal, notes from Overwatch),
// and teammates' PRs to review. null when there's no status to count.
export function factoryCounts(s) {
  if (!s || !Array.isArray(s.tickets)) return null;
  return {
    running: s.tickets.filter((t) => t.state === "running").length,
    needs: needsYou(s.tickets).length + overwatchNotes(s.asks).length,
    review: Number.isInteger(s.to_review) ? s.to_review : 0,
  };
}

// A factory's repos, lead first (agents-live.json lists them as the daemon has them).
export const leadFirst = (repos = []) => [...repos].sort((a, b) => Number(!!b.lead) - Number(!!a.lead));
export const leadRepo = (f) => leadFirst(f?.repos)[0] ?? null;

// Herdr's agent-status dot for a factory: blocked when it needs you, working while a ticket
// runs, idle otherwise, unknown when its status.json couldn't be read.
export const factoryDot = (c) => (!c ? "unknown" : c.needs ? "blocked" : c.running ? "working" : "idle");

// The picker's rows, in factories() order. `counts` maps a factory's name to factoryCounts().
export function pickerRows(factories, counts = {}, current = null) {
  return factories.map((f) => {
    const c = counts[f.name] ?? null;
    return {
      name: f.name, dir: f.dir, lead: leadRepo(f),
      repos: leadFirst(f.repos).map((r) => r.slug),
      counts: c, dot: factoryDot(c), current: f.name === current,
    };
  });
}

// The picker's second line: "3 running · 1 needs you · 2 to review", or why there are no numbers.
export function countsText(c) {
  if (!c) return "no status yet";
  const parts = [c.running && `${c.running} running`, c.needs && `${c.needs} needs you`, c.review && `${c.review} to review`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "nothing waiting";
}

// The other factories that need you, most waiting first, then in factories() order.
export function othersNeeding(rows, current) {
  return rows.map((r, i) => ({ r, i })).filter(({ r }) => r.name !== current && r.counts?.needs)
    .sort((a, b) => b.r.counts.needs - a.r.counts.needs || a.i - b.i).map(({ r }) => r);
}

// The brand's warning line: "⚠ shop: 1 needs you", "+N" for the rest. null when none.
export function needsLine(rows, current) {
  const others = othersNeeding(rows, current);
  if (!others.length) return null;
  const [top] = others;
  return { name: top.name, text: `⚠ ${top.name}: ${top.counts.needs} needs you${others.length > 1 ? ` +${others.length - 1}` : ""}` };
}

// ] / [: the next or previous factory, after the current one in factories() order and
// wrapping, that needs you. null when no other factory does.
export function stepNeeding(rows, current, delta) {
  const n = rows.length;
  const at = rows.findIndex((r) => r.name === current);
  for (let k = 1; k <= n; k++) {
    const r = rows[(((at < 0 ? (delta > 0 ? -1 : 0) : at) + delta * k) % n + n) % n];
    if (r.name !== current && r.counts?.needs) return r;
  }
  return null;
}

// Where picking a factory goes: a space on this machine inside its lead repo, else one
// showing that factory anyhow (another of its repos, a ticket's folder), else a new space at
// the lead repo. Spaces on other machines don't count: the factory's checkouts are here.
export function switchTarget(factory, spaces, home, factories) {
  const lead = (leadRepo(factory)?.path ?? "").replace(/\/+$/, "");
  const local = spaces.filter((s) => !s.machine && s.folder);
  const inLead = (s) => lead && (s.folder === lead || s.folder.startsWith(`${lead}/`));
  const space = local.find((s) => inLead(s) && factoryOf(s.folder, home, factories) === factory.name)
    ?? local.find((s) => factoryOf(s.folder, home, factories) === factory.name);
  if (space) return { command: "space.select", args: { id: space.id } };
  if (lead) return { command: "space.new", args: { folder: lead, machine: "" } };
  return null;
}

// The brand row: "<factory>" over "<lead repo> · <branch> · N repos".
export function brandSub(s, branch) {
  const repos = s?.factory?.repos ?? (s?.factory?.repo ? [s.factory.repo] : []);
  return [s?.factory?.repo, branch, repos.length > 1 && `${repos.length} repos`].filter(Boolean).join(" · ");
}
