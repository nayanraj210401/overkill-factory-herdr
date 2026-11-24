import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, setShared, shared, checking, notify, layout, exec } from "herdr";
import { repoBadge, warnMark, v2UI } from "./lib/model.js";
import { GLYPH, sidebarView, elapsed, tickMs, rowTitle, threadTarget, chatUnread, seenNext } from "./lib/sidebar.js";
import { STACK, activePage } from "./lib/pages.js";
import { VIEW_KEY, OPEN_KEY } from "./lib/ticketchat.js";
import { status, liveAgents } from "./lib/store.js";

const FOLD = "factory.sidebar.settled"; // Settled unfolded: this viewer's choice, kept in shared.json
const LIST_ASK = "factory.list-ask"; // what the Tickets page should show when it opens (factory-list reads it)
const SEEN = "factory.chat.seen"; // the chat-unread marker: each row's transcript size when this viewer last saw it

const page = (child) => run("layout.select", { stack: STACK, child });
// `view`: "chat" opens it on the V2 page's Chat view (the page reads the ask, lib/ticketchat.js askedView).
const openTicket = (id, view = null) => {
  if (view) setShared(OPEN_KEY, { id, view, at: Date.now() });
  setShared("factory.ticket", id);
  page("ticket");
};
// The Ticket page shown, and the view it shows (it writes VIEW_KEY while the gate is on).
const ticketPage = () => ({ page: checking() ? null : activePage(layout()).id, view: shared(VIEW_KEY) });
// The Tickets page, with its search focused or a filter chosen.
const openList = (ask) => { setShared(LIST_ASK, { at: Date.now(), ...ask }); page("tickets"); };
// A global agent: Overwatch has its page; the others' live terminal peeks over the page.
function openAgent(r) {
  if (r.agent === "overwatch") return page("overwatch");
  if (r.terminal) return run("terminal.peek", { terminal: r.terminal });
  notify({ title: `The ${r.agent} has no live terminal`, level: "info", timeout: 2500 });
}

// The sidebar under the brand: Search, Waiting on you, Working, the queue's quiet line and
// Settled (lib/sidebar.js). Only what's alive and what waits on you; the rest is on Tickets.
export default class FactoryTickets extends View {
  init(_props, cx) {
    this.sizes = {}; // transcript → its bytes at the last look
    if (checking()) return;
    // The Working timers: every second while one shows seconds, else every 5 s. With the gate on,
    // each look also reads the rows' transcripts' sizes for the chat-unread marker.
    cx.spawn(async (cx) => {
      for (;;) {
        await new Promise((done) => cx.timer.after(this.tick ?? 5000, done));
        await this.look().catch(() => {});
        cx.notify();
      }
    });
  }

  // The chat-unread state: the Waiting on you and Working tickets' live transcripts, sized; the
  // ticket the Chat view shows now counts as read.
  async look() {
    const s = status();
    if (!s || !v2UI(s)) return;
    const v = sidebarView(s, [], Date.now());
    const ids = new Set([...v.waiting, ...v.working].map((r) => r.ticket).filter((id) => id != null));
    const tickets = s.tickets.filter((t) => ids.has(t.id)).map((t) => ({ id: t.id, transcript: t.transcript ?? null }));
    // Herdr's fs has no stat: wc -c sizes them all in one go (a missing file is left out).
    const files = [...new Set(tickets.map((t) => t.transcript).filter(Boolean))];
    const r = files.length ? await exec("wc", ["-c", ...files]).catch(() => null) : null;
    const sizes = {};
    for (const line of String(r?.stdout ?? "").split("\n")) {
      const m = line.match(/^\s*(\d+)\s(.+)$/);
      if (m && files.includes(m[2])) sizes[m[2]] = Number(m[1]);
    }
    this.sizes = sizes;
    const p = ticketPage();
    const viewing = p.page === "ticket" && p.view === "chat" ? shared("factory.ticket") : null;
    const seen = shared(SEEN) ?? {};
    const next = seenNext(seen, tickets, sizes, viewing);
    if (next !== seen) setShared(SEEN, next);
  }

  glyph(t, r) {
    if (r.kind === "work") return r.idle ? div().w(14).flex_none().text_color(t.dim).child("·")
      : div().w(14).flex_none().child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900));
    const color = { ask: t.blocked, ready: t.done, parked: t.ansi1 }[r.kind] ?? t.dim;
    return div().w(14).flex_none().text_size(12).font_semibold().text_color(color).child(GLYPH[r.kind] ?? "·");
  }

  row(t, s, r, tickets, now) {
    const ticket = r.ticket != null ? tickets.get(r.ticket) : null;
    const v2 = v2UI(s);
    const unread = v2 && ticket && r.kind !== "settled" && chatUnread(ticket, shared(SEEN), this.sizes?.[ticket.transcript]);
    const on = r.ticket != null && shared("factory.ticket") === r.ticket;
    const badge = ticket ? repoBadge(s, ticket) : null;
    const warn = ticket && r.kind === "work" ? warnMark(ticket) : null;
    const right = r.kind === "work" ? elapsed(r.since, now) : r.age;
    const title = rowTitle(r);
    // The repo badge ("api + web") ends the second line, so the title keeps the first.
    const sub = [r.sub, badge].filter(Boolean).join(" · ");
    return v_flex().id(r.key).px(8).py(5).gap(1).rounded(7).cursor_pointer().bg(on ? t.selected : t.chrome)
      .hover((st) => st.bg(t.hover))
      .on_click(() => {
        const to = threadTarget(r, { v2, ...ticketPage() });
        return to.ticket != null ? openTicket(to.ticket, to.view) : openAgent(r);
      })
      .child(h_flex().min_w_0().gap(6).items_center().text_size(13).text_color(t.foreground)
        .child(this.glyph(t, r))
        .child(div().id(`tt-${r.key}`).flex_1().min_w_0().truncate().tooltip(title).child(title))
        .when(!!unread, (el) => el.child(div().id(`unread-${r.key}`).size(7).flex_none().rounded_full().bg(t.accent).tooltip("New in its chat since you last looked")))
        .when(!!warn, (el) => el.child(div().flex_none().px(5).rounded(7).text_size(10.5).border(1).border_color(t.blocked).text_color(t.blocked).child(warn)))
        .when(!!right, (el) => el.child(div().flex_none().text_size(11.5).text_color(r.kind === "work" ? t.working : t.dim).child(right))))
      .when(!!sub, (el) => el.child(div().pl(20).text_size(11.5).text_color(r.kind === "ask" ? t.blocked : t.muted).truncate().child(sub)));
  }

  render() {
    const t = theme();
    const s = status();
    if (!s) return div().size_full().bg(t.chrome);
    const now = Date.now();
    const v = sidebarView(s, liveAgents(), now);
    this.tick = tickMs(v.working, now);
    const tickets = new Map(s.tickets.map((x) => [x.id, x]));
    const open = !!shared(FOLD);
    const head = (id, text, count, color) => h_flex().id(id).px(8).pt(12).pb(3).gap(6).items_center().text_size(12).font_semibold().text_color(color)
      .child(div().flex_1().child(text)).child(div().text_color(t.dim).child(String(count)));
    // One column inside the scroll area: rows keep their height and scroll, never squeeze.
    return v_flex().id("tickets").size_full().bg(t.chrome).overflow_y_scroll().child(v_flex().flex_none().w_full().px(8)
      .child(h_flex().id("search").mx(4).mt(2).px(8).py(5).gap(8).items_center().rounded(7).cursor_pointer().text_size(13).text_color(t.dim)
        .hover((st) => st.bg(t.hover).text_color(t.muted))
        .on_click(() => openList({ search: true }))
        .child(svg("mods/workspace-chrome/search.svg").size(13).flex_none())
        .child(div().flex_1().min_w_0().truncate().child("Search tickets")))
      .when(v.waiting.length > 0, (el) => el
        .child(head("waiting", "Waiting on you", v.waiting.length, t.blocked))
        .children(v.waiting.map((r) => this.row(t, s, r, tickets, now))))
      .child(head("working", "Working", v.working.length, t.muted))
      .children(v.working.map((r) => this.row(t, s, r, tickets, now)))
      .when(!v.working.length, (el) => el.child(div().pl(28).py(4).text_size(12).text_color(t.dim).child("Nothing running.")))
      .when(!!v.quiet, (el) => el.child(div().id("quiet").mt(6).px(8).py(5).rounded(6).cursor_pointer().truncate().text_size(12).text_color(t.dim)
        .hover((st) => st.bg(t.hover).text_color(t.muted))
        .on_click(() => openList({ filter: "queue" }))
        .child(v.quiet.text)))
      .child(head("settled", "Settled", `${v.settledCount} ${open ? "▾" : "›"}`, t.muted).cursor_pointer()
        .hover((st) => st.text_color(t.foreground))
        .on_click(() => setShared(FOLD, open ? null : true)))
      .when(open, (el) => el.children(v.settled.map((r) => this.row(t, s, r, tickets, now))))
      .when(open && !v.settled.length, (el) => el.child(div().pl(28).py(4).text_size(12).text_color(t.dim).child("Nothing settled this week.")))
      .child(div().h(8)));
  }
}
