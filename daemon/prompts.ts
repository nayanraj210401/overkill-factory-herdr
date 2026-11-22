// Prompt templates: the text around an agent's own prompt (what to read, which `factory`
// commands to run, where to write, the stage-done line). The built-in ones live in
// fixtures/acme-api/.factory/prompts/ (setup copies them into a factory); a file of the
// same name in the factory's .factory/prompts/ replaces the built-in one.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const BUILT_IN_PROMPTS = join(import.meta.dir, "../fixtures/acme-api/.factory/prompts");

const TICKET = ["ticket.id", "ticket.title"];
// What each template may name. Any other prompts/<name>.md (a stage's `prompt:`) is a stage template.
// Every template may name {{neighbours}}, the map of the factory's agents (agents.ts).
export const PLACEHOLDERS: Record<string, string[]> = {
  groom: [...TICKET, "neighbours", "repo", "slug", "folder", "blueprints", "agent.prompt", "repos", "issue"],
  stage: [...TICKET, "neighbours", "stage", "folder", "agent.prompt", "repos", "repo_count", "verdict", "profile", "lessons", "fix_brief", "slice", "shared", "publish"],
  handoff: [...TICKET, "neighbours", "stage", "folder", "session", "stage_brief", "previous", "rerun", "handoff", "slice", "acceptance", "acceptance_missing", "diff", "last_check", "snapshot", "publish_handoff"],
  overwatch: ["neighbours", "agent.prompt", "home", "factories"],
};
export const placeholdersFor = (name: string) => PLACEHOLDERS[name] ?? PLACEHOLDERS.stage;

const TAG = /\{\{\s*([\w.]+)\s*\}\}/g;

// Problems in a template's text: names it isn't given, and a `{{` that isn't a placeholder.
export function templateErrors(name: string, text: string): string[] {
  const allowed = placeholdersFor(name);
  const errors: string[] = [];
  for (const m of new Set([...text.matchAll(TAG)].map((x) => x[1])))
    if (!allowed.includes(m)) errors.push(`{{${m}}}: unknown placeholder (allowed: ${allowed.map((a) => `{{${a}}}`).join(", ")})`);
  if (text.replace(TAG, "").includes("{{")) errors.push("a {{ that isn't a placeholder like {{ticket.id}}");
  return errors;
}

// Paragraphs (split on blank lines) are the unit: one with an empty placeholder is dropped, and a
// heading left with nothing under it goes too. Values are inserted as they are, never re-expanded.
export function render(template: string, vars: Record<string, string | null | undefined>) {
  const parts = template.trim().split(/\n[ \t]*\n/).map((para) => {
    let empty = false;
    const text = para.replace(TAG, (_, k: string) => {
      const v = vars[k]?.trim() ?? "";
      if (!v) empty = true;
      return v;
    });
    return { text, empty, heading: /^#{1,6}[ \t][^\n]*$/.test(para.trim()) };
  });
  for (let i = parts.length - 2; i >= 0; i--) if (parts[i].heading && parts[i + 1].empty) parts[i].empty = true;
  return parts.filter((p) => !p.empty && p.text.trim()).map((p) => p.text).join("\n\n");
}

// The factory's own prompts/<name>.md, else the built-in. A file with a bad placeholder or a
// name with neither file is an error, so a typo fails loudly instead of sending a broken brief.
// A template that doesn't place {{neighbours}} gets it first: every brief carries the map.
export function loadPrompt(repo: string | null | undefined, name: string) {
  const withMap = (text: string) => (/\{\{\s*neighbours\s*\}\}/.test(text) ? text : `{{neighbours}}\n\n${text}`);
  const own = repo ? join(repo, ".factory", "prompts", `${name}.md`) : null;
  if (own && existsSync(own)) {
    const text = readFileSync(own, "utf8");
    const errors = templateErrors(name, text);
    if (errors.length) throw new Error(`.factory/prompts/${name}.md: ${errors[0]}`);
    return withMap(text);
  }
  const built = join(BUILT_IN_PROMPTS, `${name}.md`);
  if (existsSync(built)) return withMap(readFileSync(built, "utf8"));
  throw new Error(`no prompt template "${name}": there is no .factory/prompts/${name}.md`);
}
