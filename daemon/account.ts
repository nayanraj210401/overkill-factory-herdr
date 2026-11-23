// The account-wide layer: <FACTORY_HOME>/config.yaml (~/.factory/config.yaml). It holds what
// belongs to you rather than to one repo, and every factory under that home reads it:
//
//   plan:    { limits: { five_hour: 20M, week: 400M }, pause_at: 85% }
//   budget:  { per_day: { input: 40M, output: 2M } }      # across every factory, today
//   away:    { blueprints: [chore], budget: 1M/100k, review_rounds: 2, never: ["src/auth/**"] }
//   cloud:   { on_sleep: move | off }                     # move running tickets to the cloud at sleep, back at wake
//   artifacts: { as: artifact | doc | off, publish: [INTENT.md, SLICES.md] }  # share plans on claude.ai (artifacts.ts)
//   profile: { taste: ["…"], rules: ["…"] }                # in every agent's brief
//
// A repo's factory.yaml wins key by key where it sets the same thing (plan.pause_at, away.*);
// budget.per_day is checked at both levels, the factory's own and the account's total.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateAccount } from "./validate.ts";

export type Account = {
  plan?: { limits?: { five_hour?: string | number; week?: string | number }; pause_at?: string | number };
  budget?: { per_day?: { input?: string | number; output?: string | number } };
  away?: Record<string, unknown>;
  cloud?: { on_sleep?: "move" | "off" };
  artifacts?: { as?: "artifact" | "doc" | "off"; publish?: string[] };
  profile?: { taste?: string[]; rules?: string[] };
  claude?: { path?: string };
};

export const accountFile = (home = process.env.FACTORY_HOME ?? join(homedir(), ".factory")) => join(home, "config.yaml");

// The file, checked; none is {}. A bad file is an error, so a typo never silently does nothing.
export function readAccount(file = accountFile()): Account {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  const errors = validateAccount(text);
  if (errors.length) throw new Error(`${file}: ${errors[0]}`);
  return (Bun.YAML.parse(text) as Account) ?? {};
}

// Your rules and taste, as the brief's paragraph; "" with none, so the paragraph drops.
export function profileText(a = readAccount()) {
  const lines = [...(a.profile?.rules ?? []), ...(a.profile?.taste ?? [])];
  return lines.map((l) => `- ${l}`).join("\n");
}
