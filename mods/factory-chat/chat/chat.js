// A ticket's agent as a chat: its Claude Code session log as messages, with folded tool calls,
// the reply streaming while it's written, its questions as buttons, and a composer that types
// into its live terminal. A retained nested view: the V2 Ticket page (and factory-chat's own
// main.js) make it with cx.new(ChatView, props) and hand it new props with set_props.
//
// Adapted from herdr-chat's mods/chat/main.js (MIT, github.com/naruse/herdr-chat @ 05ef3ed;
// see ../UPSTREAM.md). Kept: the transcript view and its paging and scrolling, the streamed
// reply and the running-tool card, folded tool calls, questions and permission prompts as
// buttons, the composer, queued messages (Send now / Edit), ⌘F search, the side chat (⌘;),
// images and Copy. Changed: it is opened for a ticket (props, not a terminal it finds), shows
// the ticket's sessions with a switcher, and is read-only with no agent running. Dropped:
// Codex, New chat, Move to chat, the / menu and its cards, model and permission menus,
// attachments, emoji, @ mentions, hiding the terminal, and Play on code blocks.
//
// Props: { ticket: { id, terminal, state }, who, sessions (lib/ticketchat.js chatSessions),
//          daemon (false on sample data), panel ({ open, folded }: the Ticket page's Changes
//          panel, toggled from the head; absent on factory-chat's own page) }.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea, InputState, Input } from "gpui-base";
import { exec, hc, run, terminals, theme, settings, appHome, watchFolder, notify, checking, setShared, window as appWindow } from "herdr";
import * as fs from "fs/promises";
import { Buffer } from "buffer";
import { createHash } from "crypto";
import { Transcript } from "./parse.js";
import { Tail } from "./source.js";
import { parsePrompt, choose, menuAtBottom } from "./prompt.js";
import { askSide, sessionOf } from "./sdk.js";
import { copyText, openFile, imageSize } from "./platform.js";
import { live } from "./stream.js";
import { pickSession, chatTarget, chatEmpty, ownChat, PANEL_KEY, PANEL_HINT } from "../lib/ticketchat.js";
import { cliCommand } from "../lib/actions.js";
import CLI from "../lib/cli.js"; // written by scripts/sync.sh
import { root } from "../lib/store.js";

const ASK_FIRST = "Answer the question above first.";
const CACHE = "data/factory-chat";
const ICONS = "mods/factory-chat/icons";
const PAGE = 60;
const WIDTH = 760; // the conversation's column, as the prototype draws it
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MODES = { default: "ask before edits", acceptEdits: "accept edits", plan: "plan mode", auto: "auto mode", bypassPermissions: "bypass permissions" };

const sleep = (cx, ms) => new Promise((r) => cx.timer.after(ms, () => r()));
const hash = (s) => createHash("sha1").update(s).digest("hex").slice(0, 16);
const MAC = (() => { try { return appWindow().platform === "macos"; } catch { return true; } })();
const shortcut = (key) => (MAC ? `⌘${key}` : `Ctrl+${key}`);

// A reply cut into markdown and fenced code blocks: [{ md } | { code, lang, fence }].
// Fences may be indented (a block inside a list item); its lines lose that indent.
export function splitCode(text) {
  const lines = text.split("\n");
  const out = [];
  let md = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s{0,6})(`{3,}|~{3,})\s*([\w+.-]*)\s*$/.exec(lines[i]);
    if (!open) { md.push(lines[i]); continue; }
    const [, indent, fence, lang] = open;
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^\\s{0,6}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(lines[j])) j++;
    if (j >= lines.length) { md.push(lines[i]); continue; }
    if (md.join("").trim()) out.push({ md: md.join("\n") });
    md = [];
    const code = lines.slice(i + 1, j).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart())).join("\n");
    out.push({ code, lang, fence });
    i = j;
  }
  if (md.join("").trim() || !out.length) out.push({ md: md.join("\n") });
  return out;
}

// A tool call's result in a few words, for its folded row: "error", "24 lines", or its one line.
export function resultWord(item) {
  if (item.result === null) return "…";
  if (item.error) return "error";
  const lines = item.result.split("\n").filter((l) => l.trim());
  if (!lines.length) return item.images.length ? `${item.images.length} image${item.images.length > 1 ? "s" : ""}` : "done";
  if (lines.length === 1 && lines[0].length <= 28) return lines[0].trim();
  return `${lines.length} lines`;
}

export class ChatView extends View {
  init(props, cx) {
    this.props = props ?? {};
    this.gen = 0;
    this.t = null;
    this.file = null; // the transcript shown
    this.want = null; // the transcript asked for (a session's file, or found from its Claude session)
    this.picked = this.props.first ?? null; // the session picked in the switcher; null follows the live one
    this.limit = PAGE;
    this.open = new Set();
    this.images = {};
    this.pending = []; // sent, not yet in the log: { text, users, at }
    this.off = 0;
    this.viewH = 0;
    this.contentH = 0;
    this.width = 600;
    this.watches = {}; // one pending watchFolder per folder (see start)
    this.side = { open: false, items: [], off: 0, viewH: 0, contentH: 0 };

    this.input = TextareaState.new({ placeholder: "Message the agent… it reads this at its next step" });
    this.input.set_auto_grow(1, 10);
    this.input.on("submit", (e, cx) => { if (!e?.shift) this.send(cx); });
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.input.on("change", (_e, cx) => cx.notify());
    this.search = InputState.new({ placeholder: "Search this conversation" });
    this.search.on("change", (_e, cx) => { this.off = 0; cx.notify(); });
    this.sideInput = TextareaState.new({ placeholder: "Ask about this conversation…" });
    this.sideInput.set_auto_grow(1, 6);
    this.sideInput.on("submit", (e, cx) => {
      if (e?.shift) return;
      const q = this.sideInput.value().trim();
      this.sideInput.set_value("");
      this.askSideQ(q, cx);
    });
    try {
      cx.bind_keys([
        { keystroke: MAC ? "cmd-;" : "ctrl-;", action: "chat_side_toggle", context: "FactoryChat" },
        { keystroke: MAC ? "cmd-f" : "ctrl-f", action: "chat_search", context: "FactoryChat" },
        { keystroke: "escape", action: "chat_search_close", context: "FactoryChatSearch" },
      ]);
    } catch {}
    if (checking()) return;
    cx.spawn(async () => {
      await fs.mkdir(`${appHome()}/${CACHE}`, { recursive: true }).catch(() => {});
      await exec("find", [`${appHome()}/${CACHE}`, "-mtime", "+7", "-type", "f", "-delete"]).catch(() => {});
    });
    this.checkTimer = cx.timer.every(2000, (cx) => this.check(cx));
  }

  // New props from the page: another ticket drops the pick; the same one keeps it.
  update(props) {
    if (props?.ticket?.id !== this.props?.ticket?.id) this.picked = null;
    this.props = props ?? {};
  }

  // What the props and the pick come to: the sessions, the one shown, and what the chat may do with it.
  view() {
    const p = this.props ?? {};
    const sessions = p.sessions ?? [];
    const session = pickSession(sessions, this.picked);
    return { sessions, session, target: chatTarget(p.ticket, session, { daemon: p.daemon !== false, sessions }) };
  }

  get term() { return this.view().target.terminal; }
  terminal() { const a = this.term; return a ? terminals().find((x) => x.address === a) ?? null : null; }
  status() { return this.terminal()?.status ?? null; }

  pick(id, cx) {
    this.picked = id;
    this.pending = [];
    this.screen = this.idleAsk = null;
    this.stream = this.running = null;
    this.off = 0;
    cx.notify();
  }

  // The transcript to read for the shown session: its file, else its Claude session's log found
  // under ~/.claude/projects. Started once per file; called from render, so it only spawns.
  follow(cx) {
    const { session } = this.view();
    const key = session ? `${session.id}:${session.file ?? session.claude ?? ""}` : null;
    if (key === this.want) return;
    this.want = key;
    this.gen++;
    this.t = null;
    this.file = null;
    this.error = null;
    if (!session || checking() || this.props?.daemon === false) return;
    if (session.file) return this.start(session.file, cx);
    if (!session.claude) return;
    const want = key;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'ls "$HOME"/.claude/projects/*/"$1".jsonl 2>/dev/null | head -1', "sh", session.claude]).catch(() => null);
      const file = r?.stdout?.trim();
      if (this.want !== want) return;
      if (file) this.start(file, cx);
      else { this.error = `No transcript for Claude session ${session.claude} on this machine.`; cx.notify(); }
    });
  }

  start(file, cx) {
    const gen = ++this.gen;
    this.file = file;
    this.t = new Transcript("claude");
    this.limit = PAGE;
    this.off = 0;
    this.error = null;
    const tail = new Tail(file, null);
    const dir = file.slice(0, file.lastIndexOf("/"));
    this.beat = Date.now();
    cx.spawn(async (cx) => {
      while (gen === this.gen) {
        this.beat = Date.now();
        try {
          const lines = await tail.read();
          if (gen !== this.gen) return;
          this.truncated = tail.truncated;
          if (lines.length) {
            for (const l of lines) this.t.feed(l);
            this.cacheShown(cx);
            cx.notify();
          }
          if (this.error) { this.error = null; cx.notify(); }
        } catch (e) {
          this.error = String(e?.message ?? e);
          cx.notify();
        }
        // One pending watchFolder per folder: a watch that loses the 15-second race stays open
        // until the folder changes, so a new one each time would pile up.
        const w = (this.watches[dir] ??= watchFolder(dir).catch(() => sleep(cx, 3000)).finally(() => {
          if (this.watches[dir] === w) delete this.watches[dir];
        }));
        await Promise.race([w, sleep(cx, 15000)]);
      }
    });
  }

  // Every 2 s while the shown session is live: the streamed reply while it works, and the
  // question it waits on (blocked), or a menu it left on screen once idle.
  check(cx) {
    this.checked = Date.now();
    if (this.props?.active === false) return; // the page shows Overview or Diff: nothing to follow
    const term = this.terminal();
    if (!term) { if (this.screen || this.idleAsk) { this.screen = this.idleAsk = null; cx.notify(); } return; }
    const quiet = (since, ms) => Date.now() - (since ?? 0) > ms;
    // A loop that went quiet has stopped (a reload ends a mod's tasks): start it again.
    if (term.status === "working" && (!this.streamLoop || quiet(this.streamLoop.beat, 10000))) this.stream_(cx);
    if (this.file && quiet(this.beat, 60000)) this.start(this.file, cx);
    if (term.status === "blocked") {
      this.idleAsk = null;
      cx.spawn(async (cx) => {
        const r = await hc(["read", this.term, "--lines", "40"]).catch(() => null);
        this.screen = r ? r.stdout.replace(/\s+$/, "") : null;
        cx.notify();
      });
    } else if (this.t && ["idle", "done"].includes(term.status)) {
      // A menu the agent opens once a turn ends doesn't report "blocked": only the screen shows it.
      cx.spawn(async (cx) => {
        const r = await hc(["read", this.term, "--lines", "40"]).catch(() => null);
        const screen = (r?.stdout ?? "").replace(/\s+$/, "");
        const ask = menuAtBottom(screen);
        if (!ask && !this.idleAsk) return;
        if (!ask && this.error === ASK_FIRST) this.error = null;
        this.idleAsk = ask;
        this.screen = ask ? screen : null;
        cx.notify();
      });
    } else if (this.screen) {
      this.screen = null;
      this.idleAsk = null;
      cx.notify();
    }
  }

  // While the agent works: the reply it's writing, read off its terminal a few times a second,
  // until the log has it.
  stream_(cx) {
    const loop = (this.streamLoop = { beat: Date.now() });
    const term = this.term;
    cx.spawn(async (cx) => {
      while (this.streamLoop === loop && this.term === term && this.status() === "working") {
        loop.beat = Date.now();
        const r = await hc(["read", term, "--lines", "80"]).catch(() => null);
        const now = r ? live(r.stdout) : null;
        const text = now?.kind === "text" ? now.text : null;
        // Between steps the screen can show nothing new: keep the last command's card rather
        // than drop it and bring one back (the page would jump). New reply text replaces it.
        const fresh = text && !this.logged(text);
        const run = now?.kind === "run" ? now : fresh ? null : this.running;
        if (text !== this.stream || JSON.stringify(run) !== JSON.stringify(this.running)) { this.stream = text; this.running = run; cx.notify(); }
        await sleep(cx, 350);
      }
      if (this.streamLoop === loop) this.streamLoop = null;
      this.stream = null;
      this.running = null;
      cx.notify();
    });
  }

  // Whether the log already has this reply text (in this turn).
  logged(text) {
    const norm = (x) => (x ?? "").replace(/[\s*_`#>]+/g, " ").trim();
    const n = norm(text), head = n.slice(0, 80), tail = n.slice(-80);
    const ents = this.t?.entries ?? [];
    for (let i = ents.length - 1; i >= 0 && ents[i].kind !== "user"; i--) {
      if (ents[i].kind !== "assistant") continue;
      const e = norm(ents[i].text);
      if (e.includes(head) || e.includes(tail)) return true;
    }
    return false;
  }

  streamShown() { return this.stream && !this.logged(this.stream) ? this.stream : null; }

  copyOut(text, id, cx) {
    cx.spawn(async (cx) => {
      if (!(await copyText(text))) return notify({ title: "No clipboard tool", level: "warning", timeout: 4000 });
      this.copied = id;
      cx.notify();
      await sleep(cx, 1500);
      if (this.copied === id) { this.copied = null; cx.notify(); }
    });
  }

  hover(key) {
    return (on, cx) => {
      if (on && this.hovered !== key) { this.hovered = key; cx.notify(); }
      else if (!on && this.hovered === key) { this.hovered = null; cx.notify(); }
    };
  }

  // ── sending ─────────────────────────────────────────────────────────────

  userCount() { return (this.t?.entries ?? []).filter((e) => e.kind === "user").length; }

  // Sent messages leave the queue once the log records them: a user message added since, with
  // the same text. One the log never matched goes once the agent has been idle a while.
  settle() {
    const users = (this.t?.entries ?? []).filter((e) => e.kind === "user");
    const busy = ["working", "blocked"].includes(this.status());
    this.pending = this.pending.filter((p) => busy || Date.now() - p.at < 15000);
    const used = new Set();
    this.pending = this.pending.filter((p) => {
      const i = users.findIndex((u, n) => n >= p.users && !used.has(n) && Boolean(u.text?.includes(p.text.slice(0, 60))));
      if (i < 0) return true;
      used.add(i);
      return false;
    });
  }

  // Whether Claude Code still holds this message in its queue (its log says).
  inQueue(p) { return (this.t?.queue ?? []).some((q) => q.includes(p.text.slice(0, 60))); }

  // Claude Code's own queue keys: ctrl+enter stops the turn and sends it now; up takes every
  // queued message back into its input, cleared there line by line, and back to the box to edit.
  sendNow() { if (this.term) hc(["keys", this.term, "ctrl+enter"]); }
  editQueued() {
    if (!this.term) return;
    const taken = (this.t?.queue ?? []).filter(Boolean);
    const lines = taken.join("\n").split("\n").length;
    hc(["keys", this.term, "up", ...Array(lines).fill(["ctrl+u", "backspace"]).flat()]);
    this.pending = this.pending.filter((x) => !this.inQueue(x));
    if (this.t) this.t.queue = [];
    const draft = this.input.value().trim();
    this.input.set_value([...taken, draft].filter(Boolean).join("\n"));
    this.input.focus();
  }

  send(cx) {
    const text = this.input.value().trim();
    // /btw and /side never reach the agent: they open the side chat.
    const aside = /^\/(?:btw|side)(?:\s+([\s\S]*))?$/.exec(text);
    if (aside) {
      this.input.set_value("");
      this.openSide(aside[1]?.trim() ?? "", cx);
      return cx.notify();
    }
    const term = this.term;
    if (!term) return; // read-only: the composer says why
    if (this.idleAsk) { this.error = ASK_FIRST; return cx.notify(); }
    // A lone "/" would open the terminal's own menu and run its first command.
    if (!text || text === "/") { this.input.set_value(""); return; }
    this.input.set_value("");
    this.off = 0;
    // Slash commands and ! lines are logged as notes, not messages: no bubble for them.
    if (!/^[\/!]/.test(text)) this.pending.push({ text, users: this.userCount(), at: Date.now() });
    cx.spawn(async (cx) => {
      const r = await hc(["send", term, text]).catch((e) => ({ code: 1, stderr: String(e) }));
      this.error = r.code === 0 ? null : String(r.stderr || "").trim() || "send failed";
      cx.notify();
    });
    cx.notify();
  }

  // ── search and the side chat ────────────────────────────────────────────

  shown() {
    let ents = this.t?.entries ?? [];
    const q = this.searching ? this.search.value().trim().toLowerCase() : "";
    if (q) {
      const text = (e) => [e.text, e.title, ...(e.items ?? []).flatMap((i) => [i.name, i.summary, i.result])].filter(Boolean).join("\n").toLowerCase();
      ents = ents.filter((e) => text(e).includes(q));
      this.matches = ents.length;
      return { start: Math.max(0, ents.length - 200), ents };
    }
    return { start: Math.max(0, ents.length - this.limit), ents };
  }

  openSearch(cx) { this.searching = true; this.search.focus(); cx.notify(); }
  closeSearch(cx) { this.searching = false; this.search.set_value(""); this.off = 0; this.input.focus(); cx.notify(); }

  openSide(question, cx) {
    this.side.open = true;
    if (question) this.askSideQ(question, cx);
    this.sideInput.focus();
    cx.notify();
  }

  // Answered by a read-only fork of the session (claude -p --resume --fork-session), so the
  // agent is never interrupted and nothing is added to its conversation.
  askSideQ(question, cx) {
    if (!question) return;
    const item = { q: question, a: null, error: null, pending: true };
    const history = this.side.items.filter((x) => x.a).map((x) => ({ question: x.q, response: x.a }));
    this.side.items.push(item);
    this.side.off = 0;
    const session = sessionOf(this.file);
    cx.spawn(async (cx) => {
      if (!session) item.error = "The side chat answers from this session's conversation: none is loaded yet.";
      else {
        const r = await askSide(this.t?.cwd ?? null, session, question, history, null).catch((e) => ({ error: String(e?.message ?? e) }));
        item.a = r.text ?? null;
        item.error = r.error ?? null;
      }
      item.pending = false;
      cx.notify();
    });
    cx.notify();
  }

  // ── images ──────────────────────────────────────────────────────────────

  // Images are drawn from Herdr's folder, so the shown ones are copied there first.
  cacheShown(cx) {
    const { start, ents } = this.shown();
    for (const e of ents.slice(start)) for (const img of [...(e.images ?? []), ...(e.items ?? []).flatMap((i) => i.images)]) this.cache(img, cx);
  }

  cache(img, cx) {
    img.ref ??= img.data ? hash(img.data.slice(0, 8192) + img.data.length) : hash(img.path);
    if (this.images[img.ref]) return;
    this.images[img.ref] = "pending";
    cx.spawn(async (cx) => {
      try {
        const ext = img.ext ?? (img.path.split(".").pop() || "png").toLowerCase();
        const rel = `${CACHE}/${img.ref}.${ext}`, abs = `${appHome()}/${rel}`;
        if (img.data) await fs.writeFile(abs, Buffer.from(img.data, "base64"));
        else if ((await exec("cp", [img.path, abs])).code !== 0) throw new Error("copy failed");
        const { w, h } = (await imageSize(abs)) ?? { w: 320, h: 240 };
        this.images[img.ref] = { rel, abs, w, h };
      } catch {
        this.images[img.ref] = "failed";
      }
      cx.notify();
    });
  }

  clamp() { this.off = Math.max(0, Math.min(this.off, Math.max(0, this.contentH - this.viewH))); }

  // ── drawing ─────────────────────────────────────────────────────────────

  tinyButton(id, icon, tip, action, t) {
    return div().id(id).flex_none().size(24).flex().items_center().justify_center().rounded(6).cursor_pointer()
      .bg(t.background).border_1().border_color(t.border).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action)
      .child(svg(`${ICONS}/${icon}.svg`).size(12));
  }

  button(id, text, action, t, tone) {
    return div().id(id).flex_none().px(10).py(5).rounded(6).cursor_pointer().text_size(12).border_1()
      .border_color(tone === "ask" ? t.blocked : t.border).bg(t.background).text_color(tone === "ask" ? t.blocked : t.foreground)
      .hover((s) => s.border_color(t.accent)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(text);
  }

  img(ref, t, maxW = 360, maxH = 260) {
    const c = this.images[ref];
    if (!c || typeof c === "string") {
      return div().w(120).h(80).rounded(8).bg(t.raised).flex().items_center().justify_center()
        .text_size(11).text_color(t.dim).child(c === "failed" ? "image" : "…");
    }
    const k = Math.min(1, maxW / c.w, maxH / c.h);
    return div().id(`img-${ref}`).cursor_pointer().rounded(8).overflow_hidden().border_1().border_color(t.border)
      .tooltip("Open").on_click(() => openFile(c.abs))
      .child(image(c.rel).w(Math.round(c.w * k)).h(Math.round(c.h * k)));
  }

  markdown(id, text) { return TextView.markdown(id, text).selectable(true); }

  // A reply: its markdown, each code block on its own with a Copy button.
  reply(e, t) {
    const parts = splitCode(e.text ?? "");
    if (parts.length === 1 && parts[0].md != null) return div().w_full().child(this.markdown(e.key, e.text));
    return v_flex().w_full().gap(8).children(parts.map((p, n) => {
      if (p.md != null) return div().w_full().child(this.markdown(`${e.key}-${n}`, p.md));
      const id = `${e.key}-${n}`;
      const done = this.copied === id;
      return div().w_full().relative()
        .child(this.markdown(id, `${p.fence}\n${p.code}\n${p.fence}`))
        .child(h_flex().absolute().top(6).right(6).gap(4).items_center()
          .when(Boolean(p.lang), (el) => el.child(div().pr(4).text_size(11).text_color(t.dim).child(p.lang)))
          .child(this.tinyButton(`copy-${id}`, done ? "check" : "copy", done ? "Copied" : "Copy", (_e, cx) => this.copyOut(p.code, id, cx), t)));
    }));
  }

  entry(e, t, last) {
    if (e.kind === "user") {
      // A width of its own, from its longest line: with only a max width the text inside
      // shrinks to one letter per line when the pane narrows.
      const max = Math.max(120, Math.floor(Math.min(WIDTH, this.width - 36) * 0.8));
      const longest = Math.max(0, ...(e.text ?? "").split("\n").map((l) => l.length));
      const w = e.images.length ? max : Math.min(max, Math.ceil(longest * 7.6) + 32);
      const on = this.hovered === e.key && Boolean(e.text);
      return v_flex().id(`row-${e.key}`).w_full().items_end().gap(4).on_hover(this.hover(e.key))
        .child(v_flex().w(w).flex_none().gap(8).px(12).py(8).rounded(10).bg(t.raised)
          .when(e.images.length > 0, (el) => el.child(h_flex().flex_wrap().gap(6).children(e.images.map((i) => this.img(i.ref, t, 280, 200)))))
          .when(Boolean(e.text), (el) => el.child(this.markdown(e.key, e.text))))
        .child(h_flex().h(24).gap(4).when(on, (el) => el
          .child(this.tinyButton(`copyu-${e.key}`, this.copied === `u-${e.key}` ? "check" : "copy", "Copy", (_e, cx) => this.copyOut(e.text, `u-${e.key}`, cx), t))
          .when(Boolean(this.term), (el) => el.child(this.tinyButton(`edit-${e.key}`, "edit", "Edit and send again", (_e, cx) => { this.input.set_value(e.text); this.input.focus(); cx.notify(); }, t)))));
    }
    if (e.kind === "assistant") {
      const on = this.hovered === e.key && e.key !== "streaming";
      return v_flex().id(`row-${e.key}`).w_full().gap(4).on_hover(this.hover(e.key))
        .child(this.reply(e, t))
        .child(h_flex().h(20).gap(4).when(on, (el) => el
          .child(this.tinyButton(`copya-${e.key}`, this.copied === `a-${e.key}` ? "check" : "copy", "Copy reply", (_e, cx) => this.copyOut(e.text, `a-${e.key}`, cx), t))));
    }
    // What a slash command printed, as the terminal shows it.
    if (e.kind === "output" || e.kind === "card") {
      const text = e.kind === "card" ? `Context: ${e.used ?? "?"} of ${e.max ?? "?"} tokens (${e.pct ?? "?"}%)` : e.text;
      const lines = text.split("\n");
      const shown = lines.length > 40 ? [...lines.slice(0, 40), `… ${lines.length - 40} more lines`] : lines;
      const mono = settings().font_family;
      return div().w_full().px(12).py(8).rounded(8).bg(t.surface).text_size(11.5).text_color(t.muted)
        .when(Boolean(mono), (d) => d.font_family(mono))
        .child(this.markdown(`out-${e.key}`, "~~~~text\n" + shown.join("\n") + "\n~~~~"));
    }
    if (e.kind === "note") {
      const text = e.text.length > 400 ? e.text.slice(0, 400) + "…" : e.text;
      const note = h_flex().w_full().gap(10).items_center().text_size(11.5).text_color(t.dim)
        .child(div().flex_1().h(1).bg(t.border)).child(div().flex_none().child(text))
        .when(Boolean(e.summary), (el) => el.child(div().id(`sum-${e.key}`).flex_none().cursor_pointer().text_color(t.accent)
          .on_click((_e, cx) => { this.summaryOpen = this.summaryOpen === e.key ? null : e.key; cx.notify(); })
          .child(this.summaryOpen === e.key ? "Hide summary" : "Show summary")))
        .child(div().flex_1().h(1).bg(t.border));
      if (!e.summary || this.summaryOpen !== e.key) return note;
      return v_flex().w_full().gap(8).child(note).child(div().w_full().px(14).py(10).rounded(8).border_1()
        .border_color(t.border).bg(t.surface).text_size(12.5).child(this.markdown(`summary-${e.key}`, e.summary)));
    }
    return this.tools(e, t, last);
  }

  // A turn's tool calls: one call is its own row; several fold into "3 tool calls · Bash, Read"
  // that opens on click. Each row opens to its output, as the prototype draws them.
  tools(e, t, last) {
    const running = last && e.items.some((i) => i.result === null) && this.status() === "working";
    if (e.items.length === 1) return this.tool(e.key, 0, e.items[0], t, running);
    const open = this.open.has(e.key);
    const names = [...new Set(e.items.map((i) => i.name))];
    const failed = e.items.some((i) => i.error);
    const thumbs = e.items.flatMap((i) => i.images);
    return v_flex().w_full().gap(6)
      .child(h_flex().id(`tg-${e.key}`).gap(6).items_center().cursor_pointer().text_size(12).text_color(t.dim)
        .hover((s) => s.text_color(t.muted))
        .on_click((_ev, cx) => { open ? this.open.delete(e.key) : this.open.add(e.key); cx.notify(); })
        .child(div().w(10).flex_none().child(open ? "▾" : "▸"))
        .child(div().flex_1().min_w(0).truncate().child(`${e.items.length} tool calls · ${names.join(", ")}`))
        .when(running, (el) => el.child(div().flex_none().text_color(t.working).frames(SPINNER, 90)))
        .when(failed, (el) => el.child(div().flex_none().text_color(t.ansi1).child("error"))))
      .when(!open && thumbs.length > 0, (el) => el.child(h_flex().pl(16).gap(6).children(thumbs.map((i) => this.img(i.ref, t, 160, 110)))))
      .when(open, (el) => el.children(e.items.map((i, n) => this.tool(e.key, n, i, t, running && n === e.items.length - 1))));
  }

  tool(key, n, i, t, running) {
    const id = `${key}-t${n}`;
    const open = this.open.has(id);
    const mono = settings().font_family;
    const word = resultWord(i);
    const result = (i.result ?? "").split("\n");
    const clipped = result.length > 30 ? [...result.slice(0, 30), `… ${result.length - 30} more lines`] : result;
    return v_flex().id(`tool-${id}`).w_full().rounded(7).border_1().border_color(i.error ? t.ansi1 : t.border).overflow_hidden()
      .child(h_flex().id(`th-${id}`).w_full().gap(8).px(10).py(6).items_center().cursor_pointer().text_size(12.5)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { open ? this.open.delete(id) : this.open.add(id); cx.notify(); })
        .child(div().w(10).flex_none().text_color(t.dim).child(open ? "▾" : "›"))
        .child(div().flex_none().font_medium().text_color(t.foreground).when(Boolean(mono), (d) => d.font_family(mono)).child(i.name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).when(Boolean(mono), (d) => d.font_family(mono)).child(i.summary || " "))
        .child(running && i.result === null ? div().flex_none().text_color(t.working).frames(SPINNER, 90)
          : div().flex_none().text_size(11.5).text_color(i.error ? t.ansi1 : t.dim).child(word)))
      .when(!open && i.images.length > 0, (el) => el.child(h_flex().px(10).pb(6).gap(6).children(i.images.map((im) => this.img(im.ref, t, 160, 110)))))
      .when(open, (el) => el
        .when(i.images.length > 0, (el) => el.child(h_flex().px(10).py(6).flex_wrap().gap(6).children(i.images.map((im) => this.img(im.ref, t, 280, 200)))))
        .when(i.result !== null && i.result.trim() !== "", (el) => el.child(div().border_t(1).border_color(t.border).bg(t.surface).text_size(11.5)
          .child(this.markdown(`${id}-r`, "~~~~text\n" + clipped.join("\n") + "\n~~~~")))));
  }

  // The command or tool running now, with its output so far, as the terminal shows it.
  runningView(t) {
    const r = this.running;
    const mono = settings().font_family;
    const LINES = 6, LH = 17;
    const out = r.out.slice(-LINES);
    return v_flex().w_full().gap(6).px(12).py(9).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().h(20).gap(8).items_center()
        .child(div().flex_none().text_color(t.working).frames(SPINNER, 90))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().when(Boolean(mono), (d) => d.font_family(mono)).child(r.title))
        .when(Boolean(r.time), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(r.time))))
      .child(v_flex().h(LINES * LH + 12).px(10).py(6).rounded(6).bg(t.background).overflow_hidden().justify_end()
        .text_size(11.5).text_color(t.muted).when(Boolean(mono), (d) => d.font_family(mono))
        .children(out.map((l) => div().h(LH).flex_none().truncate().child(l || " "))));
  }

  queued(p, i, t) {
    const status = this.status();
    const waiting = (status === "working" || status === "blocked") && this.inQueue(p);
    const max = Math.max(120, Math.floor(Math.min(WIDTH, this.width - 36) * 0.8));
    const longest = Math.max(0, ...p.text.split("\n").map((l) => l.length));
    const w = Math.min(max, Math.max(200, Math.ceil(longest * 7.6) + 32));
    const act = (id, label, fn) => div().id(id).px(8).py(2).rounded(6).cursor_pointer().text_color(t.foreground)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { fn(); cx.notify(); }).child(label);
    return v_flex().id(`pending-${i}`).w_full().items_end().gap(4)
      .child(v_flex().w(w).flex_none().px(12).py(8).rounded(10).bg(t.raised).border_1().border_color(t.border).opacity(0.75)
        .child(this.markdown(`pending-${i}`, p.text)))
      .child(h_flex().gap(4).items_center().text_size(11.5).text_color(t.dim)
        .child(div().pr(4).child(waiting ? "Queued · the agent reads it at its next step" : "Sending…"))
        .when(waiting, (el) => el.child(act(`send-now-${i}`, "Send now", () => this.sendNow())).child(act(`edit-q-${i}`, "Edit", () => this.editQueued()))));
  }

  // The agent's question on its terminal, as a card: its text and its choices as buttons that
  // move the selection there and confirm. Without a menu, the screen itself and its keys.
  promptBox(t) {
    const form = this.idleAsk === "form";
    const q = form ? null : parsePrompt(this.screen);
    const key = (k, label) => this.button(`key-${k}`, label, () => hc(["keys", this.term, k]), t);
    const mono = settings().font_family;
    const lines = (this.screen ?? "").split("\n").filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()));
    const who = this.props?.who ?? "the agent";
    return v_flex().id("question").w_full().p(12).gap(8).rounded(9).border_1().border_color(t.blocked).bg(t.background)
      .child(h_flex().gap(8).items_center().text_size(11).font_semibold().text_color(t.blocked)
        .child(div().flex_1().child(`${who} asks you`.toUpperCase()))
        .child(this.button("q-terminal", "Show terminal", () => run("terminal.peek", { terminal: this.term }), t)))
      .when(Boolean(q?.question), (el) => el.child(div().text_size(13).font_semibold().child(this.markdown("q-text", q.question))))
      .when(Boolean(q), (el) => el.child(v_flex().gap(5).children(q.options.map((o, n) =>
        h_flex().id(`choice-${n}`).px(9).py(7).gap(8).rounded(6).cursor_pointer().border_1().items_start()
          .border_color(n === q.selected ? t.blocked : t.border).when(n === q.selected, (d) => d.bg(`${t.blocked}22`))
          .hover((s) => s.border_color(t.blocked))
          .on_click((_e, cx) => { hc(["keys", this.term, ...choose(q.selected, n)]); this.screen = this.idleAsk = null; cx.notify(); })
          .child(div().w(20).flex_none().text_size(11).text_color(t.dim).border_1().border_color(t.border).rounded(3).flex().justify_center().child(String(n + 1)))
          .child(div().flex_1().text_size(12.5).text_color(t.foreground).child(o))))))
      .when(!q && lines.length > 0, (el) => el.child(div().text_size(11.5).text_color(t.muted)
        .when(Boolean(mono), (d) => d.font_family(mono))
        .child(this.markdown("screen", "~~~~text\n" + lines.slice(-24).join("\n") + "\n~~~~"))))
      .child(h_flex().gap(6).flex_wrap().items_center()
        .when(!q, (el) => el.child(key("up", "↑")).child(key("down", "↓"))
          .when(form, (el) => el.child(key("left", "←")).child(key("right", "→")))
          .child(key("enter", "Enter")))
        .child(key("esc", "Esc"))
        .child(div().flex_1())
        .child(div().text_size(11.5).text_color(t.dim).child(q ? "Or type your own answer below." : "The keys go to its terminal.")));
  }

  // Your session: `factory chat <id>` opens your own session on the ticket (the chat then follows
  // it, since it's the ticket's terminal), `--close` ends it. The page reloads the sessions when
  // status.json's terminal changes.
  own(o, cx) {
    if (this.ownBusy) return;
    this.ownBusy = o.action;
    cx.notify();
    cx.spawn(async (cx) => {
      const c = cliCommand(CLI, root(), o.args);
      const r = await exec(c.command, c.args, { timeout: 30000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.ownBusy = null;
      if (r.code !== 0) notify({ title: o.action === "open" ? "Your session didn't start" : "Your session didn't close", body: (r.stderr || r.stdout || "").trim(), level: "error" });
      else this.picked = null; // follow the live session: yours once it's open
      cx.notify();
    });
  }

  // The chat's head: who, what it runs on, and the session switcher.
  header(t, sessions, session, target) {
    const own = ownChat(this.props?.ticket, sessions, this.props?.daemon !== false);
    const status = this.status();
    const dot = !target.terminal ? t.dim : status === "blocked" || this.idleAsk ? t.blocked : status === "working" ? t.working : t.done;
    const model = this.t?.model ? this.t.model.replace(/^claude-/, "") : null;
    const facts = [model, target.terminal ? MODES[this.t?.mode] : null, target.terminal ? `live in ${target.terminal}` : "read-only"].filter(Boolean).join(" · ");
    const icon = (id, name, tip, on, action) => div().id(id).flex_none().size(24).flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.hover))
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(action).child(svg(`${ICONS}/${name}.svg`).size(14));
    return v_flex().id("chat-head").flex_none().border_b(1).border_color(t.border)
      .child(h_flex().px(16).py(8).gap(10).items_center().flex_wrap()
        .child(div().size(8).flex_none().rounded_full().bg(dot))
        .child(div().flex_none().font_semibold().text_color(t.foreground).child(session?.agent ?? this.props?.who ?? "agent"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(facts))
        .child(h_flex().id("sessions").gap(4).flex_wrap().children(sessions.map((x) =>
          h_flex().id(`session-${x.id}`).gap(5).px(8).py(2).rounded(5).cursor_pointer().text_size(12).items_center()
            .bg(x.id === session?.id ? t.raised : t.background).text_color(x.id === session?.id ? t.foreground : t.muted)
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(x.id, cx))
            .when(x.live, (el) => el.child(div().size(6).rounded_full().bg(t.working)))
            .child(x.label))))
        .when(Boolean(own), (el) => el.child(div().id("own-session").flex_none().px(8).py(2).rounded(6).border_1().text_size(12)
          .border_color(own.action === "open" ? t.accent : t.border).text_color(own.action === "open" ? t.foreground : t.muted)
          .when(!this.ownBusy, (b) => b.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.own(own, cx)))
          .tooltip(own.tip)
          .child(this.ownBusy === "open" ? "Starting…" : this.ownBusy === "close" ? "Closing…" : own.label)))
        .child(icon("search", "search", `Search (${shortcut("F")})`, this.searching, (_e, cx) => (this.searching ? this.closeSearch(cx) : this.openSearch(cx))))
        .child(icon("side-toggle", "terminal", `Side chat (${shortcut(";")})`, this.side.open, (_e, cx) => { this.side.open = !this.side.open; (this.side.open ? this.sideInput : this.input).focus(); cx.notify(); }))
        .when(Boolean(this.props?.panel), (el) => el.child(this.panelToggle(t))))
      .when(Boolean(this.searching) && (this.shown(), true), (el) => el.child(h_flex().id("search-bar").key_context("FactoryChatSearch")
        .on_action("chat_search_close", (_e, cx) => this.closeSearch(cx))
        .h(38).px(16).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().child(Input.new(this.search).w_full().h(28).px(10).rounded(6).border_1().border_color(t.border).bg(t.background).text_size(12.5)))
        .child(div().flex_none().text_size(12).text_color(t.dim).child(this.search.value().trim() ? `${this.matches ?? 0} match${this.matches === 1 ? "" : "es"}` : ""))
        .child(div().id("search-close").flex_none().px(6).py(2).rounded(5).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.closeSearch(cx)).child("×"))));
  }

  // Changes: the Ticket page's Changes + ticket memory panel, open or closed (kept per viewer).
  panelToggle(t) {
    const { open, folded } = this.props.panel;
    return div().id("panel-toggle").flex_none().px(8).py(2).rounded(6).border_1().cursor_pointer().text_size(12)
      .border_color(open && !folded ? t.accent : t.border).text_color(open && !folded ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(folded ? `Folded away: the window is too narrow (${PANEL_HINT})` : `Changes and ticket memory (${PANEL_HINT})`)
      .on_click((_e, cx) => { setShared(PANEL_KEY, !open); cx.notify(); })
      .child("Changes");
  }

  body(t, sessions, session, target) {
    this.settle();
    const { start, ents } = this.shown();
    const shown = ents.slice(start);
    const side = Math.max(18, Math.round((this.width - WIDTH) / 2));
    const content = v_flex().id("content").absolute().left(0).right(0).bottom(-this.off).px(side).py(18).gap(12)
      .on_size_change((size, cx) => {
        // Scrolled up, what's on screen stays put whatever changes below it. Only "Show
        // earlier" adds above, and must not move it.
        if (this.off > 0 && this.contentH > 0 && !this.earlier) this.off += size.height - this.contentH;
        this.earlier = false;
        this.contentH = size.height;
        this.clamp();
        cx.notify();
      })
      .when(start > 0, (el) => el.child(h_flex().w_full().justify_center().child(
        div().id("earlier").px(10).py(4).rounded(8).cursor_pointer().bg(t.surface).text_size(12).text_color(t.muted)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.earlier = true; this.limit += PAGE; this.cacheShown(cx); cx.notify(); })
          .child(`Show earlier (${start})`))))
      .when(start === 0 && Boolean(this.truncated), (el) => el.child(h_flex().w_full().justify_center()
        .child(div().text_size(11.5).text_color(t.dim).child("Older history is in the log but not loaded"))))
      .children(shown.map((e, n) => this.entry(e, t, n === shown.length - 1)))
      .when(Boolean(this.streamShown()), (el) => el.child(this.entry({ kind: "assistant", text: this.streamShown(), key: "streaming" }, t, true)))
      .when(Boolean(this.running), (el) => el.child(this.runningView(t)))
      .children(this.pending.map((p, i) => this.queued(p, i, t)));

    const scroll = div().id("scroll").relative().flex_1().min_h(0).overflow_hidden()
      .on_size_change((size, cx) => { this.viewH = size.height; this.width = size.width; this.clamp(); cx.notify(); })
      .on_scroll_wheel((e, cx) => { this.off += e.delta.y; this.clamp(); cx.notify(); })
      .child(content);
    const max = this.contentH - this.viewH;
    if (max > 4 && this.viewH > 0) {
      const thumb = Math.max(24, this.viewH * this.viewH / this.contentH);
      const top = (1 - this.off / max) * (this.viewH - thumb);
      scroll.child(div().absolute().right(3).top(top).w(4).h(thumb).rounded(2).bg(t.border));
    }
    if (this.off > 40) {
      scroll.child(div().id("latest").absolute().bottom(12).right(16).px(10).py(5).rounded(12).cursor_pointer()
        .bg(t.popover).border_1().border_color(t.border).text_size(12).text_color(t.foreground)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.off = 0; cx.notify(); }).child("↓ Latest"));
    }
    if (!this.t?.entries.length) {
      const msg = this.error ?? (this.t ? "Nothing in this session yet." : chatEmpty(session, sessions, target));
      scroll.child(v_flex().id("chat-empty").absolute().inset_0().items_center().justify_center().p(24).child(div().text_color(t.dim).child(msg)));
    }
    return scroll;
  }

  // The composer: one card with the box on top and the session's facts under it. Read-only (no
  // agent running, or an earlier session), it says why and how to reach the agent instead.
  footer(t, target) {
    const status = this.status();
    const working = status === "working";
    const typed = Boolean(this.input.value().trim());
    const stop = working && !typed;
    const ctx = this.t?.context?.window ? Math.round((100 * this.t.context.used) / this.t.context.window) : null;
    const pill = (text) => div().flex_none().px(8).py(1).rounded_full().border_1().border_color(t.border).text_size(11.5).text_color(t.muted).child(text);
    const center = (el) => h_flex().w_full().justify_center().child(div().w_full().max_w(WIDTH).child(el));
    const foot = v_flex().id("composer-area").flex_none().px(16).pt(10).pb(12).gap(8).border_t(1).border_color(t.border);
    if (!target.terminal) {
      return foot.child(center(v_flex().id("composer").w_full().px(12).py(10).gap(4).rounded(10).border_1().border_color(t.border).bg(t.surface)
        .child(div().id("composer-disabled").text_size(12.5).text_color(t.muted).child(target.note ?? "Read-only."))
        .child(div().text_size(11.5).text_color(t.dim).child("The transcript is shown as the agent logged it; the box is off."))));
    }
    const card = v_flex().id("composer").w_full().rounded(10).border_1().border_color(this.inputFocused ? t.accent : t.border).bg(t.background)
      .child(Textarea.new(this.input).w_full().px(12).pt(10).pb(4).border_0().bg(t.background).text_size(13.5).text_color(t.foreground))
      .child(h_flex().px(10).pb(8).gap(6).items_center()
        .when(Boolean(MODES[this.t?.mode]), (el) => el.child(pill(MODES[this.t.mode])))
        .when(Boolean(this.t?.model), (el) => el.child(pill(this.t.model.replace(/^claude-/, ""))))
        .child(div().flex_1())
        .when(ctx != null, (el) => el.child(h_flex().id("ctx").gap(6).items_center().text_size(11.5).text_color(t.muted).tooltip("Context used")
          .child("ctx").child(div().w(60).h(4).rounded(2).bg(t.border).overflow_hidden().child(div().h_full().bg(ctx >= 80 ? t.blocked : t.accent).w(`${Math.min(100, ctx)}%`)))
          .child(`${ctx}%`)))
        .child(div().id("send").flex_none().px(12).py(5).rounded(6).cursor_pointer().text_size(12.5).font_medium()
          .bg(stop ? t.background : t.accent).text_color(stop ? t.foreground : t.background).border_1().border_color(stop ? t.border : t.accent)
          .hover((s) => s.opacity(0.85)).tooltip(stop ? "Interrupt the agent" : "Send")
          .on_click((_e, cx) => (stop ? hc(["interrupt", this.term]) : this.send(cx)))
          .child(stop ? "■ Stop" : "Send ↵")));
    return foot
      .when(working, (el) => el.child(center(h_flex().px(4).gap(8).items_center().text_size(12).text_color(t.muted)
        .child(div().flex_none().text_color(t.working).frames(SPINNER, 90))
        .child(div().flex_1().min_w(0).truncate().child(this.terminal()?.report?.msg || "Working…")))))
      .when(status === "blocked" || Boolean(this.idleAsk), (el) => el.child(center(this.promptBox(t))))
      .when(Boolean(this.error), (el) => el.child(center(div().px(4).text_size(11.5).text_color(t.blocked).child(this.error))))
      .child(center(card))
      .child(center(div().text_size(11.5).text_color(t.dim)
        .child(`Enter sends · Shift+Enter new line · ${shortcut("F")} search · ${shortcut(";")} side chat · typed into ${target.terminal}: the same as typing there`)));
  }

  sidePane(t) {
    const S = this.side;
    const w = Math.round(Math.min(420, Math.max(300, (this.width + 360) * 0.36)));
    const bubble = (x, i) => v_flex().gap(8)
      .child(h_flex().w_full().justify_end().child(div().max_w(w - 70).px(12).py(8).rounded(10).bg(t.raised).text_size(12.5).child(x.q)))
      .child(x.pending
        ? h_flex().gap(8).items_center().text_size(12).text_color(t.muted).child(div().text_color(t.working).frames(SPINNER, 90)).child("Thinking…")
        : x.error ? div().text_size(12).text_color(t.blocked).child(x.error)
        : div().text_size(12.5).child(this.markdown(`side-${i}`, x.a)));
    const content = v_flex().id("side-content").absolute().left(0).right(0).bottom(-S.off).px(14).py(14).gap(18)
      .on_size_change((size, cx) => { S.contentH = size.height; S.off = Math.max(0, Math.min(S.off, S.contentH - S.viewH)); cx.notify(); })
      .when(S.items.length === 0, (el) => el.child(v_flex().gap(6).py(20).items_center().text_size(12).text_color(t.dim)
        .child("Ask a quick question about this conversation.")
        .child("The agent keeps working; nothing here is added to its chat.")))
      .children(S.items.map(bubble));
    return v_flex().id("side").flex_none().w(w).h_full().border_l(1).border_color(t.border).bg(t.background)
      .child(h_flex().h(34).px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(div().font_semibold().child("Side chat"))
        .child(div().flex_1().text_color(t.dim).child(shortcut(";")))
        .when(S.items.length > 0, (el) => el.child(div().id("side-clear").px(6).py(2).rounded(5).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { S.items = []; S.off = 0; cx.notify(); }).child("Clear")))
        .child(div().id("side-close").px(6).py(2).rounded(5).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { S.open = false; this.input.focus(); cx.notify(); }).child("×")))
      .child(div().id("side-scroll").relative().flex_1().min_h(0).overflow_hidden()
        .on_size_change((size, cx) => { S.viewH = size.height; cx.notify(); })
        .on_scroll_wheel((e, cx) => { S.off = Math.max(0, Math.min(S.off + e.delta.y, S.contentH - S.viewH)); cx.notify(); })
        .child(content))
      .child(div().p(10).child(v_flex().rounded(10).border_1().border_color(t.border).bg(t.background)
        .child(Textarea.new(this.sideInput).w_full().px(12).py(9).border_0().bg(t.background).text_size(12.5).text_color(t.foreground))));
  }

  render(cx) {
    const t = theme();
    const { sessions, session, target } = this.view();
    this.follow(cx);
    // The 2-second check stops with a reload of the mod; start it again.
    if (cx && !checking() && target.terminal && Date.now() - (this.checked ?? 0) > 10000) {
      this.checked = Date.now();
      try { this.checkTimer?.cancel(); } catch {}
      this.checkTimer = cx.timer.every(2000, (cx) => this.check(cx));
    }
    return v_flex().id("factory-chat").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .key_context("FactoryChat")
      .on_action("chat_search", (_e, cx) => (this.searching ? this.closeSearch(cx) : this.openSearch(cx)))
      .on_action("chat_side_toggle", (_e, cx) => { this.side.open = !this.side.open; (this.side.open ? this.sideInput : this.input).focus(); cx.notify(); })
      .child(this.header(t, sessions, session, target))
      .child(h_flex().flex_1().min_h(0)
        .child(v_flex().flex_1().min_w(0).h_full().child(this.body(t, sessions, session, target)).child(this.footer(t, target)))
        .when(this.side.open, (el) => el.child(this.sidePane(t))));
  }
}
