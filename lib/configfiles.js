// Which config file the daemon reads, for the Config and Repo config pages. Pure: the mods
// read the files, this says where each one stands. It mirrors the daemon's own lookups:
//   agents.ts agentFile: a factory agent (overwatch, babysitter, maintainer, learner) loads from
//     ~/.factory/agents/<x>.md, else the shipped agents/<x>.md; a repo's copy is never read. Any
//     other agent loads from the ticket's repo's .factory/agents/, then the lead repo's, and
//     nowhere else (the example library is only what setup copies in).
//   skills.ts skillDir: the ticket's repo's .factory/skills/<x>/, the lead repo's, then ~/.factory/skills/<x>/.
//   prompts.ts loadPrompt: the lead repo's .factory/prompts/<x>.md, else the built-in one.
//   steps.ts stepFile: the lead repo's .factory/steps/<x>.yaml, else ~/.factory/steps/<x>.yaml.
//   Blueprints, factory.yaml, prompts and steps load from the lead repo only (runner.ts passes
//   the lead's path), so another repo's copies of them do nothing.

export const FACTORY_AGENTS = ["overwatch", "babysitter", "maintainer", "learner"];

const parts = (path) => path.split("/");

// What the daemon reads instead of, or after, the repo file `path` (relative to its .factory/).
// o: { home: ~/.factory, checkout: this repo's checkout (shipped files), lead: the lead repo's
// path, or null when `path` is in the lead repo }.
// Returns { ignored: why the daemon never reads it, or null; others: [{ rel, tier, file }] }, in
// the order the daemon looks. rel: "over" (this file wins over it), "instead" (that one is read,
// not this), "copy" (an example it was copied from, never run). The first that exists decides.
export function repoPrecedence(path, o) {
  const [kind, name, ...rest] = parts(path);
  const lead = o.lead ? `${o.lead}/.factory/${path}` : null;
  const shipped = (p) => (o.checkout ? `${o.checkout}/${p}` : null);
  const list = (xs) => xs.filter((x) => x.file);
  const leadOnly = (what, others = []) => (o.lead
    ? { ignored: `${what} load from the lead repo`, others: list([{ rel: "instead", tier: "lead repo", file: lead }, ...others.map((x) => ({ ...x, rel: "instead" }))]) }
    : null);

  if (kind === "agents" && rest.length === 0 && name?.endsWith(".md")) {
    const x = name.slice(0, -3);
    if (FACTORY_AGENTS.includes(x)) {
      return { ignored: "factory agents load from ~/.factory/agents", others: list([
        { rel: "instead", tier: "global", file: `${o.home}/agents/${name}` },
        { rel: "instead", tier: "built-in", file: shipped(`agents/${name}`) },
      ]) };
    }
    return { ignored: null, others: list([
      { rel: "over", tier: "lead repo", file: lead },
      { rel: "copy", tier: "global example", file: `${o.home}/examples/agents/${name}` },
      { rel: "copy", tier: "built-in example", file: shipped(`examples/agents/${name}`) },
    ]) };
  }
  if (kind === "skills" && name && rest.length) {
    const inside = [name, ...rest].join("/");
    return { ignored: null, others: list([
      { rel: "over", tier: "lead repo", file: lead },
      { rel: "over", tier: "global", file: `${o.home}/skills/${inside}` },
      { rel: "copy", tier: "built-in example", file: shipped(`examples/skills/${inside}`) },
    ]) };
  }
  if (kind === "prompts" && rest.length === 0 && name) {
    const builtIn = { tier: "built-in", file: shipped(`fixtures/acme-api/.factory/prompts/${name}`) };
    return leadOnly("prompts", [builtIn]) ?? { ignored: null, others: list([{ rel: "over", ...builtIn }]) };
  }
  if (kind === "steps" && rest.length === 0 && name) {
    const global = { tier: "global", file: `${o.home}/steps/${name}` };
    return leadOnly("steps", [global]) ?? { ignored: null, others: list([
      { rel: "over", ...global },
      { rel: "copy", tier: "global example", file: `${o.home}/examples/steps/${name}` },
      { rel: "copy", tier: "built-in example", file: shipped(`examples/steps/${name}`) },
    ]) };
  }
  if (kind === "blueprints" || path === "factory.yaml") return leadOnly(kind === "blueprints" ? "blueprints" : "factory.yaml settings") ?? { ignored: null, others: [] };
  return { ignored: null, others: [] };
}

// The same for a file in ~/.factory (`path` relative to it): a factory agent there wins over the
// shipped one; a skill or step there may be a copy of a shipped example.
export function globalPrecedence(path, o) {
  const [kind, name, ...rest] = parts(path);
  const shipped = (p) => (o.checkout ? `${o.checkout}/${p}` : null);
  const one = (x) => ({ ignored: null, others: x.file ? [x] : [] });
  if (kind === "agents" && rest.length === 0 && FACTORY_AGENTS.includes(name?.replace(/\.md$/, ""))) return one({ rel: "over", tier: "built-in", file: shipped(`agents/${name}`) });
  if (kind === "skills" && name && rest.length) return one({ rel: "copy", tier: "built-in example", file: shipped(`examples/skills/${[name, ...rest].join("/")}`) });
  if (kind === "steps" && rest.length === 0 && name) return one({ rel: "copy", tier: "built-in example", file: shipped(`examples/steps/${name}`) });
  return { ignored: null, others: [] };
}

// The row's badge and the dim note under the file's name. `found` is the first of `others` that
// exists ({ ...other, text }), or null; `text` is this file's own text.
// tone: "accent" overrides, "blocked" never read, "dim" a copy of an example.
export function fileBadge(p, found, text) {
  const differs = found && found.text != null && text != null && found.text.trim() !== text.trim();
  const note = differs ? `differs from ${found.tier}` : null;
  if (p.ignored) return { badge: "not used", tone: "blocked", why: `Not used: ${p.ignored}${found ? ` (${found.tier}'s copy is)` : ""}`, note };
  if (!found) return { badge: null, tone: null, why: null, note: null };
  if (found.rel === "over") return { badge: `overrides ${found.tier}`, tone: "accent", why: `Used instead of the ${found.tier} copy`, note };
  return { badge: `from ${found.tier}`, tone: "dim", why: `A copy of the ${found.tier}; only this repo's copy runs`, note };
}

export const languageOf = (path) => (path.endsWith(".md") ? "markdown" : path.endsWith(".json") ? "json" : "yaml");

// The Config page's ~/.factory files: the factory agents, skills, shared steps, then the account's
// own files. Logs, backups, examples and each factory's folder aren't config and aren't listed.
export const GLOBAL_TOP = ["config.yaml", "maintainer.json", "overwatch.json", "plan.json"];
const GLOBAL_KINDS = ["agents/", "skills/", "steps/", ...GLOBAL_TOP];
const globalRank = (p) => GLOBAL_KINDS.findIndex((k) => (k.endsWith("/") ? p.startsWith(k) : p === k));
export function globalFiles(paths) {
  return paths
    .filter((p) => {
      const r = globalRank(p);
      if (r < 0 || parts(p).some((x) => x.startsWith("."))) return false;
      if (p.startsWith("agents/")) return /^agents\/[^/]+\.md$/.test(p);
      if (p.startsWith("steps/")) return /^steps\/[^/]+\.ya?ml$/.test(p);
      if (p.startsWith("skills/")) return /\.(md|ya?ml|json|txt)$/.test(p);
      return true;
    })
    .sort((a, b) => globalRank(a) - globalRank(b) || a.localeCompare(b))
    .map((path) => ({ path, language: languageOf(path) }));
}

// The repos the switcher lists: the shown factory's, from agents-live.json (factories()), lead
// first. A factory the roster doesn't list yet (or the sample) gets its lead from status.json.
export function repoChoices(factories, status, root) {
  const f = (factories ?? []).find((x) => x.name === status?.factory?.name);
  const repos = (f?.repos ?? []).filter((r) => r && typeof r.path === "string");
  if (repos.length) return [...repos].sort((a, b) => Number(!!b.lead) - Number(!!a.lead)).map((r) => ({ slug: r.slug ?? r.path, path: r.path, lead: !!r.lead }));
  const path = status?.factory?.path ?? root;
  return path ? [{ slug: status?.factory?.repo ?? path, path, lead: true }] : [];
}

// The lead repo's path among the choices (the first, after repoChoices), or null.
export const leadOf = (choices) => choices.find((r) => r.lead)?.path ?? null;

// The Ask maintainer dialog's props (lib/actions.js shape): `factory request [--repo slug] <text>`,
// the maintainer's existing request flow; it types the request into its live session.
export function maintainerAsk(repo = null) {
  return {
    title: "Ask the maintainer",
    detail: `The maintainer makes every change to the factory${repo ? `, here in ${repo}'s .factory/` : ""}. Say what to change; it edits in place, with a backup, and validates.`,
    input: { label: "The change", value: "", hint: "Sent with factory request; it opens in the maintainer's terminal." },
    confirm: "Send",
    args: repo ? ["request", "--repo", repo] : ["request"],
    done: "Sent to the maintainer",
  };
}

// The checkout the window runs the CLI from (lib/cli.js: [bun, <checkout>/daemon/cli.ts]): the
// shipped agents, examples and built-in prompts the pages compare against.
export const checkoutOf = (cli) => (typeof cli?.[1] === "string" && /\/daemon\/cli\.ts$/.test(cli[1]) ? cli[1].replace(/\/daemon\/cli\.ts$/, "") : null);
