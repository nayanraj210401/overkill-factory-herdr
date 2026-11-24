// The V2 Ticket page's views (docs/prototypes/ticket-v2): what the ticket is and where it
// stands on the left, what its agent is doing now on the right. Pure, no Herdr imports, so
// mods/factory-ticket/v2.js and `node --test` share them.
import { compact, ago } from "./model.js";
import { talkable } from "./actions.js";

// The left column's tabs. ⌘⌥1–6 (factory-ticket.tab-N) and bare 1–6 pick them. Memory reads
// the ticket's digest and searches its history through the CLI, not a file.
export const V2_TABS = [
  { key: "1", id: "plan", title: "Plan", file: "SLICES.md" },
  { key: "2", id: "checks", title: "Checks", file: "EVIDENCE.md" },
  { key: "3", id: "questions", title: "Questions", file: "GATES.md" },
  { key: "4", id: "pr", title: "PR", file: "PR.md" },
  { key: "5", id: "ask", title: "The ask", file: "INTENT.md" },
  { key: "6", id: "memory", title: "Memory", file: null },
];
// Read beside STATUS.md and the tabs' files: what triage made of the ask.
export const V2_FILES = ["INTENT.md", "GROOMING.md"];

// Which of the page's four designs a ticket gets. `asks`: its agent waits on you in its live
// terminal. `parked`: it waits on you with no session (u talks it through, or answer and
// resume). `working`: an agent runs it. `ready`: its PR waits for you. Anything else (queued,
// paused, blocked, merged, closed, grooming with nothing to ask) is `other`.
export function ticketKind(t) {
  if (!t) return "other";
  if (t.terminal && (t.needs?.kind === "attention" || (t.state === "grooming" && t.needs?.kind === "question"))) return "asks";
  if (t.state === "parked" || talkable(t)) return "parked";
  if (t.state === "ready") return "ready";
  if (t.state === "running") return "working";
  return "other";
}
// The kinds that wait on you: the strip's current stage and the agent dot take the ask colour.
export const waitsOnYou = (kind) => kind === "asks" || kind === "parked";

// "12m", "1h 5m", "2d 3h": how long since `iso`.
export function span(iso, now = Date.now()) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
  const h = Math.floor(m / 60);
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h / 24}d`;
}

// The compact stage strip, from STATUS.md's stages (parseStatusMd). Each is done, now or next,
// with a short line under its name. The stage in hand pulses unless the PR only waits on you.
export function stageStrip(stages, t, kind) {
  const rows = stages?.length ? stages : t?.stage ? [{ state: "now", name: t.stage[0].toUpperCase() + t.stage.slice(1), time: null, detail: "" }] : [];
  const rounds = (d) => (d ?? "").split(" · ").find((p) => /^(\d+ rounds|failed \d+×(?:, then passed)?)$/.test(p));
  return rows.map((st) => {
    if (st.state === "done") return { name: st.name, state: "done", sub: [st.time, rounds(st.detail)].filter(Boolean).join(" · "), pulse: false, asks: false };
    if (st.state === "next") return { name: st.name, state: "next", sub: "", pulse: false, asks: false };
    const so = st.time ? ` · ${st.time}` : "";
    const sub = kind === "asks" ? `asks you${so}` : kind === "parked" ? (t.questions?.length ? "parked on a question" : "parked") : kind === "ready" ? "waits for you"
      : t?.state === "paused" ? "paused" : t?.where === "cloud" ? `in cloud${so}` : `working${so}`;
    return { name: st.name, state: "now", sub, pulse: kind !== "ready" && t?.state !== "paused", asks: waitsOnYou(kind) };
  });
}

// "## Goal" in INTENT.md, and the like: the section's text, or null.
export function section(md, heading) {
  const parts = (md ?? "").split(/^(?=#{1,4}\s)/m);
  const hit = parts.find((p) => heading.test(p.split("\n")[0].replace(/^#+\s*/, "")));
  if (!hit) return null;
  const body = hit.split("\n").slice(1).join("\n").trim();
  return body || null;
}
const plain = (s) => s.replace(/<!--[\s\S]*?-->/g, "").replace(/\*\*|__|`/g, "").replace(/^\s*[-*]\s+/gm, "").replace(/\s+/g, " ").trim();
// The first paragraph of a Markdown file that isn't a heading.
const firstParagraph = (md) => (md ?? "").replace(/<!--[\s\S]*?-->/g, "").split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("#") && !p.startsWith("|")) ?? null;
// Cut at a sentence end when there is one before `n`, else at a word, with an ellipsis.
export function cut(text, n) {
  if (!text || text.length <= n) return text ?? "";
  const head = text.slice(0, n);
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  if (stop > n * 0.5) return head.slice(0, stop + 1);
  return `${head.slice(0, head.lastIndexOf(" ") > 0 ? head.lastIndexOf(" ") : n).trimEnd()}…`;
}

// The ask, short: INTENT.md's Goal, else what triage wrote first in GROOMING.md. null when
// neither exists yet (the title is all there is).
export function askShort(files) {
  const goal = section(files?.["INTENT.md"], /^goal\b/i);
  const text = goal ? plain(goal) : files?.["GROOMING.md"] ? plain(firstParagraph(files["GROOMING.md"]) ?? "") : "";
  return text ? cut(text, 280) : null;
}

// Where the ticket came from. An issue keeps its number (below 10000, as intake numbers them);
// a split's part says whose; a goal you typed has nothing else to link.
export function askSource(t, repo, files) {
  const part = (files?.["GROOMING.md"] ?? "").match(/^# Part (\d+) of (\d+) of #(\d+)/m);
  if (part) return { chip: `part ${part[1]} of #${part[3]}`, line: `Part ${part[1]} of ${part[2]} of #${part[3]}, split by its triage agent.`, url: null };
  if (t.id < 10000) return { chip: `issue #${t.id}`, line: `GitHub issue #${t.id}${repo ? ` in ${repo}` : ""}.`, url: repo ? `https://github.com/${repo}/issues/${t.id}` : null };
  return { chip: "your goal", line: "A goal you typed (factory new); its first words are the title.", url: null };
}

const DATE = /\b(?:before|by|until|deadline:?|due:?)\s+(\d{4}-\d{2}-\d{2})\b/i;
// A deadline the ask names ("before 2026-12-01", "Deadline: 2026-12-01"), with the days left.
export function deadline(t, files, now = Date.now()) {
  const m = [t.title, files?.["INTENT.md"], files?.["GROOMING.md"]].map((s) => (s ?? "").match(DATE)).find(Boolean);
  if (!m || Number.isNaN(Date.parse(m[1]))) return null;
  const today = new Date(now);
  const days = Math.round((Date.parse(`${m[1]}T00:00:00`) - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
  const left = days < 0 ? `passed ${-days}d ago` : days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`;
  return { date: m[1], days, text: `deadline ${m[1]} · ${left}`, warn: days <= 14 };
}

// Hard rules the ask sets: bullets of a "Hard rules", "Rules", "Constraints" or "Never"
// section, then "Do not …" / "Don't …" sentences, each as a short chip. At most three.
export function hardRules(files) {
  const out = [];
  for (const f of ["INTENT.md", "GROOMING.md"]) {
    const s = section(files?.[f], /^(hard rules?|rules|constraints|never|must not)\b/i);
    if (s) for (const l of s.split("\n")) { const b = l.match(/^\s*[-*\d.)]+\s+(.+)/); if (b) out.push(plain(b[1])); }
  }
  const text = [files?.["INTENT.md"], files?.["GROOMING.md"]].map((s) => plain(s ?? "")).join(" ");
  for (const m of text.matchAll(/\b(?:do not|don't|never)\s+([^.;,:]{3,60})/gi)) out.push(`don't ${m[1].trim()}`);
  const short = (r) => { const c = cut(r.replace(/\.$/, ""), 40); return /^[A-Z][a-z]/.test(c) ? c[0].toLowerCase() + c.slice(1) : c; };
  const seen = new Set();
  return out.map(short).filter((r) => !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase())).slice(0, 3);
}

// Spend against the budget: "$1.80 · 2.5M of 3M in". warn once the daemon warns.
export const spend = (t) => ({ text: `$${t.usd.toFixed(2)} · ${compact(t.tokens.input)} of ${compact(t.budget.input)} in`, warn: Boolean(t.warning) });

// The chips under the title: blueprint, source, deadline, spend, hard rules.
export function chips(t, repo, files, now = Date.now()) {
  const d = deadline(t, files, now);
  const src = askSource(t, repo, files);
  const s = spend(t);
  return [
    { id: "blueprint", label: "blueprint", value: t.blueprint, tone: null },
    { id: "source", label: "from", value: src.chip, tone: null, url: src.url },
    ...(d ? [{ id: "deadline", label: null, value: d.text, tone: d.warn ? "warn" : null }] : []),
    { id: "spend", label: null, value: s.text, tone: s.warn ? "warn" : null },
    ...hardRules(files).map((r, i) => ({ id: `rule-${i}`, label: null, value: r, tone: "rule" })),
  ];
}

// SLICES.md as the daemon reads it (daemon/slices.ts): ## / ### sections, else the numbered
// list. Each slice is done (marked [x], ✓, done), the one in hand, or still to do.
const MARKED = /\[x\]|✓|\bdone\b|\bshipped\b/i;
const stripItem = (l) => l.replace(/^\s*(#{1,6}|\d+[.)]|[-*+])\s+/, "").replace(/\[[ xX]\]\s*/, "").replace(/\*\*/g, "").trim();
export function slices(md, t, kind) {
  const headed = (md ?? "").split(/^(?=#{2,3}[ \t])/m).slice(1);
  const items = headed.length ? headed : (md ?? "").split(/^(?=\d+[.)][ \t])/m).filter((p) => /^\d+[.)][ \t]/.test(p));
  const all = items.map((p, i) => {
    const [first, ...rest] = p.trimEnd().split("\n");
    const status = rest.find((l) => /^\s*[-*]?\s*\**status\**\s*:/i.test(l)) ?? "";
    const title = stripItem(first).replace(/\s*(✓\s*done|✓|← now|\(done\))\s*$/i, "").trim();
    const note = rest.map((l) => l.trim()).find((l) => l && !/^\**status\**\s*:/i.test(l.replace(/^[-*]\s*/, "")));
    const n = Number(title.match(/\bS(\d+)\b/)?.[1] ?? i + 1);
    return { n, title: cut(plain(title.replace(/\s+—\s+.*$/, "")), 90), note: cut(plain(note ?? title.split(/\s+—\s+/)[1] ?? ""), 110), marked: MARKED.test(first) || MARKED.test(status) };
  });
  const finished = ["ready", "merged"].includes(t?.state);
  const hand = t?.slice?.n ?? null;
  const live = kind === "working" || kind === "asks" || kind === "parked";
  // The slice in hand, unless SLICES.md already marks it done: then the first one still open.
  const cur = hand != null && !all.find((s) => s.n === hand)?.marked ? hand : all.find((s) => !s.marked)?.n;
  return all.map((s) => {
    const state = finished || s.marked || (hand != null && s.n < hand) ? "done" : live && s.n === cur ? "now" : "next";
    return { ...s, state };
  });
}

// EVIDENCE.md's tables (daemon/ticket.ts evidenceMd): each check and verdict as a row.
// result: pass | fail | broken | pending.
export function checks(md) {
  const rows = [];
  let head = null;
  let kind = "check";
  for (const line of (md ?? "").split("\n")) {
    if (/^#+\s*verdicts/i.test(line)) { kind = "verdict"; head = null; continue; }
    if (!line.trim().startsWith("|")) { if (!line.trim()) head = null; continue; }
    const cells = line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (!head) { head = cells.map((c) => c.toLowerCase()); continue; }
    const at = (name) => cells[head.indexOf(name)] ?? "";
    const raw = at("result");
    const result = /PASS/i.test(raw) ? "pass" : /BROKEN/i.test(raw) ? "broken" : /FAIL/i.test(raw) ? "fail" : "pending";
    const name = (kind === "verdict" ? `${at("kind")} · ${at("from")}` : at("check")).replace(/`/g, "");
    const extra = raw.replace(/[✓✗⚠]|\b(PASS|FAIL|BROKEN|pending)\b/gi, "").trim();
    rows.push({ name, result, detail: [extra, at("detail")].filter(Boolean).join(" · "), when: at("when") });
  }
  return rows;
}
export const checkCount = (rows) => (rows.length ? `${rows.filter((r) => r.result === "pass").length}/${rows.length}` : "");

// The ready rules, as `factory ready <id>` prints them: "✓ evidence: 4 checks pass…".
export function readyRules(text) {
  const marks = { "✓": "pass", "✗": "fail", "⚠": "broken", "–": "skipped" };
  return (text ?? "").split("\n").map((l) => l.match(/^([✓✗⚠–])\s+([^:]+):\s*(.*)$/)).filter(Boolean)
    .map(([, m, rule, detail]) => ({ rule: rule.trim(), result: marks[m], detail: detail.trim() }));
}
// The pr stage's own count, from the ticket's detail ("6 of 6 ready rules").
export const readyCount = (t) => (t?.detail ?? "").match(/\d+ of \d+ ready rules/)?.[0] ?? null;

// `git diff` text → the files it changes: A(dded), D(eleted), R(enamed) or M(odified), with
// their +/- line counts, and the totals. The right column's "Files changed".
export function diffFiles(text) {
  const files = [];
  let f = null;
  for (const line of (text ?? "").split("\n")) {
    const head = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (head) { f = { path: head[2], status: "M", add: 0, del: 0 }; files.push(f); continue; }
    if (!f) continue;
    if (line.startsWith("new file")) f.status = "A";
    else if (line.startsWith("deleted file")) f.status = "D";
    else if (line.startsWith("rename from")) f.status = "R";
    else if (line.startsWith("+") && !line.startsWith("+++")) f.add++;
    else if (line.startsWith("-") && !line.startsWith("---")) f.del++;
  }
  const add = files.reduce((n, x) => n + x.add, 0);
  const del = files.reduce((n, x) => n + x.del, 0);
  return { files, add, del, text: files.length ? `${files.length} · +${add} −${del}` : "" };
}

// The journal's newest events (status.json `events`, oldest first), newest first, each with
// its clock time (or day, before today), a mark and a tone for its kind.
const MARK = {
  created: ["○", "dim"], blueprint: ["○", "dim"], groomed: ["○", "dim"], stage: ["▸", "accent"], "stage-end": ["✓", "ok"],
  retry: ["↻", "warn"], parked: ["⏸", "bad"], ready: ["✓", "ok"], "session-start": ["●", "accent"], "session-end": ["■", "dim"],
  handoff: ["↻", "accent"], question: ["?", "ask"], answer: ["↩", "ok"], talk: ["?", "ask"], attention: ["?", "ask"], ask: ["?", "ask"],
  "send-back": ["↩", "warn"], review: ["↩", "warn"], pr: ["↗", "accent"], merged: ["✓", "ok"], closed: ["×", "dim"],
  pause: ["⏸", "dim"], resume: ["▶", "accent"], cloud: ["☁", "accent"], split: ["⑂", "dim"], blocked: ["⛔", "bad"], lifecycle: ["·", "dim"],
  digest: ["◆", "dim"], "digest-edit": ["✎", "accent"], "digest-failed": ["◆", "warn"],
};
const two = (n) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function when(iso, now = Date.now()) {
  const d = new Date(iso);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return `${two(d.getHours())}:${two(d.getMinutes())}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
export function activity(events, now = Date.now(), limit = 8) {
  return [...(events ?? [])].reverse().slice(0, limit).map((e) => {
    let [mark, tone] = MARK[e.kind] ?? ["·", "dim"];
    if (e.kind === "check" || e.kind === "verdict") [mark, tone] = /\bPASS\b/.test(e.text) ? ["✓", "ok"] : /\bBROKEN\b/.test(e.text) ? ["⚠", "warn"] : ["✗", "bad"];
    return { time: when(e.at, now), mark, tone, text: e.text };
  });
}

// The agent line: a state dot, who runs which stage, and the time.
export function agentLine(t, kind, events = t?.events, now = Date.now()) {
  const stage = t.stage ?? "its stage";
  const slice = t.slice ? ` · S${t.slice.n} of ${t.slice.of}` : "";
  const session = t.session > 1 ? ` · session ${t.session}` : "";
  if (kind === "working") return {
    tone: "working", who: t.where === "cloud" ? `${t.agent ?? "agent"} · ${stage} · in the cloud` : `${t.agent ?? "agent"} · ${stage}${slice}`,
    time: t.resume_at ? `plan limit · resumes ${when(t.resume_at, now)}` : t.stage_started_at ? `${span(t.stage_started_at, now)} so far${session}` : session.slice(3),
  };
  if (kind === "asks") {
    const asked = [...(events ?? [])].reverse().find((e) => e.kind === "attention" || e.kind === "question");
    return { tone: "ask", who: `${t.agent ?? (t.state === "grooming" ? "triage" : "agent")} · ${stage} · asks you`, time: `waiting ${span(asked?.at ?? t.updated_at, now)}` };
  }
  if (kind === "parked") return { tone: "ask", who: "no agent running", time: `parked ${span(t.updated_at, now)}` };
  if (kind === "ready") return { tone: "ok", who: "done · waits for your merge", time: `ready ${ago(t.updated_at, now)}` };
  return { tone: "dim", who: t.state === "paused" ? `paused at ${stage}` : t.state === "blocked" ? `waits on #${t.blocked_by}` : t.state, time: ago(t.updated_at, now) };
}

// The token bar: input against its budget (the bar), the counts and cost, and the session
// with the context note the stage reports ("handoff at 60%").
export function tokenBar(t) {
  const frac = (a, b) => (b > 0 ? Math.min(1, a / b) : 0);
  const ctx = (t.detail ?? "").match(/(?:handoff at|context)\s*(\d+)%/)?.[0] ?? null;
  return {
    input: frac(t.tokens.input, t.budget.input), output: frac(t.tokens.output, t.budget.output),
    left: `${compact(t.tokens.input)} in · ${compact(t.tokens.output)} out · $${t.usd.toFixed(2)}`,
    right: [t.session ? `session ${t.session}` : null, ctx].filter(Boolean).join(" · "),
    warn: Boolean(t.warning),
  };
}

// The tail of a terminal's screen (`hc read`): its last `n` lines, trailing blanks dropped.
export function tail(text, n = 14) {
  const lines = String(text ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines.slice(-n);
}

// A question Claude Code's question tool (AskUserQuestion) shows in the terminal: the question,
// and its numbered options ("❯ 1. Label" with a description line under it). `free`: the option
// that opens a text box ("Type something"), if there is one. null when the screen shows none.
export function terminalQuestion(lines) {
  const at = [];
  lines.forEach((l, i) => { const m = l.match(/^\s*(?:[❯›>]\s*)?(\d)[.)]\s+(.+?)\s*$/); if (m) at.push({ i, n: Number(m[1]), label: m[2] }); });
  const run = [];
  for (const o of at) if (o.n === run.length + 1) run.push(o); else if (o.n === 1) run.splice(0, run.length, o);
  if (run.length < 2) return null;
  const options = run.map((o, k) => {
    const end = run[k + 1]?.i ?? lines.length;
    const detail = lines.slice(o.i + 1, end).map((l) => l.trim()).filter((l) => l && !/^(enter to|esc to|↑|tab\/)/i.test(l)).join(" ");
    return { n: o.n, label: o.label.replace(/^\[[ x✔]\]\s*/, ""), detail };
  });
  const above = lines.slice(0, run[0].i).map((l) => l.trim()).filter((l) => l && !/^[─━-]{3,}$/.test(l));
  const question = [...above].reverse().find((l) => /\?\s*$/.test(l)) ?? above.at(-1) ?? "";
  const free = options.find((o) => /type something|something else|^other\b|chat about/i.test(o.label))?.n ?? null;
  return { question, options: options.filter((o) => o.n !== free), free };
}

// What Send types into the live terminal, as `hc` argument lists. An option is its number key
// (the question tool picks it). Your own words go in the tool's text box when it has one (its
// number first), else as a message; `send --force` types past the waiting prompt.
export function answerKeys(terminal, q, pick, text) {
  const own = (text ?? "").trim();
  if (own) return [...(q?.free ? [["keys", terminal, String(q.free)]] : []), ["send", "--force", terminal, own]];
  if (pick != null) return [["keys", terminal, String(pick)]];
  return [];
}

// The state's buttons, primary first: [{id, label, key, tone, action}], `action` as
// keyAction gives it (lib/keys.js), so a click and its key do the same thing.
export function buttons(t, kind) {
  const diff = !["grooming", "queued"].includes(t.state) ? [{ id: "diff", label: "Diff", key: "d", action: { kind: "diff" } }] : [];
  const pause = t.state === "running" ? [{ id: "pause", label: "Pause", key: "p", action: { kind: "pause" } }] : [];
  if (kind === "working") return [{ id: "peek", label: "Open live terminal", key: "e", tone: "primary", action: { kind: "terminal" } }, ...diff, ...pause];
  if (kind === "asks") return [{ id: "answer", label: "Answer in terminal", key: "e", tone: "ask", action: { kind: "terminal" } }, ...diff, ...pause];
  if (kind === "parked") return [
    { id: "answer", label: talkable(t) ? "Talk it through" : "Answer and restart", key: "u", tone: "ask", action: { kind: "answer" } },
    ...diff, ...(t.state === "parked" ? [{ id: "close", label: "Close", key: "x", action: { kind: "drop" } }] : [])];
  if (kind === "ready") return [
    ...(t.pr ? [{ id: "open-pr", label: "Open PR", key: "o", tone: "primary", action: { kind: "github" } }] : []), ...diff,
    { id: "send-back", label: "Send back", key: "b", action: { kind: "send-back" } },
    ...(t.pr ? [{ id: "merge", label: t.repos?.length > 1 ? `Merge ${t.repos.filter((r) => r.pr).length} PRs` : "Merge", key: "m", action: { kind: "merge" } }] : [])];
  return [...diff, ...(t.state === "paused" ? [{ id: "pause", label: "Resume", key: "p", action: { kind: "pause" } }] : [])];
}

// The page's keys follow its buttons: on a parked ticket x closes it, on a ready one b sends
// it back and o opens the PR. Every other key does what it does on every page.
export function pageKey(a, t, kind) {
  if (!a) return null;
  if (kind === "parked" && a.kind === "send-back" && t.state === "parked") return { kind: "drop" };
  if (kind === "ready" && a.kind === "budget") return { kind: "send-back" };
  return a;
}

// A Markdown file cut at its headings, each heading kept as a small label above its text, so a
// "# Questions" in GATES.md or a digest's "## Current state" reads as the page's own section
// labels, not as a document title. A heading with nothing under it (GATES.md's "# GATES") is dropped.
export function mdSections(md) {
  const out = [];
  let cur = { heading: null, lines: [] };
  const push = () => { const body = cur.lines.join("\n").trim(); if (body) out.push({ heading: cur.heading, body }); };
  let fence = false;
  for (const line of String(md ?? "").replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (h) { push(); cur = { heading: h[1].replace(/\*\*|__|`/g, ""), lines: [] }; } else cur.lines.push(line);
  }
  push();
  return out;
}

// The Memory tab's digest (`factory digest <id> --json`, daemon/digest.ts digestOf): its text cut
// at its headings, how old it is, and the notes: whose it is when inherited, and your edits.
// null `d`: the ticket has none yet.
export function digestView(d, id, now = Date.now()) {
  if (!d?.text) return { state: "none", sections: [], age: null, notes: ["No digest yet. The factory writes one after the ticket's next session ends; Rebuild writes one now."], edited: false };
  const own = d.from === id;
  const edited = own && Boolean(d.edited);
  const notes = [
    ...(own ? [] : [`Inherited from #${d.from}: this ticket carries on from it, and its own digest replaces this one after its first session. Saving an edit makes it #${id}'s own.`]),
    ...(edited ? [`Has your edits (${ago(d.edited, now)}): every rewrite keeps your corrections and leaves out what you removed.`] : []),
  ];
  return { state: own ? "own" : "inherited", sections: mdSections(d.text), age: d.at ? `updated ${ago(d.at, now)}` : null, notes, edited, text: d.text };
}

// Where a journal ref or a transcript hit points, and what clicking it does: open a file, a URL,
// or another tab of this page. null when there's nothing to open (a session, a decision, an ask).
// Herdr opens a file with the system's app (exec open), which takes no line, so a transcript
// hit opens its file and names the line.
export function refTarget(ref, repo) {
  const m = String(ref ?? "").match(/^([a-z]+):(.+)$/);
  if (!m) return null;
  const [, kind, v] = m;
  if (kind === "transcript") {
    const [, path, line] = v.match(/^(.*?)(?:#L(\d+))?$/);
    return { open: "file", path, line: line ? Number(line) : null, label: line ? `transcript · line ${line}` : "transcript" };
  }
  if (kind === "file") return v === "TICKET-MEMORY.md" ? { open: "tab", tab: "6", label: "the digest" } : v.startsWith("/") ? { open: "file", path: v, line: null, label: v.split("/").pop() } : null;
  if (kind === "question") return { open: "tab", tab: "3", label: `Q${v}` };
  if (kind === "evidence") return { open: "tab", tab: "2", label: "Checks" };
  const gh = repo ? `https://github.com/${repo}` : null;
  if (kind === "pr" && /^\d+$/.test(v)) return gh ? { open: "url", url: `${gh}/pull/${v}`, label: `PR #${v}` } : null;
  if (kind === "issue" && /^\d+$/.test(v)) return gh ? { open: "url", url: `${gh}/issues/${v}`, label: `issue #${v}` } : null;
  if (kind === "commit" && /^[0-9a-f]{7,40}$/i.test(v)) return gh ? { open: "url", url: `${gh}/commit/${v}`, label: v.slice(0, 7) } : null;
  return null;
}

// `factory recall <id> "words" --json` (daemon/recall.ts recallHits) → the Memory tab's rows: what
// it is (a journal event's kind, or who spoke in a transcript), the snippet with the matched words
// in [brackets], when, and where a click goes.
export function hitRows(hits, repo, now = Date.now()) {
  return (Array.isArray(hits) ? hits : []).map((h, i) => {
    const target = refTarget(h.ref, repo);
    const who = h.source === "transcript" ? ({ user: "you", assistant: "agent", tool: "tool" })[h.kind] ?? h.kind : h.kind;
    return {
      id: `hit-${i}`, source: h.source, who, mark: h.source === "transcript" ? "❝" : activity([{ kind: h.kind, text: h.snippet ?? "", at: h.at ?? 0 }])[0].mark,
      snippet: String(h.snippet ?? "").replace(/\s+/g, " ").trim(), time: h.at ? when(h.at, now) : "", ref: h.ref ?? null,
      where: target?.label ?? (h.ref ? h.ref.split(":")[0] : ""), target,
    };
  });
}

// When the Memory tab reads the digest again: another ticket, or a new event in its journal (a
// digest, your edit, a rebuild all journal one, and status.json carries the newest).
export const memoryKey = (t) => `${t.id}:${t.events?.length ?? 0}:${t.events?.at(-1)?.at ?? ""}`;

// Rebuild on a digest you edited: the confirm dialog (factory-ask) first. Haiku may take a while.
export function rebuildAsk(t) {
  return {
    title: `Rebuild #${t.id}'s digest?`,
    detail: "Haiku writes it again from the whole journal and every transcript. You edited this digest: your corrections are kept, but the rest of the text is rewritten.",
    confirm: "Rebuild", args: ["digest", String(t.id), "--rebuild"], done: `#${t.id}'s digest rebuilt`, timeout: 180000,
  };
}
