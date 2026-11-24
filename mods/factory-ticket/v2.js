// The V2 Ticket page (docs/prototypes/ticket-v2), drawn when the V2_UI gate is on (v2UI in
// lib/model.js). Left: what the ticket is and where it stands. Right: what its agent is doing
// now, its live terminal or the question it waits on, the files it changed and its journal.
// main.js keeps the files and the tab; this keeps the live parts (the terminal's tail, the
// diff, the ready rules), the answer box, and the Memory tab (the digest, its edit, the search).
import { div } from "gpui-kit";
import { h_flex, v_flex, TextView, InputState, Input, EditorState, Editor } from "gpui-base";
import { theme, exec, hc, notify, checking } from "herdr";
import { parseStatusMd, repoBadge, prLinks, prColor, watchNote, crossRepoCards, sharedLinks, questionCards } from "./lib/model.js";
import { root, state, peekAgent, act, ask } from "./lib/store.js";
import { keyAction } from "./lib/keys.js";
import { cliCommand, answerResumeAsk, dropAsk, talkable } from "./lib/actions.js";
import { V2_TABS, ticketKind, waitsOnYou, stageStrip, chips, askShort, askSource, slices, checks, checkCount, readyRules, readyCount,
  diffFiles, cut, activity, agentLine, tokenBar, tail, terminalQuestion, answerKeys, buttons, pageKey,
  mdSections, digestView, hitRows, memoryKey, rebuildAsk } from "./lib/ticketv2.js";
import CLI from "./lib/cli.js"; // written by scripts/sync.sh

const TAIL_MS = 2000; // the live terminal's tail, while it shows
const CLI_MS = 20000; // the diff and the ready rules, at most this often per ticket

export class TicketV2 {
  constructor() {
    this.pick = null; // the option picked in the question card
    this.text = "";
    this.typing = false;
    this.lines = null; // the live terminal's last lines, or null before the first read
    this.diff = null; // { files, add, del, text } | { error }
    this.rules = null;
    this.live = null; // what the tail loop reads: { id, terminal } while a terminal shows
    this.loaded = {}; // ticket id → when the diff and rules were last read
    this.memory = null; // { id, key, digest } once `factory digest --json` answers, or { id, key, error }
    this.hits = null; // { id, query, rows } | { id, query, error } | { id, query, busy }
    this.query = "";
    this.editing = null; // the ticket whose digest is open in the editor
    this.busy = null; // "save" | "rebuild" while the CLI runs
  }

  // What the page's keys skip while you type: the answer box, the search box or the digest editor.
  focus(where, on) { this.typing = on ? where : this.typing === where ? false : this.typing; }

  // From the page's init: an InputState needs a live host call, so it can't wait for render.
  init() {
    this.input = InputState.new({ placeholder: "Or type your own answer…" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("focus", () => this.focus("answer", true));
    this.input.on("blur", () => this.focus("answer", false));
    this.input.on("submit", (_e, cx) => this.send(cx));
    this.search = InputState.new({ placeholder: "Search this ticket's journal and transcripts…" });
    this.search.on("change", () => { this.query = this.search.value(); });
    this.search.on("focus", () => this.focus("search", true));
    this.search.on("blur", () => this.focus("search", false));
    this.search.on("submit", (_e, cx) => this.recall(cx));
    this.editor = EditorState.new({ language: "markdown", soft_wrap: true, line_numbers: false, folding: false });
    this.editor.on("focus", () => this.focus("editor", true));
    this.editor.on("blur", () => this.focus("editor", false));
  }

  // The factory CLI on the shown folder. `stdin`: text piped to it (sh's printf: exec has no stdin).
  cli(args, o = {}) {
    const c = cliCommand(CLI, root(), args);
    const run = o.stdin == null ? exec(c.command, c.args, { timeout: o.timeout ?? 30000 })
      : exec("sh", ["-c", 't=$1; shift; printf "%s" "$t" | "$@"', "factory-digest", o.stdin, c.command, ...c.args], { timeout: o.timeout ?? 30000 });
    return run.catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
  }
  static why(r) { return String(r.stderr || r.stdout || "").replace(/^factory: /, "").trim().split("\n")[0].slice(0, 300); }

  // The Memory tab's digest: `factory digest <id> --json`, again whenever the ticket's journal grows.
  loadMemory(ticket, cx) {
    const key = memoryKey(ticket);
    if (this.memoryKey === key) return;
    this.memoryKey = key;
    if (this.memory?.id !== ticket.id) { this.memory = null; this.hits = null; this.editing = null; }
    cx.spawn(async (cx) => {
      const r = await this.cli(["digest", String(ticket.id), "--json"]);
      if (this.memoryKey !== key) return;
      let digest;
      try { digest = r.code === 0 ? JSON.parse(r.stdout.trim().split("\n").at(-1)) : undefined; } catch {}
      this.memory = digest === undefined ? { id: ticket.id, key, error: `Couldn't read the digest: ${TicketV2.why(r) || "no answer"}` } : { id: ticket.id, key, digest };
      cx.notify();
    });
  }

  // The search box: `factory recall <id> "words" --json`, best match first. `drawing`: called from
  // render (a smoke run's seed), which is drawing already and mustn't ask for another frame.
  recall(cx, drawing = false) {
    const ticket = this.ticket;
    const query = (this.search?.value?.() ?? this.query).trim();
    if (!ticket || !query) return;
    if (state().status?.source !== "daemon") return notify({ title: "This is sample data", body: "Start a factory (factory init) to search a ticket's history.", level: "info", timeout: 3500 });
    this.hits = { id: ticket.id, query, busy: true };
    if (!drawing) cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.cli(["recall", String(ticket.id), query, "--json", "--limit", "20"]);
      if (this.hits?.query !== query || this.hits?.id !== ticket.id) return;
      let rows = null;
      try { rows = r.code === 0 ? JSON.parse(r.stdout.trim().split("\n").at(-1)) : null; } catch {}
      this.hits = rows ? { id: ticket.id, query, rows } : { id: ticket.id, query, error: `Search failed: ${TicketV2.why(r) || "no answer"}` };
      cx.notify();
    });
  }

  // A hit's click: its transcript or file in the system's text editor (no line: Herdr's open takes
  // none, so the row names it), a PR or issue on GitHub, or the tab it belongs to.
  openHit(h, page, cx) {
    const to = h.target;
    if (!to) return;
    if (to.open === "tab") { page.tab = to.tab; cx.notify(); return; }
    cx.spawn(async () => {
      const r = await exec("open", to.open === "file" ? ["-t", to.path] : [to.url]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code) notify({ title: `Couldn't open ${to.label}`, body: TicketV2.why(r), level: "error" });
      else if (to.line) notify({ title: `Opened the transcript`, body: `The hit is on line ${to.line}.`, level: "info", timeout: 3000 });
    });
  }

  edit(cx, drawing = false) {
    const d = this.memory?.digest;
    this.editing = this.ticket.id;
    this.editor.set_value(d?.text ?? "## Decisions and why\n- none\n## The person's answers\n- none\n## Tried and failed\n- none\n## Open questions\n- none\n## Current state\n- none\n");
    this.editor.focus?.();
    if (!drawing) cx.notify();
  }

  // Save: your text goes to `factory digest <id> --set -`, which stores it as yours, rewrites
  // TICKET-MEMORY.md and journals the edit.
  save(cx) {
    const ticket = this.ticket;
    const text = this.editor.value();
    if (this.busy || !text.trim()) return;
    this.busy = "save";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.cli(["digest", String(ticket.id), "--set", "-", "--json"], { stdin: text });
      this.busy = null;
      if (r.code) notify({ title: "The digest wasn't saved", body: TicketV2.why(r), level: "error" });
      else { notify({ title: `#${ticket.id}'s digest saved`, body: "Later rewrites keep your corrections.", level: "success", timeout: 3000 }); this.editing = null; this.memoryKey = null; }
      cx.notify();
    });
  }

  // Rebuild: Haiku writes it again now. A digest you edited asks first.
  rebuild(cx) {
    const ticket = this.ticket;
    if (this.busy) return;
    const d = this.memory?.digest;
    if (d?.edited && d.from === ticket.id) return ask(rebuildAsk(ticket));
    this.busy = "rebuild";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.cli(["digest", String(ticket.id), "--rebuild", "--json"], { timeout: 180000 });
      this.busy = null;
      if (r.code) notify({ title: "The digest wasn't rebuilt", body: TicketV2.why(r), level: "error" });
      else notify({ title: `#${ticket.id}'s digest rebuilt`, level: "success", timeout: 3000 });
      this.memoryKey = null;
      cx.notify();
    });
  }

  // The tail loop starts on the first V2 render, since the gate can turn on while the page is open.
  start(cx) {
    if (this.started || checking()) return;
    this.started = true;
    cx.spawn(async (cx) => {
      for (;;) {
        const live = this.live;
        if (live) {
          const r = await hc(["read", live.terminal]).catch(() => null);
          const lines = r?.code === 0 ? tail(r.stdout, 40) : null;
          if (this.live === live && JSON.stringify(lines) !== JSON.stringify(this.lines)) { this.lines = lines; cx.notify(); }
        }
        await new Promise((done) => cx.timer.after(TAIL_MS, done));
      }
    });
  }

  // The diff (files changed) and, on a ready ticket, the ready rules: the CLI on the shown folder.
  loadCli(ticket, kind, cx) {
    const key = `${ticket.id}:${ticket.state}`;
    const last = this.loaded[key];
    if (last && Date.now() - last < CLI_MS) return;
    this.loaded = { [key]: Date.now() };
    if (this.diffFor !== ticket.id) { this.diff = null; this.rules = null; this.diffFor = ticket.id; }
    cx.spawn(async (cx) => {
      const run = (args) => this.cli(args);
      if (!["grooming", "queued"].includes(ticket.state)) {
        const r = await run(["diff", String(ticket.id)]);
        this.diff = r.code === 0 ? diffFiles(r.stdout) : { error: `No diff: ${cut((r.stderr || r.stdout || "").replace(/^factory: /, "").trim().split("\n")[0], 90)}` };
      }
      if (kind === "ready") {
        const r = await run(["ready", String(ticket.id)]);
        this.rules = r.code === 0 ? readyRules(r.stdout) : null;
      }
      if (this.diffFor === ticket.id) cx.notify();
    });
  }

  // Send: in the asks state the answer is typed into the live terminal (the option's number, or
  // your words), which then opens as "Answer in terminal" does. Parked, it goes to the answer
  // dialog (factory answer), prefilled, to confirm before the stage restarts.
  send(cx) {
    const ticket = this.ticket;
    if (!ticket) return;
    const kind = ticketKind(ticket);
    if (kind === "parked") return ask(answerResumeAsk(ticket, this.text));
    if (kind !== "asks") return;
    if (state().status?.source !== "daemon") return notify({ title: "This is sample data", body: "Start a factory (factory init) to answer an agent.", level: "info", timeout: 3500 });
    const steps = answerKeys(ticket.terminal, terminalQuestion(this.lines ?? []), this.pick, this.text);
    if (!steps.length) return notify({ title: "Pick an option or type an answer", level: "info", timeout: 2500 });
    cx.spawn(async (cx) => {
      for (const args of steps) {
        const r = await hc(args).catch((e) => ({ code: 1, stderr: String(e) }));
        if (r.code !== 0) { notify({ title: `Couldn't type into ${ticket.terminal}`, body: String(r.stderr || r.stdout || "").trim().slice(0, 300), level: "error" }); break; }
      }
      this.pick = null;
      this.text = "";
      this.input?.set_value?.("");
      peekAgent(ticket);
      cx.notify();
    });
  }

  // A click or key on this page: the shared actions, plus the two only this page has.
  act(a, ticket, s) {
    if (a.kind === "drop") return ask(dropAsk(ticket));
    if (a.kind === "github") {
      const url = prLinks(ticket, s.factory.repo).find((l) => l.url)?.url;
      return url ? exec("open", [url]) : notify({ title: `#${ticket.id} has no PR yet`, level: "info", timeout: 2500 });
    }
    return act(a, ticket);
  }

  render(page, ticket, s, cx) {
    const t = theme();
    const now = Date.now();
    this.start(cx);
    this.ticket = ticket;
    const kind = ticketKind(ticket);
    // A ticket opens on the tab its state is about: the PR when it's ready, the questions when it waits on you.
    if (this.opened !== ticket.id) { this.opened = ticket.id; page.tab = kind === "ready" ? "4" : waitsOnYou(kind) ? "3" : "1"; }
    const daemon = s.source === "daemon";
    const showTail = daemon && ticket.terminal && (kind === "working" || kind === "asks");
    const live = showTail ? { id: ticket.id, terminal: ticket.terminal } : null;
    if (live?.terminal !== this.live?.terminal) { this.live = live; this.lines = null; this.pick = null; }
    if (daemon && !checking()) this.loadCli(ticket, kind, cx);

    const files = page.files;
    const { stages } = parseStatusMd(files["STATUS.md"]);
    const tone = (k) => ({ ok: t.done, bad: t.ansi1, warn: t.blocked, ask: t.blocked, accent: t.accent, working: t.working, dim: t.dim, rule: t.foreground })[k] ?? t.muted;
    const askC = t.blocked;
    const label = (text, right) => h_flex().gap(8).items_center().text_size(11).text_color(t.dim)
      .child(div().flex_1().child(text.toUpperCase())).when(Boolean(right), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(right)));
    const empty = (text) => div().px(10).py(8).text_color(t.dim).child(text);
    const md = (name) => (files[name] ? TextView.markdown(`md-v2-${ticket.id}-${name}`, files[name]) : null);
    // Markdown with its headings drawn as the page's small section labels, not as document titles.
    const sections = (key, text) => mdSections(text).map((sec, i) => v_flex().id(`${key}-${i}`).gap(2).pt(i ? 6 : 0)
      .when(Boolean(sec.heading), (el) => el.child(div().text_size(12).font_semibold().text_color(t.muted).child(sec.heading)))
      .child(TextView.markdown(`${key}-${ticket.id}-${i}`, sec.body)));
    const pill = (id, text, onClick, tone) => h_flex().id(id).flex_none().px(9).py(4).rounded(6).border(1).text_size(12).cursor_pointer()
      .border_color(tone === "primary" ? t.accent : tone === "warn" ? t.blocked : t.border).text_color(tone === "primary" ? t.accent : tone === "warn" ? t.blocked : t.foreground)
      .bg(t.background).hover((st) => st.border_color(t.accent)).on_click((_e, cx) => onClick(cx)).child(text);

    // ── left ──────────────────────────────────────────────────────────────
    const chipEl = (c) => h_flex().id(`chip-${c.id}`).gap(4).px(8).py(2).rounded(5).border(1).text_size(11.5)
      .border_color(c.tone === "warn" ? t.blocked : t.border).text_color(c.tone === "warn" ? t.blocked : t.muted)
      .when(Boolean(c.url), (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click(() => exec("open", [c.url])))
      .when(Boolean(c.label), (el) => el.child(div().child(c.label)))
      .child(div().text_color(c.tone === "warn" ? t.blocked : t.foreground).child(c.value));
    const strip = stageStrip(stages, ticket, kind);
    const stripEl = strip.length > 0 && h_flex().id("strip").rounded(8).border(1).border_color(t.border).overflow_hidden()
      .children(strip.map((st, i) => {
        const c = st.state === "now" ? (st.asks ? askC : t.accent) : st.state === "done" ? t.foreground : t.dim;
        // The stage in hand takes the room its name needs; the others share what's left.
        return v_flex().id(`st-${i}`).when(st.state === "now", (el) => el.flex_none().max_w(200)).when(st.state !== "now", (el) => el.flex_1().min_w_0()).px(10).py(7).gap(1).when(i > 0, (el) => el.border_l(1).border_color(t.border))
          .when(st.state === "now", (el) => el.bg(st.asks ? `${askC}22` : `${t.accent}1f`))
          .child(h_flex().gap(6).items_center().min_w_0()
            .when(st.state === "done", (el) => el.child(div().flex_none().text_color(t.done).child("✓")))
            .when(st.pulse, (el) => el.child(div().size(7).flex_none().rounded_full().bg(c).loop("opacity", { from: 1, to: 0.3, period: 1400 })))
            .child(div().truncate().text_size(12.5).font_semibold().text_color(c).child(st.name)))
          .child(div().truncate().text_size(11.5).text_color(t.muted).child(st.sub || " "));
      }));

    const sl = slices(files["SLICES.md"], ticket, kind);
    const ck = checks(files["EVIDENCE.md"]);
    const waiting = questionCards(ticket);
    const prs = prLinks(ticket, s.factory.repo);
    const counts = {
      plan: sl.length ? `${sl.filter((x) => x.state === "done").length} of ${sl.length}` : "",
      checks: checkCount(ck), questions: waiting.length ? String(waiting.length) : kind === "asks" ? "1" : "",
      pr: prs.length > 1 ? String(prs.length) : prs[0]?.text ?? "", ask: "",
    };
    const tab = V2_TABS.find((x) => x.key === page.tab) ?? V2_TABS[0];
    if (daemon && tab.id === "memory" && !checking()) {
      this.loadMemory(ticket, cx);
      // A smoke run's props (main.js): a search to run, or the editor to open once the digest is read.
      if (this.seed?.search) { this.search.set_value?.(this.seed.search); this.query = this.seed.search; this.seed.search = null; this.recall(cx, true); }
      if (this.seed?.edit && this.memory?.id === ticket.id && !this.memory.error) { this.seed.edit = false; this.edit(cx, true); }
    }
    const mark = (state) => ({ done: ["✓", t.done], now: ["●", kind === "asks" || kind === "parked" ? askC : t.accent], next: ["○", t.dim] })[state];
    const row = (id, [m, c], title, note, right) => h_flex().id(id).gap(10).px(10).py(7).rounded(7).items_start().hover((st) => st.bg(t.hover))
      .child(div().w(14).flex_none().text_color(c).child(m))
      .child(v_flex().flex_1().min_w_0().gap(1).child(div().text_color(t.foreground).child(title))
        .when(Boolean(note), (el) => el.child(div().text_size(12).text_color(t.muted).child(note))))
      .when(Boolean(right), (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(right)));
    const RESULT = { pass: ["✓", t.done], fail: ["✗", t.ansi1], broken: ["⚠", t.blocked], pending: ["○", t.dim] };
    const panes = {
      plan: () => sl.length
        ? [...sl.map((x) => row(`slice-${x.n}`, mark(x.state), x.title, x.note, x.state === "done" ? "done" : x.state === "now" ? "now" : "—")),
          div().px(10).text_size(12).text_color(t.dim).child("From SLICES.md, the plan agent's.")]
        : [empty(files["SLICES.md"] ? "SLICES.md lists no slices." : "No plan yet. The plan stage writes SLICES.md.")],
      checks: () => ck.length ? ck.map((c, i) => row(`check-${i}`, RESULT[c.result], c.name, c.detail, c.when)) : [empty("No checks have run yet.")],
      questions: () => [
        ...(kind === "asks" ? [row("q-live", ["?", askC], terminalQuestion(this.lines ?? [])?.question || ticket.needs?.text || "Its agent asks you in its terminal.", "Waiting on you, in the live terminal", null)] : []),
        ...waiting.map((q) => row(`q-${q.label}`, ["?", askC], q.text, `Waiting on you · ${q.who}`, q.label)),
        ...(files["GATES.md"] ? [div().pt(6).px(10).child(label("Answered and decided")), v_flex().id("gates").px(10).gap(2).children(sections("gates", files["GATES.md"]))]
          : !waiting.length && kind !== "asks" ? [empty("No questions yet.")] : []),
      ],
      pr: () => {
        const cards = crossRepoCards(ticket);
        const watch = watchNote(ticket, now);
        return [
          ...(prs.length ? prs.map((l) => h_flex().id(`pr-${l.slug}`).gap(10).px(10).py(7).rounded(7).items_center()
            .when(Boolean(l.url), (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click(() => exec("open", [l.url])))
            .child(div().w(14).flex_none().text_color(prColor(t, l.state)).child(l.state === "merged" ? "✓" : "↗"))
            .child(div().flex_1().min_w_0().truncate().text_color(t.foreground).child(`${l.text} ${ticket.title}`))
            .child(div().text_size(12).text_color(prColor(t, l.state)).child(l.word))
            .when(Boolean(l.url), (el) => el.child(div().text_size(12).text_color(t.accent).child("open ↗"))))
            : [empty(ticket.state === "merged" || ticket.state === "closed" ? "No PR." : "No PR yet. It opens once the ready rules pass.")]),
          ...(watch ? [div().px(10).text_size(12).text_color(t.muted).child(watch)] : []),
          ...(cards ? [div().px(10).text_size(12).text_color(t.muted).child(cards.map((c) => `${c.slug} (${c.role}): ${c.pr} · ${c.order}`).join("   "))] : []),
          ...(files["PR.md"] ? [div().px(10).pt(4).child(md("PR.md"))] : []),
        ];
      },
      ask: () => {
        const src = askSource(ticket, s.factory.repo, files);
        return [
          v_flex().px(4).gap(6)
            .child(div().text_color(t.foreground).child(ticket.title))
            .child(h_flex().gap(6).items_center().text_size(12).text_color(t.dim).child(`Source: ${src.line}`)
              .when(Boolean(src.url), (el) => el.child(div().id("ask-source").text_color(t.accent).cursor_pointer().on_click(() => exec("open", [src.url])).child("open ↗")))),
          ...(files["GROOMING.md"] ? [div().pt(4).px(4).child(label("What triage made of it")), div().px(4).child(md("GROOMING.md"))] : []),
          ...(files["INTENT.md"] ? [div().pt(4).px(4).child(label("The spec (INTENT.md)")), div().px(4).child(md("INTENT.md"))] : []),
          ...(!files["GROOMING.md"] && !files["INTENT.md"] ? [empty("Nothing beyond the title yet: triage writes GROOMING.md, the spec stage INTENT.md.")] : []),
        ];
      },
      memory: () => {
        if (!daemon) return [empty("Sample data: a real ticket's digest shows here, with its search, Edit and Rebuild.")];
        const m = this.memory?.id === ticket.id ? this.memory : null;
        const v = m && !m.error ? digestView(m.digest, ticket.id, now) : null;
        const editing = this.editing === ticket.id;
        const h = this.hits?.id === ticket.id ? this.hits : null;
        const rows = h?.rows ? hitRows(h.rows, s.factory.repo, now) : [];
        const searchEl = h_flex().id("memory-search").gap(8).px(4).items_center()
          .child(div().id("search-box").flex_1().min_w_0().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .child(Input.new(this.search).w_full().h(30).px(9).rounded(6).border(1).border_color(t.border).bg(t.background).text_size(12.5).text_color(t.foreground)))
          .child(pill("search-go", "Search", (cx) => this.recall(cx)))
          .when(Boolean(h), (el) => el.child(pill("search-clear", "Clear", (cx) => { this.hits = null; this.search.set_value?.(""); this.query = ""; cx.notify(); })));
        const hitEl = (r) => h_flex().id(r.id).gap(8).px(6).py(5).rounded(6).items_start().text_size(12)
          .when(Boolean(r.target), (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.openHit(r, page, cx)))
          .child(div().w(14).flex_none().text_color(r.source === "transcript" ? t.accent : t.dim).child(r.mark))
          .child(div().w(70).flex_none().truncate().text_color(t.muted).child(r.who))
          .child(v_flex().flex_1().min_w_0().gap(1).child(div().text_color(t.foreground).child(r.snippet))
            .when(Boolean(r.where), (el) => el.child(div().text_size(11.5).text_color(r.target ? t.accent : t.dim).child(r.where))))
          .child(div().w(44).flex_none().text_right().text_color(t.dim).child(r.time));
        const hitsEl = !h ? [] : h.busy ? [empty(`Searching for "${h.query}"…`)] : h.error ? [empty(h.error)]
          : !rows.length ? [empty(`Nothing in #${ticket.id}'s journal or transcripts matches "${h.query}".`)]
          : [div().px(4).pt(2).child(label(`${rows.length} match${rows.length > 1 ? "es" : ""} for "${h.query}"`)), v_flex().id("hits").gap(1).children(rows.map(hitEl))];
        const head = h_flex().id("digest-head").gap(6).px(4).pt(10).items_center()
          .child(div().flex_1().min_w_0().child(label(v?.state === "inherited" ? `Digest · #${m.digest.from}'s` : "Digest", v?.age)))
          .children(editing ? [pill("digest-save", this.busy === "save" ? "Saving…" : "Save", (cx) => this.save(cx), "primary"), pill("digest-cancel", "Cancel", (cx) => { this.editing = null; cx.notify(); })]
            : [pill("digest-edit", "Edit", (cx) => this.edit(cx)), pill("digest-rebuild", this.busy === "rebuild" ? "Rebuilding…" : "Rebuild", (cx) => this.rebuild(cx), v?.edited ? "warn" : null)]);
        const notes = (v?.notes ?? []).map((n, i) => div().id(`digest-note-${i}`).px(4).text_size(12).text_color(i === 0 && v.state === "inherited" ? t.blocked : t.muted).child(n));
        const body = editing
          ? [v_flex().id("digest-editor").mx(4).h(340).rounded(6).border(1).border_color(t.accent).bg(t.background).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(Editor.new(this.editor).size_full()),
            div().px(4).text_size(11.5).text_color(t.dim).child("Fix what's wrong, delete what isn't true. Saved as yours: every rewrite after keeps your corrections and leaves out what you removed.")]
          : !m ? [empty("Reading the digest…")] : m.error ? [empty(m.error)]
          : v.state === "none" ? [] : [v_flex().id("digest").px(4).gap(2).children(sections("digest", v.text))];
        return [searchEl, ...hitsEl, head, ...notes, ...body];
      },
    };
    const links = sharedLinks(ticket);
    const short = askShort(files);
    const left = v_flex().id("ticket-left").flex_1().min_w_0().h_full().px(22).py(18).gap(14).overflow_y_scroll()
      // At most two lines: the title's box is two lines tall and cuts the rest.
      .child(div().id("title").max_h(46).overflow_hidden().text_size(17).font_semibold().text_color(t.foreground)
        .child(h_flex().gap(6).flex_wrap().child(div().text_color(t.dim).child(`#${ticket.id}`)).child(ticket.title)))
      .child(h_flex().id("chips").gap(6).flex_wrap().children([...chips(ticket, s.factory.repo, files, now), ...(repoBadge(s, ticket) ? [{ id: "repos", label: "repos", value: repoBadge(s, ticket) }] : [])].map(chipEl)))
      .when(Boolean(short), (el) => el.child(div().id("ask-short").text_color(t.muted).child(short)))
      .when(Boolean(ticket.warning), (el) => el.child(div().id("budget-warning").text_size(12).text_color(t.blocked).child(`Budget: ${ticket.warning}`)))
      .when(links.length > 0, (el) => el.child(h_flex().id("shared").gap(6).flex_wrap().items_center()
        .child(div().text_size(12).text_color(t.dim).child("Shared on claude.ai"))
        .children(links.map((l) => div().id(`shared-${l.file}`).px(8).py(1).rounded(5).border(1).border_color(t.border).text_size(12)
          .text_color(t.accent).cursor_pointer().hover((st) => st.bg(t.hover)).on_click(() => exec("open", [l.url])).child(l.label)))))
      .when(Boolean(stripEl), (el) => el.child(stripEl))
      .child(h_flex().id("tabs").gap(2).border_b(1).border_color(t.border)
        .children(V2_TABS.map((x) => h_flex().id(`tab-${x.key}`).flex_none().gap(4).px(10).py(6).cursor_pointer().border_b(2)
          .border_color(x.key === tab.key ? t.accent : t.background).text_color(x.key === tab.key ? t.foreground : t.muted)
          .hover((st) => st.text_color(t.foreground)).on_click((_e, cx) => { page.tab = x.key; cx.notify(); })
          .child(x.title).when(Boolean(counts[x.id]), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(counts[x.id])))))
        .child(div().flex_1())
        .child(div().flex_none().text_size(11.5).text_color(t.dim).child("⌘⌥1–6")))
      .child(v_flex().id(`pane-${tab.id}`).gap(2).children(panes[tab.id]()));

    // ── right ─────────────────────────────────────────────────────────────
    const who = agentLine(ticket, kind, ticket.events, now);
    const bar = tokenBar(ticket);
    const agentEl = v_flex().id("agent").px(16).py(14).gap(8).border_b(1).border_color(t.border)
      .child(h_flex().gap(10).items_center()
        .child(div().size(9).flex_none().rounded_full().bg(tone(who.tone)))
        .child(div().flex_1().min_w_0().truncate().font_semibold().text_color(t.foreground).child(who.who))
        .child(div().flex_none().text_size(12).text_color(t.muted).child(who.time)))
      .child(v_flex().gap(2)
        .child(h_flex().h(5).rounded(3).bg(t.border).overflow_hidden()
          .child(div().h_full().w(`${(bar.input * 100).toFixed(1)}%`).bg(bar.warn ? t.blocked : t.accent)))
        .child(h_flex().h(3).rounded(2).bg(t.border).overflow_hidden()
          .child(div().h_full().w(`${(bar.output * 100).toFixed(1)}%`).bg(t.done))))
      .child(h_flex().gap(8).text_size(11.5).text_color(t.muted)
        .child(div().flex_1().min_w_0().truncate().child(bar.left))
        .when(Boolean(bar.right), (el) => el.child(div().flex_none().child(bar.right))));

    const mono = cx.theme?.()?.typography?.mono ?? "Menlo";
    const termEl = kind === "working" && ticket.terminal && v_flex().id("live-terminal").mx(16).mt(12).rounded(8).border(1).border_color(t.border).bg(t.background)
      .child(h_flex().gap(8).px(10).py(6).border_b(1).border_color(t.border).text_size(11.5).text_color(t.dim)
        .child(div().flex_1().child(`live · ${ticket.terminal} · read-only`))
        .child(div().id("open-terminal").text_color(t.accent).cursor_pointer().on_click(() => peekAgent(ticket)).child("open  e")))
      .child(v_flex().id("tail").px(12).py(8).max_h(250).overflow_y_scroll().font_family(mono).text_size(11.5).text_color(t.muted)
        .children(!daemon ? [div().text_color(t.dim).child("Sample data: no live terminal to show.")]
          : this.lines == null ? [div().text_color(t.dim).child("Reading the terminal…")]
          : this.lines.slice(-14).map((l, i) => div().id(`tl-${i}`).whitespace_nowrap().overflow_hidden().text_color(/^\s*⏺/.test(l) ? t.foreground : /^\s*✻/.test(l) ? t.accent : t.muted).child(l || " "))));

    // The inline question card: the question the agent asks (its options from the live screen), or a
    // parked ticket's questions. Your own words go in the box; Send answers.
    let qEl = null;
    if (waitsOnYou(kind)) {
      const tq = kind === "asks" ? terminalQuestion(this.lines ?? []) : null;
      const qs = kind === "asks" ? [tq?.question || ticket.needs?.text || "Its agent asks you in its terminal."]
        : waiting.length ? waiting.map((q) => `${waiting.length > 1 ? `${q.label} · ` : ""}${q.text}`) : [ticket.needs?.text ?? "It stopped."];
      const opts = tq?.options ?? [];
      const talk = talkable(ticket);
      qEl = v_flex().id("question").mx(16).mt(12).p(12).gap(8).rounded(8).border(1).border_color(askC).bg(t.surface)
        .child(h_flex().gap(8).text_size(11).font_semibold().text_color(askC)
          .child(div().flex_1().child((kind === "asks" ? `${ticket.agent ?? ticket.stage ?? "its agent"} asks in its terminal` : waiting.length ? "parked question" : "parked").toUpperCase()))
          .child(div().text_color(t.dim).child(kind === "asks" ? "1 / 1" : `${qs.length} open`)))
        .children(qs.map((q, i) => div().id(`qt-${i}`).font_semibold().text_color(t.foreground).child(q)))
        .children(opts.map((o) => h_flex().id(`opt-${o.n}`).gap(8).px(9).py(7).rounded(6).border(1).items_start().cursor_pointer()
          .border_color(this.pick === o.n ? askC : t.border).when(this.pick === o.n, (el) => el.bg(`${askC}22`))
          .hover((st) => st.border_color(askC)).on_click((_e, cx) => { this.pick = this.pick === o.n ? null : o.n; cx.notify(); })
          .child(div().w(18).flex_none().text_size(11).text_color(t.dim).child(`${o.n}.`))
          .child(v_flex().flex_1().min_w_0().child(div().text_color(t.foreground).child(o.label))
            .when(Boolean(o.detail), (el) => el.child(div().text_size(12).text_color(t.muted).child(o.detail))))))
        .child(h_flex().gap(8).items_center()
          .child(this.input ? div().id("answer-box").flex_1().min_w_0().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).w_full().h(32).px(9).rounded(6).border(1).border_color(t.border).bg(t.background).text_size(12.5).text_color(t.foreground)) : div().flex_1())
          .child(div().id("send").px(11).py(6).rounded(6).border(1).border_color(askC).text_color(askC).text_size(12.5).cursor_pointer()
            .hover((st) => st.opacity(0.85)).on_click((_e, cx) => this.send(cx)).child(kind === "asks" ? "Send" : "Answer & resume")))
        .child(div().text_size(11.5).text_color(t.dim).child(kind === "asks"
          ? "Typed into the live terminal, the same as answering there; it opens after."
          : `Restarts ${ticket.state === "grooming" ? "grooming" : ticket.stage ?? "its stage"} with your answer${talk ? "; u talks it through in a fresh session instead" : ""}.`));
    }

    const rules = kind === "ready" && v_flex().id("ready-rules").px(16).pt(14).gap(4)
      .child(label("Ready rules", this.rules?.length ? `${this.rules.filter((r) => r.result === "pass").length} of ${this.rules.length}` : null))
      .children(this.rules?.length ? this.rules.map((r, i) => h_flex().id(`rule-${i}`).gap(8).items_start()
        .child(div().w(14).flex_none().text_color(RESULT[r.result === "skipped" ? "pending" : r.result][1]).child(RESULT[r.result === "skipped" ? "pending" : r.result][0]))
        .child(div().flex_1().min_w_0().text_color(t.foreground).child(r.rule)).child(div().text_size(12).text_color(t.dim).child(r.detail)))
        : [div().text_size(12).text_color(t.muted).child(readyCount(ticket) ? `${readyCount(ticket)} pass.` : "The pr stage checks them.")]);

    const d = this.diffFor === ticket.id ? this.diff : null;
    const STATUS_C = { A: t.done, D: t.ansi1, R: t.accent, M: t.accent };
    const filesEl = !["grooming", "queued"].includes(ticket.state) && v_flex().id("files").px(16).pt(14).gap(3)
      .child(label("Files changed", d?.text))
      .children(!daemon ? [div().text_size(12).text_color(t.dim).child("Sample data: d shows a real ticket's diff.")]
        : !d ? [div().text_size(12).text_color(t.dim).child("Reading the diff…")]
        : d.error ? [div().text_size(12).text_color(t.dim).child(d.error)]
        : !d.files.length ? [div().text_size(12).text_color(t.dim).child("No changes yet.")]
        : [...d.files.slice(0, 8).map((f, i) => h_flex().id(`file-${i}`).gap(8).font_family(mono).text_size(12).items_center()
            .child(div().w(10).flex_none().text_color(STATUS_C[f.status]).child(f.status))
            .child(div().flex_1().min_w_0().truncate().text_color(t.foreground).child(f.path))
            .child(div().flex_none().text_color(t.done).child(f.add ? `+${f.add}` : ""))
            .child(div().flex_none().text_color(t.ansi1).child(f.del ? `−${f.del}` : ""))),
          ...(d.files.length > 8 ? [div().text_size(12).text_color(t.dim).child(`and ${d.files.length - 8} more · d shows them all`)] : [])]);

    const feed = activity(ticket.events, now, 8);
    const activityEl = v_flex().id("activity").px(16).pt(14).pb(12).gap(1)
      .child(label("Activity"))
      .children(feed.length ? feed.map((e, i) => h_flex().id(`ev-${i}`).gap(8).py(2).text_size(12).items_start()
        .child(div().w(44).flex_none().text_right().text_color(t.dim).child(e.time))
        .child(div().w(14).flex_none().text_color(tone(e.tone)).child(e.mark))
        .child(div().flex_1().min_w_0().text_color(t.muted).child(e.text)))
        : [div().text_size(12).text_color(t.dim).child("Nothing in the journal yet.")]);

    const btns = buttons(ticket, kind);
    const button = (b) => h_flex().id(`btn-${b.id}`).gap(6).px(11).py(6).rounded(6).border(1).items_center().cursor_pointer().text_size(12.5)
      .border_color(b.tone === "primary" ? t.accent : b.tone === "ask" ? askC : t.border).bg(t.background)
      .text_color(b.tone === "primary" ? t.accent : b.tone === "ask" ? askC : t.foreground)
      .hover((st) => st.border_color(t.accent)).on_click(() => this.act(b.action, ticket, s))
      .child(b.label).child(div().text_size(11).text_color(t.dim).child(b.key));
    const refresh = h_flex().id("btn-refresh").px(11).py(6).rounded(6).border(1).border_color(t.border).bg(t.background).cursor_pointer().text_size(12.5)
      .text_color(t.muted).hover((st) => st.border_color(t.accent)).on_click(() => page.refresh(ticket, cx)).child(page.refreshing ? "Refreshing…" : "Refresh");

    const right = v_flex().id("ticket-right").flex_1().min_w_0().h_full().bg(t.surface).border_l(1).border_color(t.border)
      .child(v_flex().id("right-scroll").flex_1().min_h(0).overflow_y_scroll()
        .child(agentEl)
        .when(Boolean(termEl), (el) => el.child(termEl))
        .when(Boolean(qEl), (el) => el.child(qEl))
        .when(Boolean(rules), (el) => el.child(rules))
        .when(Boolean(filesEl), (el) => el.child(filesEl))
        .child(activityEl))
      .child(h_flex().id("actions").flex_none().gap(8).flex_wrap().px(16).py(12).border_t(1).border_color(t.border)
        .children(btns.map(button)).child(div().flex_1()).child(refresh));

    return h_flex().size_full().text_size(13).rounded(10).bg(t.background).border(1).border_color(t.border).overflow_hidden()
      .track_focus(page.handle).on_mouse_down("left", () => page.handle.focus())
      .on_key_down((e, cx) => {
        if (this.typing) return; // keys typed in the answer box, the search or the editor stay there
        if (/^[1-6]$/.test(e.key) && !e.modifiers.platform && !e.modifiers.control && !e.modifiers.alt) { page.tab = e.key; cx.stop_propagation(); cx.notify(); return; }
        const a = pageKey(keyAction(e), ticket, kind);
        if (a && a.kind !== "move" && a.kind !== "open") { this.act(a, ticket, s); cx.stop_propagation(); }
      })
      .child(left)
      .child(right);
  }
}
