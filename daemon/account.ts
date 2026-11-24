// The account-wide layer: <FACTORY_HOME>/config.yaml (~/.factory/config.yaml). It holds what
// belongs to you rather than to one repo, and every factory under that home reads it:
//
//   plan:    { limits: { five_hour: 20M, week: 400M }, pause_at: 85% }
//   budget:  { per_day: { input: 40M, output: 2M } }      # across every factory, today
//   away:    { blueprints: [chore], budget: 1M/100k, review_rounds: 2, never: ["src/auth/**"] }
//   cloud:   { on_sleep: move | off }                     # move running tickets to the cloud at sleep, back at wake
//   artifacts: { as: artifact | doc | off, publish: [INTENT.md, SLICES.md] }  # share plans on claude.ai (artifacts.ts)
//   profile: { taste: ["…"], rules: ["…"] }                # in every agent's brief
//   V2_UI:   true | false                                 # the new Ticket and Blueprint pages; false by default
//
// A repo's factory.yaml wins key by key where it sets the same thing (plan.pause_at, away.*);
// budget.per_day is checked at both levels, the factory's own and the account's total.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { validateAccount } from "./validate.ts";

export type Account = {
  plan?: { limits?: { five_hour?: string | number; week?: string | number }; pause_at?: string | number };
  budget?: { per_day?: { input?: string | number; output?: string | number } };
  away?: Record<string, unknown>;
  cloud?: { on_sleep?: "move" | "off" };
  artifacts?: { as?: "artifact" | "doc" | "off"; publish?: string[] };
  profile?: { taste?: string[]; rules?: string[] };
  claude?: { path?: string };
  V2_UI?: boolean;
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

// The V2 UI gate: factory.yaml's V2_UI over the account's; off unless one says true.
export const v2UI = (factory: { V2_UI?: boolean }, account: Account = readAccount()) => (factory.V2_UI ?? account.V2_UI) === true;

// The account switches `factory config set` writes: on/off keys at the top level of config.yaml.
export const SWITCHES = ["V2_UI"] as const;
export type Switch = (typeof SWITCHES)[number];

// config.yaml's text with one top-level key set to a boolean, edited in place: its other lines,
// and the comment after that key, stay as they were. A key that isn't there goes at the end.
export function withSwitch(yaml: string, key: Switch, value: boolean) {
  const line = new RegExp(`^${key}:[^\\S\\n]*[^#\\n]*?([^\\S\\n]*#.*)?$`, "m");
  if (line.test(yaml)) return yaml.replace(line, (_m, note = "") => `${key}: ${value}${note}`);
  return `${yaml}${yaml && !yaml.endsWith("\n") ? "\n" : ""}${key}: ${value}\n`;
}

// `factory config set <key> true|false`: checks the key and value, then writes the account file.
// A file the change would leave invalid is refused and left alone.
export function setSwitch(key: string, raw: string, file = accountFile()) {
  if (!(SWITCHES as readonly string[]).includes(key)) throw new Error(`factory config set: ${key} isn't a switch (one of: ${SWITCHES.join(", ")})`);
  if (raw !== "true" && raw !== "false") throw new Error(`factory config set ${key}: expected true or false, got ${JSON.stringify(raw ?? "")}`);
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const after = withSwitch(before, key as Switch, raw === "true");
  const errors = validateAccount(after);
  if (errors.length) throw new Error(`${file}: ${errors[0]}; fix it first (factory validate ${file})`);
  if (after !== before) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, after);
  }
  return { file, value: raw === "true", changed: after !== before };
}

// Your rules and taste, as the brief's paragraph; "" with none, so the paragraph drops.
export function profileText(a = readAccount()) {
  const lines = [...(a.profile?.rules ?? []), ...(a.profile?.taste ?? [])];
  return lines.map((l) => `- ${l}`).join("\n");
}
