// Ticket memory, layer 2 (recall.ts): transcripts cut into chunks, redacted before they reach the
// database, indexed once, searched with the journal by `factory recall`, and pruned after a ticket settles.
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { open } from "./db.ts";
import { endSessions, journal } from "./journal.ts";
import { chunkTranscript, indexSession, indexTranscripts, pruneChunks, TOOL_CAP } from "./recall.ts";
import { main, paths } from "./cli.ts";

// A transcript as Claude Code writes it: bookkeeping lines, the brief, thinking, text, tool calls
// and their results, a meta line, and a last line still being written.
const line = (o: object) => JSON.stringify({ timestamp: "2026-11-24T10:00:00Z", isSidechain: false, ...o });
const user = (content: unknown, extra = {}) => line({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (...content: object[]) => line({ type: "assistant", message: { role: "assistant", content } });
const result = (id: string, content: unknown) => user([{ type: "tool_result", tool_use_id: id, content }]);

function transcript(...lines: string[]) {
  const file = join(mkdtempSync(join(tmpdir(), "transcript-")), "s.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

const LONG = "x".repeat(3000) + " THE-MIDDLE " + "y".repeat(3000) + " the limiter leaks at the end";
const FIXTURE = [
  line({ type: "queue-operation", operation: "enqueue" }),
  user("Implement #412: rate-limit login"),
  assistant({ type: "thinking", thinking: "private musing about zebras" }),
  assistant({ type: "text", text: "Reading the login handler first." }),
  assistant({ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test login", description: "Run the login tests" } }),
  result("t1", LONG),
  user([{ type: "text", text: "Base directory for this skill: a skill body" }], { isMeta: true }),
  assistant({ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/w/src/login.ts" } }),
  result("t2", [{ type: "text", text: "export function login() {}" }]),
  '{"type":"assistant","message":{"role":"assis',
];

test("a transcript becomes one chunk per user turn, assistant text and tool call with its result, each at its line", () => {
  const chunks = chunkTranscript(FIXTURE.join("\n"));
  expect(chunks.map((c) => [c.line, c.role])).toEqual([[2, "user"], [4, "assistant"], [5, "tool"], [8, "tool"]]);
  expect(chunks[0].text).toBe("Implement #412: rate-limit login");
  expect(chunks[1].text).toBe("Reading the login handler first.");
  expect(chunks[3].text).toBe("Read\nfile_path: /w/src/login.ts\n→ export function login() {}");
  // A long result keeps its head and tail, not its middle.
  const bash = chunks[2].text;
  expect(bash).toStartWith("Bash\ncommand: bun test login\ndescription: Run the login tests\n→ xxx");
  expect(bash).toEndWith("the limiter leaks at the end");
  expect(bash).toContain("characters cut");
  expect(bash).not.toContain("THE-MIDDLE");
  expect(bash.length).toBeLessThan(TOOL_CAP + 200);
  // Thinking and meta lines are left out.
  expect(chunks.some((c) => /zebras|skill body/.test(c.text))).toBe(false);
});

function factoryDb() {
  const db = open(join(mkdtempSync(join(tmpdir(), "factory-")), "factory.db"));
  return db;
}
const addTicket = (db: Database, id: number, state = "running", updated = "2026-11-24T10:00:00Z") =>
  db.query("INSERT INTO tickets (id, title, state, updated_at) VALUES (?, ?, ?, ?)").run(id, `Ticket ${id}`, state, updated);
const addSession = (db: Database, ticket: number, transcript: string | null, ended: string | null = "2026-11-24T10:30:00Z") =>
  Number(db.query("INSERT INTO sessions (ticket, stage, argv, started_at, ended_at, transcript) VALUES (?, 'implement', '[\"claude\"]', '2026-11-24T10:00:00Z', ?, ?)")
    .run(ticket, ended, transcript).lastInsertRowid);
const chunkCount = (db: Database, where = "1") => (db.query(`SELECT COUNT(*) AS n FROM transcript_chunks WHERE ${where}`).get() as { n: number }).n;

test("every kind of secret is redacted before it reaches the database", () => {
  // Built here, not written in the file, so nothing in the repo looks like a live secret.
  const s = {
    anthropic: "sk-ant-api03-" + "A1b2C3d4".repeat(5),
    openai: "sk-proj-" + "Zq9".repeat(10),
    github: "ghp_" + "Gh7k".repeat(9),
    githubPat: "github_pat_" + "11AB".repeat(12),
    slack: "xoxb-" + "123456789-".repeat(3) + "abcDEF",
    aws: "AKIA" + "QWERTYUIOPASDFGH",
    google: "AIza" + "S".repeat(35),
    jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    bearer: "opaque" + "Tok3n".repeat(6),
    dbPassword: "hunter2-" + "pw".repeat(8),
    stripe: "sec" + "Ret".repeat(8),
    inline: "inl" + "ine".repeat(8),
    json: "cli" + "ent".repeat(8),
    yaml: "yam" + "lyam".repeat(6),
    pem: "MIIEvQ" + "IBADANBgkqhkiG9w0BAQEFAASC".repeat(4),
    awsSecret: "wJalr" + "XUtnFEMI".repeat(4),
  };
  const env = [
    `ANTHROPIC_API_KEY=${s.anthropic}`, `OPENAI_KEY="${s.openai}"`, `DB_PASSWORD=${s.dbPassword}`,
    `export STRIPE_SECRET=${s.stripe}`, `aws_secret_access_key = ${s.awsSecret}`, `password: ${s.yaml}`,
  ].join("\n");
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${s.pem}\n-----END RSA PRIVATE KEY-----`;
  const file = transcript(
    user(`My token is ${s.github} and the Slack one ${s.slack}; the Google key ${s.google}`),
    assistant({ type: "tool_use", id: "w", name: "Write", input: { file_path: "/w/.env", content: env } }),
    result("w", "File created"),
    assistant({ type: "tool_use", id: "c", name: "Bash", input: { command: `GITHUB_TOKEN=${s.inline} gh pr list && curl -H "Authorization: Bearer ${s.bearer}" https://api` } }),
    result("c", `config: {"client_secret": "${s.json}", "aws": "${s.aws}"}\njwt ${s.jwt}\npat ${s.githubPat}\n${s.openai}`),
    assistant({ type: "text", text: `Here is the key:\n${pem}\nand done` }),
  );
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  const db = open(join(dir, "factory.db"));
  addTicket(db, 1);
  expect(indexSession(db, addSession(db, 1, file))).toBe("indexed");
  const texts = (db.query("SELECT text FROM transcript_chunks").all() as { text: string }[]).map((r) => r.text).join("\n");
  expect(texts).toContain("[redacted");
  expect(texts).toContain("gh pr list"); // what's around a secret stays
  db.close();
  // Nowhere in the file, the full-text index included.
  const bytes = ["factory.db", "factory.db-wal"].map((f) => join(dir, f)).filter(existsSync).map((f) => readFileSync(f).toString("latin1")).join("");
  for (const [what, secret] of Object.entries(s)) {
    expect({ what, found: texts.includes(secret) }).toEqual({ what, found: false });
    expect({ what, found: bytes.includes(secret) }).toEqual({ what, found: false });
  }
});

test("indexing a session twice adds nothing; a transcript that grew is indexed again, whole", () => {
  const db = factoryDb();
  addTicket(db, 1);
  const file = transcript(...FIXTURE.slice(0, 5));
  const id = addSession(db, 1, file);
  expect(indexSession(db, id)).toBe("indexed");
  const n = chunkCount(db);
  expect(indexSession(db, id)).toBe("unchanged");
  expect(indexTranscripts(db, { now: "2026-11-24T11:00:00Z" })).toBe(0);
  expect(chunkCount(db)).toBe(n);
  writeFileSync(file, FIXTURE.join("\n"));
  expect(indexTranscripts(db, { now: "2026-11-24T11:00:00Z" })).toBe(1);
  expect(chunkCount(db)).toBe(4);
  expect(indexTranscripts(db, { now: "2026-11-24T11:00:00Z" })).toBe(0);
  expect(chunkCount(db)).toBe(4);
});

test("a session whose transcript was never written is skipped, quietly", () => {
  const db = factoryDb();
  addTicket(db, 1);
  const gone = addSession(db, 1, "/nowhere/never-written.jsonl", null);
  endSessions(db, { ticket: 1, at: "2026-11-24T10:30:00Z", why: "stage done" }); // ending it indexes it: nothing to index
  expect(indexSession(db, gone)).toBe("missing");
  expect(indexTranscripts(db, { now: "2026-11-24T11:00:00Z" })).toBe(0);
  expect(chunkCount(db)).toBe(0);
  expect(indexSession(db, addSession(db, 1, null))).toBe("none"); // a cloud session keeps no transcript
});

test("factory recall finds transcript chunks and journal events, in one ticket or across all", () => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-"));
  const out: string[] = [];
  const run = (...a: string[]) => { out.length = 0; main([...a, "--name", "acme-api"], (s) => out.push(s)); return out; };
  run("init", "--repo", "acme/api");
  run("ticket", "add", "412", "Rate-limit", "login");
  run("ticket", "add", "413", "Session", "cookies");
  const db = open(paths("acme-api").db);
  const file = transcript(...FIXTURE);
  addSession(db, 412, file, null);
  endSessions(db, { ticket: 412, at: "2026-11-24T10:30:00Z", why: "stage done" }); // indexed when it ends
  journal(db, { ticket: 412, kind: "check", text: "C4 FAIL: the limiter leaks under load", ref: "evidence:4", at: "2026-11-24T10:31:00Z" });
  journal(db, { ticket: 413, kind: "verdict", text: "review fail: the limiter cookie is unsigned", at: "2026-11-24T10:32:00Z" });
  db.close();

  const one = run("recall", "412", "limiter leaks");
  expect(one).toContainEqual(expect.stringMatching(/^#412 {2}check +.*\[limiter\] \[leaks\].*\[evidence:4\]$/));
  expect(one).toContainEqual(expect.stringMatching(new RegExp(`^#412 {2}tool .*\\[limiter\\].*\\[transcript:${file.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}#L5\\]$`)));
  expect(one.some((l) => l.startsWith("#413"))).toBe(false);

  const all = JSON.parse(run("recall", "limiter", "--json")[0]);
  expect(all.map((h: any) => `${h.ticket} ${h.source}`).sort()).toEqual(["412 journal", "412 transcript", "413 journal"]);
  expect(all.find((h: any) => h.source === "transcript")).toMatchObject({ kind: "tool", ref: `transcript:${file}#L5` });
  expect(JSON.parse(run("recall", "limiter", "--json", "--limit", "1")[0]).length).toBe(1);
  expect(run("recall", "412", "zebras")).toEqual(['#412: nothing in the journal or transcripts matches "zebras"']); // thinking isn't indexed
  expect(() => run("recall", "9", "limiter")).toThrow("no ticket 9");
});

test("pruning drops the chunks of tickets settled long ago, and keeps open tickets' chunks and every journal", () => {
  const db = factoryDb();
  const now = "2026-11-24T10:00:00Z";
  addTicket(db, 1, "merged", "2026-10-01T00:00:00Z"); // 54 days ago
  addTicket(db, 2, "closed", "2026-11-20T00:00:00Z"); // 4 days ago
  addTicket(db, 3, "running", "2026-09-01T00:00:00Z"); // old, but not settled
  for (const t of [1, 2, 3]) {
    indexSession(db, addSession(db, t, transcript(...FIXTURE)));
    journal(db, { ticket: t, kind: "stage", text: "entered implement", at: now });
  }
  expect(pruneChunks(db, { now, days: 30 })).toBe(4);
  expect([1, 2, 3].map((t) => chunkCount(db, `ticket = ${t}`))).toEqual([0, 4, 4]);
  expect((db.query("SELECT COUNT(*) AS n FROM ticket_events").get() as { n: number }).n).toBe(3);
  // Not indexed back by the tick, and a shorter setting prunes the recent one too.
  db.query("UPDATE sessions SET chunked_size = NULL").run();
  indexTranscripts(db, { now, days: 30 });
  expect(chunkCount(db, "ticket = 1")).toBe(0);
  expect(pruneChunks(db, { now, days: 2 })).toBe(4);
  expect([1, 2, 3].map((t) => chunkCount(db, `ticket = ${t}`))).toEqual([0, 0, 4]);
});
