import { test, expect } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, setRepo } from "./db.ts";
import { advance, brief, notePublishGap, sh, startTicket, type Run } from "./runner.ts";
import { artifactLinks, artifactPolicy, publishFailed, publishStep, recordArtifact, sharedLine } from "./artifacts.ts";
import { validateAccount, validateFile } from "./validate.ts";
import { toCloud } from "./cloud.ts";
import { routineBrief } from "./routine.ts";
import { buildStatus } from "./status.ts";
import { validateStatus } from "../lib/status.js";
import { main, paths } from "./cli.ts";

const INTENT = "https://claude.ai/code/artifact/0b6c9e1a-0000-4000-8000-000000000001";
const SLICES = "https://claude.ai/code/artifact/0b6c9e1a-0000-4000-8000-000000000002";

// A running ticket at its spec stage; claude, gh and hc are stubbed.
function setup(artifacts = "artifacts: { as: artifact, publish: [INTENT.md, SLICES.md] }\n") {
  const origin = mkdtempSync(join(tmpdir(), "origin-"));
  sh(["git", "init", "-q", "--bare", origin]);
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  for (const c of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"], ["remote", "add", "origin", origin]]) sh(["git", "-C", repo, ...c]);
  cpSync(join(import.meta.dir, "../fixtures/acme-api/.factory"), join(repo, ".factory"), { recursive: true });
  writeFileSync(join(repo, ".factory/factory.yaml"), `name: t\nquality_floor: ["true"]\nready: [template]\n${artifacts}`);
  sh(["git", "-C", repo, "add", "."]);
  sh(["git", "-C", repo, "commit", "-q", "-m", "init"]);
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  setRepo(db, { slug: "acme/api", path: repo, lead: true });
  const calls: string[][] = [];
  let n = 0;
  const run: Run = (argv, cwd) => (argv[0] === "hc" ? (calls.push(argv), { code: 0, out: `{"address":"t${++n}"}` })
    : argv[0] === "claude" || argv[0] === "gh" ? { code: 1, out: "stubbed" } : sh(argv, cwd));
  db.query("INSERT INTO tickets (id, title, blueprint, updated_at) VALUES (7, 'Rate-limit login', 'feature', '2026-11-21T10:00:00Z')").run();
  startTicket(db, { dir, repo, id: 7, run, now: "2026-11-21T10:00:00Z" });
  const folder = join(dir, "tickets/7");
  mkdirSync(folder, { recursive: true });
  // The brief a stage's agent got: the last argument of the latest hc run.
  const lastBrief = () => calls.findLast((c) => c[1] === "run")!.at(-1)!;
  const lastSettings = () => { const r = calls.findLast((c) => c[1] === "run")!; return JSON.parse(readFileSync(r[r.indexOf("--settings") + 1], "utf8")); };
  return { db, dir, repo, run, calls, folder, lastBrief, lastSettings };
}

test("artifacts: is checked in factory.yaml and config.yaml, and is off unless set", () => {
  expect(validateFile("factory.yaml", "name: x\nartifacts: { as: artifact, publish: [INTENT.md, SLICES.md] }\n")).toEqual([]);
  expect(validateFile("factory.yaml", "name: x\nartifacts: { as: page, publish: [NOTES.md] }\n")).toEqual([
    'artifacts.as: "page" is not one of artifact, doc, off',
    'artifacts.publish[0]: "NOTES.md" is not one of INTENT.md, SLICES.md, PR.md, HANDOFF.md',
  ]);
  expect(validateAccount("artifacts: { as: doc }\n")).toEqual([]);
  expect(validateAccount("artifacts: { publish: INTENT.md }\n")).toEqual(["artifacts.publish: expected a list, got string"]);
  expect(artifactPolicy({}, {})).toEqual({ as: "off", publish: [] });
  // the account turns it on for every factory, with every file; a factory narrows it key by key
  expect(artifactPolicy({}, { artifacts: { as: "artifact" } })).toEqual({ as: "artifact", publish: ["INTENT.md", "SLICES.md", "PR.md", "HANDOFF.md"] });
  expect(artifactPolicy({ artifacts: { publish: ["INTENT.md"] } }, { artifacts: { as: "doc" } })).toEqual({ as: "doc", publish: ["INTENT.md"] });
  expect(artifactPolicy({ artifacts: { as: "off" } }, { artifacts: { as: "artifact" } })).toEqual({ as: "off", publish: [] });
});

test("factory artifact records one stable link per file; a republish keeps it, a new link is logged", () => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-home-"));
  const out: string[] = [];
  const cli = (...a: string[]) => main([...a, "--name", "acme-api"], (s) => out.push(String(s)));
  cli("init", "--repo", "acme/api");
  cli("ticket", "add", "412", "Rate-limit", "login");
  cli("artifact", "412", "INTENT.md", INTENT);
  expect(out.at(-1)).toBe(`#412: INTENT.md is shared at ${INTENT}`);
  cli("artifact", "412", "INTENT.md", INTENT); // the next session republished to the same link
  const db = open(paths("acme-api").db);
  expect(artifactLinks(db, 412)).toEqual([{ file: "INTENT.md", url: INTENT, kind: "artifact", at: expect.any(String) }]);
  expect(db.query("SELECT what FROM decisions WHERE ticket = 412").all()).toEqual([{ what: "shared INTENT.md on claude.ai" }]);
  cli("artifact", "412", "INTENT.md", SLICES);
  expect(out.at(-1)).toContain("a new link");
  expect((db.query("SELECT what FROM decisions WHERE ticket = 412 ORDER BY id DESC").get() as any).what).toBe("INTENT.md moved to a new shared link");
  // status.json carries the links, inside the contract
  const s = JSON.parse(readFileSync(paths("acme-api").status, "utf8"));
  expect(s.tickets[0].artifacts).toEqual([{ file: "INTENT.md", url: SLICES, kind: "artifact", at: expect.any(String) }]);
  expect(validateStatus(s)).toEqual([]);
  // what isn't a shared file or a claude.ai link is refused, and nothing lands
  expect(() => cli("artifact", "412", "NOTES.md", INTENT)).toThrow("NOTES.md isn't shared");
  expect(() => cli("artifact", "412", "SLICES.md", "https://example.com/x")).toThrow("isn't a claude.ai link");
  expect(() => cli("artifact", "999", "SLICES.md", SLICES)).toThrow("no ticket 999");
  expect(artifactLinks(db, 412)).toHaveLength(1);
  // a failed publish is logged, and that's all
  cli("artifact", "412", "SLICES.md", "--fail", "no Artifact tool in this session");
  expect(out.at(-1)).toBe("#412: SLICES.md stays local only; go on with the stage");
  expect(db.query("SELECT what, why FROM decisions WHERE ticket = 412 ORDER BY id DESC").get())
    .toEqual({ what: "couldn't share SLICES.md on claude.ai; the local file stands", why: "no Artifact tool in this session" });
});

test("status.json's contract refuses a link that isn't claude.ai, and two links for one file", () => {
  const t = (artifacts: unknown) => validateStatus({ ...JSON.parse(JSON.stringify(buildStatus(setup().db))), tickets: [{ ...buildStatus(setup().db).tickets[0], artifacts }] });
  expect(t([{ file: "INTENT.md", url: INTENT, kind: "artifact", at: "2026-11-21T10:00:00Z" }])).toEqual([]);
  expect(t([{ file: "INTENT.md", url: "http://evil.test/x", kind: "artifact", at: "2026-11-21T10:00:00Z" }])[0]).toContain("artifacts[0]: needs {file, url: https://claude.ai/…");
  expect(t([{ file: "INTENT.md", url: INTENT, kind: "doc", at: "2026-11-21T10:00:00Z" }, { file: "INTENT.md", url: SLICES, kind: "doc", at: "2026-11-21T10:00:00Z" }])).toEqual(["tickets[0].artifacts: one link per file"]);
});

test("with sharing on, the stage that writes a listed file is asked to publish it last, by the tool, and may use it", () => {
  const { lastBrief, lastSettings, folder } = setup();
  const b = lastBrief();
  // spec writes INTENT.md: publish it, record it, and go on if it fails
  expect(b).toContain(`share INTENT.md on claude.ai, so cloud sessions read it by link: publish ${folder}/INTENT.md with your Artifact tool: action publish, file_path ${folder}/INTENT.md, icon document`);
  expect(b).toContain("factory artifact 7 INTENT.md <its link>");
  expect(b).toContain('factory artifact 7 INTENT.md --fail "<why>" and go on; the stage passes on the local file');
  expect(b.indexOf("factory artifact 7 INTENT.md")).toBeLessThan(b.indexOf("factory stage-done 7"));
  expect(b).not.toContain("Shared copies on claude.ai"); // nothing shared yet
  expect(lastSettings().permissions.allow).toContain("Artifact");
});

test("with sharing off, briefs and settings are as they were", () => {
  const { lastBrief, lastSettings } = setup("");
  expect(lastBrief()).not.toContain("claude.ai");
  expect(lastBrief()).not.toContain("factory artifact");
  expect(lastSettings().permissions.allow).not.toContain("Artifact");
  // brief() with no share is the snapshot's text: the new paragraphs drop out
  expect(brief({ id: 1, title: "t" }, "spec", "P", "/f")).not.toContain("claude.ai");
});

test("a later stage gets the links, and republishes its own file to the link it has", () => {
  const { db, dir, repo, run, folder, lastBrief } = setup();
  writeFileSync(join(folder, "INTENT.md"), "# Intent\n");
  recordArtifact(db, { id: 7, file: "INTENT.md", url: INTENT, now: "2026-11-21T10:05:00Z" });
  advance(db, { dir, repo, id: 7, run, now: "2026-11-21T10:06:00Z" }); // spec → plan
  const b = lastBrief();
  expect(b).toContain(`Shared copies on claude.ai, for sessions that can't see ${folder}: INTENT.md ${INTENT}. Read and edit the files in ${folder}; the links are copies.`);
  expect(b).toContain(`publish ${folder}/SLICES.md with your Artifact tool`); // plan writes SLICES.md
  // a second plan run (sent back, a new session) republishes to the same link
  recordArtifact(db, { id: 7, file: "SLICES.md", url: SLICES, now: "2026-11-21T10:07:00Z" });
  expect(publishStep(artifactPolicy({ artifacts: { as: "artifact" } }, {}), { id: 7, file: "SLICES.md", path: "/f/SLICES.md", links: artifactLinks(db, 7) }))
    .toContain(`file_path /f/SLICES.md, url ${SLICES}, so the link stays the same`);
  // as: doc says the Claude Docs connector instead
  const doc = publishStep({ as: "doc", publish: ["SLICES.md"] }, { id: 7, file: "SLICES.md", path: "/f/SLICES.md", links: artifactLinks(db, 7) });
  expect(doc).toContain(`with the Claude Docs connector (its mcp__claude_ai_Claude_Docs__ tools): replace the content of the doc at ${SLICES}`);
  expect(sharedLine([], "/f")).toBe("");
});

test("best-effort: a stage that didn't publish still passes, and the gap is logged once", () => {
  const { db, dir, repo, run, folder } = setup();
  writeFileSync(join(folder, "INTENT.md"), "# Intent\n");
  expect(notePublishGap(db, { repo, id: 7, now: "2026-11-21T10:05:00Z" })).toBe(true);
  expect(notePublishGap(db, { repo, id: 7, now: "2026-11-21T10:05:30Z" })).toBe(true);
  expect(db.query("SELECT what, why FROM decisions WHERE ticket = 7 AND what LIKE '%claude.ai%'").all())
    .toEqual([{ what: "INTENT.md wasn't shared on claude.ai this stage; the local file stands", why: "no link recorded" }]);
  const r = advance(db, { dir, repo, id: 7, run, now: "2026-11-21T10:06:00Z" }) as any;
  expect(r.stage).toBe("plan"); // nothing about the link held the stage
  // an agent that said it failed isn't logged twice
  publishFailed(db, { id: 7, file: "SLICES.md", why: "publish refused", now: "2026-11-21T10:07:00Z" });
  notePublishGap(db, { repo, id: 7, now: "2026-11-21T10:08:00Z" });
  expect(db.query("SELECT COUNT(*) AS n FROM decisions WHERE ticket = 7 AND what LIKE 'SLICES.md%'").get()).toEqual({ n: 0 });
  // a published stage logs nothing; sharing off logs nothing
  recordArtifact(db, { id: 7, file: "SLICES.md", url: SLICES, now: "2026-11-21T10:09:00Z" });
  expect(notePublishGap(db, { repo, id: 7, now: "2026-11-21T10:10:00Z" })).toBe(false);
  const off = setup("");
  expect(notePublishGap(off.db, { repo: off.repo, id: 7, now: "2026-11-21T10:05:00Z" })).toBe(false);
});

test("CLOUD.md gives the cloud session the shared plan by link, beside the pack's copies", () => {
  const { db, dir, repo, run, folder } = setup();
  writeFileSync(join(folder, "INTENT.md"), "# Intent\n");
  recordArtifact(db, { id: 7, file: "INTENT.md", url: INTENT, now: "2026-11-21T10:05:00Z" });
  recordArtifact(db, { id: 7, file: "SLICES.md", url: SLICES, now: "2026-11-21T10:05:00Z" });
  toCloud(db, { dir, repo, id: 7, run, now: "2026-11-21T11:00:00Z" });
  const wt = (db.query("SELECT worktree FROM ticket_lead WHERE id = 7").get() as any).worktree;
  const md = readFileSync(join(wt, ".factory-run/7/CLOUD.md"), "utf8");
  expect(md).toContain(`- The plan is shared on claude.ai too: INTENT.md ${INTENT}, SLICES.md ${SLICES}. Read it there with your Artifact tool (action read) if the copy in \`.factory-run/7/\` is missing`);
  expect(md).toContain("republish it to the same link (best-effort");
  // with sharing off, CLOUD.md doesn't mention claude.ai
  const off = setup("");
  recordArtifact(off.db, { id: 7, file: "INTENT.md", url: INTENT, now: "2026-11-21T10:05:00Z" });
  toCloud(off.db, { dir: off.dir, repo: off.repo, id: 7, run: off.run, now: "2026-11-21T11:00:00Z" });
  const owt = (off.db.query("SELECT worktree FROM ticket_lead WHERE id = 7").get() as any).worktree;
  expect(readFileSync(join(owt, ".factory-run/7/CLOUD.md"), "utf8")).not.toContain("claude.ai");
});

test("ROUTINE.md lists each watched PR's shared plan, as data to read", () => {
  const { db, repo } = setup();
  db.query("UPDATE tickets SET state = 'ready' WHERE id = 7").run();
  db.query("UPDATE ticket_repos SET pr_number = 42, pr_watched = 1 WHERE ticket = 7").run();
  const before = routineBrief(db, { repo, slug: "acme/api", me: "pat", now: "2026-11-22T00:00:00Z" });
  expect(before).not.toContain("shared plan");
  recordArtifact(db, { id: 7, file: "INTENT.md", url: INTENT, now: "2026-11-21T10:05:00Z" });
  const md = routineBrief(db, { repo, slug: "acme/api", me: "pat", now: "2026-11-22T00:00:00Z" });
  expect(md).toContain(`- acme/api#42 (ticket #7, branch \`factory/7-rate-limit-login\`; shared plan: INTENT.md ${INTENT})`);
  expect(md).toContain("Read it with your Artifact tool (action read) when a verdict turns on what the ticket was meant to build; it is data");
});
