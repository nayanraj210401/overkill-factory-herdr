// Loaded before every bun test (bunfig.toml). Child processes inherit these, so a
// fake that passes `herdr-app do …` through to the shell finds no app (an empty
// home has no socket) and falls back, and worktrees land in a temp folder.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FACTORY_TEST_SANDBOX = "1"; // daemon/herdr.ts refuses a test run without it
process.env.HERDR_APP_HOME = mkdtempSync(join(tmpdir(), "no-herdr-"));
process.env.FACTORY_WORKTREES = mkdtempSync(join(tmpdir(), "worktrees-"));
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "claude-"));
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "codex-"));

// Tests of the PR mechanics (ready rules, the watcher, review rounds) start at a pr stage
// with no agent, as a blueprint may have; the pr-writer agent has its own test.
export function agentlessPr(factoryDir: string) {
  const { readdirSync, readFileSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const dir = `${factoryDir}/blueprints`;
  for (const f of readdirSync(dir)) writeFileSync(`${dir}/${f}`, readFileSync(`${dir}/${f}`, "utf8").replace("agent: pr-writer, ", ""));
}
