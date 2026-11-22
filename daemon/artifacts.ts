// Shared plans as Claude artifacts (plan: Shared plans as Claude artifacts). With
// `artifacts: { as: artifact | doc }` in factory.yaml or the account's config.yaml, the agent
// that writes one of the listed files (INTENT.md, SLICES.md, PR.md, HANDOFF.md) also publishes
// it to claude.ai as the last step of its stage, and records the link with
// `factory artifact <id> <file> <url>`. Later sessions republish to the same link, and every
// brief that points at those files (stage, handoff, CLOUD.md, ROUTINE.md) gives the links too,
// so a cloud session reads the plan without anyone uploading it.
//
// Only an agent session can publish: the Artifact tool and the Claude Docs connector exist
// inside an interactive Claude Code session signed in to claude.ai, and there is no CLI or API
// for it (checked 2026-11-22: `claude -p` has neither the Artifact tool nor a publish flag).
// So the daemon never publishes; it asks, records, and logs. Publishing is best-effort: the
// local files stay the source of truth, and no ready rule looks at a link.
import type { Database } from "bun:sqlite";
import { readAccount } from "./account.ts";
import { PUBLISHABLE } from "./validate.ts";

export { PUBLISHABLE };
export const DEFAULT_PUBLISH = PUBLISHABLE;
export const KINDS = ["artifact", "doc", "off"] as const;
export type Kind = (typeof KINDS)[number];
export type ArtifactPolicy = { as: Kind; publish: string[] };
export type Link = { file: string; url: string; kind: string; at: string };

// The factory's artifacts: over the account's, key by key; off unless set.
export function artifactPolicy(factory: Record<string, any>, account: Record<string, any> = readAccount()): ArtifactPolicy {
  const v = { ...account.artifacts, ...factory.artifacts };
  const as: Kind = v.as === "artifact" || v.as === "doc" ? v.as : "off";
  return { as, publish: as === "off" ? [] : Array.isArray(v.publish) ? v.publish : DEFAULT_PUBLISH };
}

const URL_RE = /^https:\/\/claude\.ai\/\S+$/;

// `factory artifact <id> <file> <url>`: one link per ticket and file; a republish keeps it.
export function recordArtifact(db: Database, o: { id: number; file: string; url: string; kind?: string; now: string }) {
  if (!db.query("SELECT 1 FROM tickets WHERE id = ?").get(o.id)) throw new Error(`no ticket ${o.id}`);
  if (!PUBLISHABLE.includes(o.file)) throw new Error(`${o.file} isn't shared; one of ${PUBLISHABLE.join(", ")}`);
  if (!URL_RE.test(o.url)) throw new Error(`"${o.url}" isn't a claude.ai link (https://claude.ai/…)`);
  const kind = o.kind ?? (/\/code\/artifact\//.test(o.url) ? "artifact" : "doc");
  const was = db.query("SELECT url FROM ticket_artifacts WHERE ticket = ? AND file = ?").get(o.id, o.file) as { url: string } | null;
  db.query(`INSERT INTO ticket_artifacts (ticket, file, url, kind, published_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(ticket, file) DO UPDATE SET url = excluded.url, kind = excluded.kind, published_at = excluded.published_at`).run(o.id, o.file, o.url, kind, o.now);
  // The decision log says when a link appears or moves, not every republish.
  if (was?.url !== o.url) db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'agent', ?, ?, ?)")
    .run(o.id, was ? `${o.file} moved to a new shared link` : `shared ${o.file} on claude.ai`, o.url, o.now);
  return { file: o.file, url: o.url, first: !was, moved: !!was && was.url !== o.url };
}

// `factory artifact <id> <file> --fail <why>`: the publish didn't happen; the stage goes on.
export function publishFailed(db: Database, o: { id: number; file: string; why: string; now: string }) {
  if (!db.query("SELECT 1 FROM tickets WHERE id = ?").get(o.id)) throw new Error(`no ticket ${o.id}`);
  db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'agent', ?, ?, ?)")
    .run(o.id, `couldn't share ${o.file} on claude.ai; the local file stands`, o.why.slice(0, 300) || null, o.now);
}

export const artifactLinks = (db: Database, id: number): Link[] =>
  db.query("SELECT file, url, kind, published_at AS at FROM ticket_artifacts WHERE ticket = ? ORDER BY file").all(id) as Link[];

// The links a brief gives: only while sharing is on, so a link nobody republishes isn't offered as current.
export const sharedLinks = (db: Database, id: number, p: ArtifactPolicy) => (p.as === "off" ? [] : artifactLinks(db, id));

const how = (p: ArtifactPolicy, path: string, url: string | null) => p.as === "doc"
  ? `with the Claude Docs connector (its mcp__claude_ai_Claude_Docs__ tools): ${url ? `replace the content of the doc at ${url} with the file's Markdown, so the link stays the same` : "make one doc from the file's Markdown, titled with the ticket and file name"}`
  : `with your Artifact tool: action publish, file_path ${path}${url ? `, url ${url}, so the link stays the same` : ", icon document"}. Publish the Markdown file as it is; don't build an HTML page from it`;

// The paragraph that asks a session to share one file it wrote; "" when that file isn't shared.
export function publishStep(p: ArtifactPolicy, o: { id: number; file: string; path: string; links: Link[]; when?: string; what?: string }) {
  if (p.as === "off" || !p.publish.includes(o.file)) return "";
  const url = o.links.find((l) => l.file === o.file)?.url ?? null;
  return `${o.when ?? `When ${o.file} is written, as the last step before stage-done`}, share ${o.what ? `${o.what} on claude.ai as the ticket's ${o.file}` : `${o.file} on claude.ai`}, so cloud sessions read it by link: publish ${o.path} ${how(p, o.path, url)}. Then record the link: factory artifact ${o.id} ${o.file} <its link>. This is best-effort: if the tool isn't there or the publish fails, run factory artifact ${o.id} ${o.file} --fail "<why>" and go on; the stage passes on the local file. Publish nothing else.`;
}

// The paragraph that gives a session the links; "" with none.
export const sharedLine = (links: Link[], folder: string) => links.length
  ? `Shared copies on claude.ai, for sessions that can't see ${folder}: ${links.map((l) => `${l.file} ${l.url}`).join(", ")}. Read and edit the files in ${folder}; the links are copies.`
  : "";

// At stage-done: the stage's output is shared, but nothing was recorded since the stage began.
export function publishGap(db: Database, o: { id: number; file: string | undefined; since: string | null; policy: ArtifactPolicy; now: string }) {
  if (!o.file || o.policy.as === "off" || !o.policy.publish.includes(o.file)) return false;
  const row = db.query("SELECT url, published_at FROM ticket_artifacts WHERE ticket = ? AND file = ?").get(o.id, o.file) as { url: string; published_at: string } | null;
  if (row && (!o.since || row.published_at >= o.since)) return false;
  // Once per stage: the agent's own failure line, or this one, already says it.
  const noted = db.query("SELECT 1 FROM decisions WHERE ticket = ? AND (what LIKE ? OR what LIKE ?) AND at >= ?").get(o.id, `couldn't share ${o.file} %`, `${o.file} wasn't shared %`, o.since ?? "");
  if (!noted) db.query("INSERT INTO decisions (ticket, who, what, why, at) VALUES (?, 'daemon', ?, ?, ?)")
    .run(o.id, `${o.file} wasn't shared on claude.ai this stage; the local file stands`, row ? `the link still holds an earlier copy: ${row.url}` : "no link recorded", o.now);
  return true;
}
