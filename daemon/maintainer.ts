// The maintainer (plan: Changing the factory): a change to the factory itself, asked for in
// Overwatch, is a ticket on the shipped `factory` blueprint. The maintainer agent edits
// .factory/ in the ticket's worktree, the factory check proves it, and it comes back as a PR
// you merge (maintainer.gate). The person already agreed in Overwatch, so it skips grooming
// and starts when a slot is free.
import type { Database } from "bun:sqlite";
import { newTicket } from "./intake.ts";
import type { Run } from "./runner.ts";

export const BLUEPRINT = "factory";

export function request(db: Database, o: { text: string; repo: string; run: Run; now: string }) {
  const text = o.text.trim().replace(/\s+/g, " ");
  if (!text) throw new Error('say what to change: factory request "<the change, and why>"');
  // A link or #number would make it a GitHub issue ticket: a request is the person's words.
  if (/^#?\d+$|^https?:\/\//.test(text)) throw new Error("a request is a sentence about the change, not an issue link; use factory new for issues");
  const r = newTicket(db, { text, repo: o.repo, blueprint: BLUEPRINT, run: o.run, now: o.now, trigger: "maintainer" });
  db.query("UPDATE tickets SET groomed_at = ? WHERE id = ?").run(o.now, r.id);
  return r;
}
