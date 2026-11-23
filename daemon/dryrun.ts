// The blueprint dry run (plan: Changing the factory). A draft blueprint is replayed
// against the last few finished tickets: no agents run. Each ticket's recorded path (its
// stage rows, in order) is walked through the draft; the walk follows what the ticket did
// for as long as the draft allows it, and says where the draft would part ways.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateFile } from "./validate.ts";

export type Graph = { name: string; orchestrator?: string; start: string; stages: Record<string, { next?: string[]; on_fail?: string; max_retries?: number }> };
export type Choice = { at: string; to: string; by: string };
export type Recorded = { id: number; title: string; path: string[]; choices: Choice[] };
export type Ending = "ends" | "parks" | "diverges";
export type Replay = {
  ticket: number; title: string; recorded: string[]; visited: string[]; ending: Ending;
  notes: string[]; removed: string[]; added: string[];
};
export type DryRun = { blueprint: string; replayed: Replay[]; removed: string[]; added: string[]; skipped: string | null };

const DEFAULT_RETRIES = 3;
const nextOf = (g: Graph, at: string) => g.stages[at]?.next ?? [];

// What the draft's first nexts would do from here: the path with no surprises.
export function plan(g: Graph, from: string) {
  const out: string[] = [];
  for (let at = from; at && at !== "end" && g.stages[at] && !out.includes(at); at = nextOf(g, at)[0]) out.push(at);
  return out;
}

// Parse and check a draft with the schema check, which also names every stage it points at.
export function loadDraft(text: string, file = "blueprints/draft.yaml"): Graph {
  const errors = validateFile(file, text);
  if (errors.length) throw new Error(`the draft blueprint is invalid:\n${errors.map((e) => `  ${e}`).join("\n")}`);
  return Bun.YAML.parse(text) as Graph;
}

// One ticket through the draft. Pure.
export function replay(g: Graph, t: Recorded): Replay {
  const rec = t.path;
  const r: Replay = { ticket: t.id, title: t.title, recorded: rec, visited: [], ending: "ends", notes: [],
    removed: [...new Set(rec.filter((s) => !g.stages[s]))], added: [] };
  const choices = [...t.choices];
  const stop = (ending: Ending, note: string, from?: string) => {
    r.ending = ending;
    r.notes.push(note);
    const rest = from ? plan(g, from) : [];
    if (rest.length) r.notes.push(`from there the draft would run ${rest.join(" → ")} (planned, nothing recorded)`);
    r.added = r.visited.concat(rest).filter((s) => !rec.includes(s));
    return r;
  };
  if (!rec.length) return stop("ends", "no stages were recorded for this ticket");
  const ask = (at: string) => `would ask the ${g.orchestrator ?? "orchestrator"} agent: ${at} can go to ${nextOf(g, at).join(" or ")}`;
  if (rec[0] !== g.start) {
    return stop("diverges", `starts at ${g.start}; the old run started at ${rec[0]}`, g.start);
  }
  const fails: Record<string, number> = {};
  for (let i = 0; i < rec.length; i++) {
    const at = rec[i];
    r.visited.push(at);
    const to = rec[i + 1];
    const next = nextOf(g, at);
    if (to === undefined) {
      if (!next.length || next.includes("end")) { r.added = r.visited.filter((s) => !rec.includes(s)); return r; }
      return stop("diverges", `${at} was the last stage; the draft goes on to ${next.join(" or ")}`, next[0]);
    }
    if (next.includes(to)) {
      const ix = choices.findIndex((c) => c.at === at && c.to === to);
      if (ix >= 0 && next.length > 1) { choices.splice(ix, 1); r.notes.push(`${at} → ${to}: the old orchestrator choice still exists, reused`); }
      continue;
    }
    if (g.stages[at].on_fail === to) {
      fails[at] = (fails[at] ?? 0) + 1;
      const max = g.stages[at].max_retries ?? DEFAULT_RETRIES;
      if (fails[at] > max) return stop("parks", `${at} failed ${fails[at]} times, past max_retries ${max}: the ticket would park`);
      r.notes.push(`${at} fails back to ${to} (loop ${fails[at]})`);
      continue;
    }
    const why = !g.stages[to] ? `the draft has no ${to} stage` : `the draft doesn't allow ${at} → ${to}`;
    const lost = choices.some((c) => c.at === at && c.to === to);
    const options = next.length > 1 ? `; ${lost ? "the old orchestrator choice is gone: " : ""}${ask(at)}` : next.length ? `; it goes to ${next[0]}` : "; it ends there";
    return stop("diverges", `${at} → ${to} no longer holds: ${why}${options}`, next.length ? next[0] : undefined);
  }
  return r;
}

// The last N merged tickets on the blueprint: stage rows in order (grooming isn't part of
// the graph), and the orchestrator's logged choices.
export function recordedTickets(db: Database, blueprint: string, n: number): Recorded[] {
  const rows = db.query("SELECT id, title FROM tickets WHERE state = 'merged' AND blueprint = ? ORDER BY updated_at DESC, id DESC LIMIT ?").all(blueprint, n) as { id: number; title: string }[];
  return rows.map((t) => {
    const path: string[] = [];
    for (const s of db.query("SELECT name FROM stages WHERE ticket = ? ORDER BY id").all(t.id) as { name: string }[]) {
      const id = s.name.toLowerCase();
      if (id !== "groom" && path.at(-1) !== id) path.push(id);
    }
    const choices = (db.query("SELECT who, what FROM decisions WHERE ticket = ? AND what LIKE 'chose % after %' ORDER BY id").all(t.id) as { who: string; what: string }[])
      .filter((d) => d.who !== "daemon").flatMap((d) => { const m = d.what.match(/^chose (\S+) after (\S+)$/); return m ? [{ at: m[2], to: m[1], by: d.who }] : []; });
    return { ...t, path, choices };
  });
}

export function dryRun(db: Database, g: Graph, n = 5): DryRun {
  const replayed = recordedTickets(db, g.name, n).map((t) => replay(g, t));
  const all = (k: "removed" | "added") => [...new Set(replayed.flatMap((x) => x[k]))];
  return { blueprint: g.name, replayed, removed: all("removed"), added: all("added"),
    skipped: replayed.length ? null : `no finished ticket has run the ${g.name} blueprint yet, so there is nothing to replay` };
}

// A draft's source: a file path, or the name of a blueprint in the repo's .factory/.
export function draftSource(repo: string, arg: string) {
  const own = join(repo, ".factory", arg === "default" ? "blueprint.yaml" : `blueprints/${arg}.yaml`);
  const file = existsSync(arg) ? arg : existsSync(own) ? own : null;
  if (!file) throw new Error(`no blueprint file or name "${arg}" (looked for ${arg} and ${own})`);
  return readFileSync(file, "utf8");
}

export function dryRunMarkdown(d: DryRun) {
  const lines = [`## Dry run: the \`${d.blueprint}\` blueprint`, ""];
  if (d.skipped) return [...lines, d.skipped + ".", ""].join("\n");
  lines.push(`Replayed ${d.replayed.length} finished ticket${d.replayed.length === 1 ? "" : "s"} through the draft from their recorded stages; no agents ran.`, "");
  if (d.removed.length) lines.push(`- Stages the old runs had that the draft lacks: ${d.removed.map((s) => `\`${s}\``).join(", ")}`);
  if (d.added.length) lines.push(`- Stages the draft adds to those runs: ${d.added.map((s) => `\`${s}\``).join(", ")}`);
  if (d.removed.length || d.added.length) lines.push("");
  for (const t of d.replayed) {
    lines.push(`### #${t.ticket} ${t.title}`, `- Old path: ${t.recorded.join(" → ") || "none recorded"}`, `- Draft path: ${t.visited.join(" → ") || "none"} · ${{ ends: "ends", parks: "would park", diverges: "parts ways" }[t.ending]}`);
    for (const n of t.notes) lines.push(`- ${n}`);
    lines.push("");
  }
  return lines.join("\n");
}
