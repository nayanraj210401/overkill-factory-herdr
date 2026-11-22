// flow-stack's feature map, used as it is by the verify stage (plan: What comes from
// flow-stack v1). factory.yaml's `verify: { features: <dir> }` names a folder of feature
// files, `<id>.md` each, whose front matter is one `key: value` line per key:
//
//   id: auth.login
//   owns: src/auth/** src/routes/login.ts      space-separated globs; ** crosses directories
//   scenario: bash .claude/skills/verify-acme/scripts/login.sh   the verify driver's command
//
// The tests check runs the scenario of every feature whose `owns` matches a file the
// ticket changed, in the ticket's worktree, and records it as `feat:<id>`. A feature with
// no scenario yet isn't run (flow-stack calls it unverified).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Feature = { id: string; title: string; owns: string[]; scenario: string; file: string };

// The front matter by line, not as YAML: `owns: **/*.ts` would be a YAML alias.
export function parseFeature(text: string, file: string): Feature | null {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const kv: Record<string, string> = {};
  for (const l of m[1].split("\n")) {
    const x = l.match(/^(\w+):\s?(.*)$/);
    if (x) kv[x[1]] = x[2].replace(/\s+#\s.*$/, "").trim();
  }
  if (!kv.id) return null;
  return { id: kv.id, title: kv.title ?? kv.id, owns: (kv.owns ?? "").split(/\s+/).filter(Boolean), scenario: kv.scenario ?? "", file };
}

export const featureFiles = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md" && !f.startsWith(".")).sort() : [];

export function readFeatures(dir: string): Feature[] {
  return featureFiles(dir).flatMap((f) => parseFeature(readFileSync(join(dir, f), "utf8"), f) ?? []);
}

// Problems with one feature file, for `factory validate` (a copy under .factory/features/).
export function featureErrors(text: string, file: string): string[] {
  if (file === "README.md") return [];
  const f = parseFeature(text, file);
  if (!f) return ["feature: needs front matter between --- lines with an id: line"];
  return f.id === file.replace(/\.md$/, "") ? [] : [`id: "${f.id}" should match the file name`];
}

export const touched = (f: Feature, files: string[]) => f.owns.some((g) => { const glob = new Bun.Glob(g); return files.some((p) => glob.match(p)); });

// The paths a scenario's command names (the driver's scripts), for the migration's check
// that a worktree has them.
export const scenarioPaths = (scenario: string) => scenario.split(/\s+/).filter((w) => /\//.test(w) && !/^-/.test(w) && !/^https?:/.test(w));
