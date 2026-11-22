// The orchestrator choosing among `next` (plan: blueprint.yaml). When a stage that passed
// offers more than one next stage, the blueprint's orchestrator agent picks one, so a
// small feature can skip plan. It is one short, tool-free call: the agent's prompt, the
// ticket's INTENT.md and latest checks, and the options; it answers NEXT and WHY. Any
// failure (no orchestrator, a non-Claude harness, a failed call, an answer that names no
// option) takes the first `next`, as the blueprint orders them. Every choice is logged.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODEL, pinModel } from "./models.ts";
import { agentSettings, type Run } from "./runner.ts";
import { agentRepos, loadAgent } from "./agents.ts";

type Stage = { agent?: string; check?: string; output?: string; gate?: string };
type Blueprint = { name: string; orchestrator?: string; stages: Record<string, Stage> };

const describe = (id: string, s: Stage | undefined) =>
  id === "end" ? "end: the ticket is done" : `${id}: ${s?.agent ? `the ${s.agent} agent` : s?.check ? `the ${s.check} check` : s?.gate ? `a ${s.gate} gate` : "a step"}${s?.output ? `, writes ${s.output}` : ""}`;

export function orchestratorPrompt(o: { title: string; id: number; at: string; options: string[]; b: Blueprint; prompt: string | null; intent: string; checks: string[] }) {
  return [
    `Ticket #${o.id}: ${o.title}. Its ${o.at} stage just finished. Pick the stage that runs next.`,
    o.prompt ?? "",
    `The options, in the blueprint's order (the first is the default):`,
    ...o.options.map((n) => `- ${describe(n, o.b.stages[n])}`),
    o.intent ? `\nINTENT.md:\n${o.intent.slice(0, 4000)}` : "",
    o.checks.length ? `\nLatest checks:\n${o.checks.join("\n")}` : "",
    `\nAnswer with exactly these two lines and nothing else:`,
    `NEXT: <one of ${o.options.join(", ")}>`,
    `WHY: one short sentence`,
  ].filter(Boolean).join("\n");
}

// The first NEXT line that names exactly one option; null otherwise.
export function parseChoice(out: string, options: string[]) {
  const lines = out.split("\n").map((l) => l.trim().replace(/^[-*>\s`]+/, "").replace(/\*\*/g, ""));
  const next = lines.find((l) => /^next\s*:/i.test(l));
  const named = [...new Set((next?.replace(/^next\s*:\s*/i, "").toLowerCase().match(/[a-z0-9_-]+/g) ?? []).filter((w) => options.includes(w)))];
  if (named.length !== 1) return null;
  const why = lines.find((l) => /^why\s*:/i.test(l))?.replace(/^why\s*:\s*/i, "").slice(0, 200) ?? "";
  return { to: named[0], why };
}

export function chooseNext(db: Database, o: { dir: string; repo: string; id: number; b: Blueprint; at: string; options: string[]; run: Run; now: string }) {
  const first = o.options[0];
  const log = (who: string, to: string, why: string) => {
    db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, ?, ?, ?, ?)").run(o.id, who, `chose ${to} after ${o.at}`, `${why} (of ${o.options.join(", ")})`, o.now);
    return to;
  };
  const name = o.b.orchestrator;
  if (!name) return log("daemon", first, "the blueprint names no orchestrator; the first next");
  const agent = loadAgent(agentRepos(db, o.id, o.repo), name);
  const t = db.query("SELECT id, title, settings FROM tickets WHERE id = ?").get(o.id) as { id: number; title: string; settings: string | null };
  const use = agentSettings(t, name, agent, { harness: "claude", model: DEFAULT_MODEL });
  if (use.harness !== "claude") return log(name, first, `${use.harness} can't be asked in one call; the first next`);
  const folder = join(o.dir, "tickets", String(o.id));
  const intent = existsSync(join(folder, "INTENT.md")) ? readFileSync(join(folder, "INTENT.md"), "utf8") : "";
  const checks = (db.query(`SELECT check_name, result, detail FROM evidence e WHERE ticket = ? AND id = (SELECT MAX(id) FROM evidence WHERE ticket = e.ticket AND check_name = e.check_name) ORDER BY id DESC LIMIT 6`)
    .all(o.id) as { check_name: string; result: string; detail: string | null }[]).map((c) => `- ${c.check_name}: ${c.result}${c.detail ? ` (${c.detail})` : ""}`);
  const text = orchestratorPrompt({ title: t.title, id: o.id, at: o.at, options: o.options, b: o.b, prompt: agent?.prompt ?? null, intent, checks });
  let r: { code: number; out: string };
  try { r = o.run(["claude", "-p", "--model", pinModel(use.model ?? DEFAULT_MODEL)!, text]); } catch (e) { r = { code: 1, out: (e as Error).message }; }
  const choice = r.code === 0 ? parseChoice(r.out, o.options) : null;
  if (!choice) return log(name, first, r.code === 0 ? `its answer named no option; the first next` : `the call failed (${r.out.slice(0, 80)}); the first next`);
  return log(name, choice.to, choice.why || "no reason given");
}
