// Every page of the factory window: one list feeds the layout's stack, the
// keys, the menu, the header and the coming-soon cards (scripts/gen.mjs).
// `milestone` is when the page becomes real; `mod` names its mod once built, else it shows factory-soon.
// `agent`: the page is its mod as a strip over the focused agent's live terminal.

export const STACK = "pages";

export const PAGES = [
  { id: "home", title: "Home", key: "1", icon: "layers", milestone: "M1", mod: "factory-home", preview: "01-home.png",
    what: "What needs you first, then what's running, then today's four numbers." },
  { id: "tickets", title: "Tickets", key: "2", icon: "file-text", milestone: "M1", mod: "factory-list", preview: "03-tickets.png",
    what: "Every ticket, merged ones included, filtered by state and searchable." },
  { id: "reviews", title: "Reviews", key: "3", icon: "git-compare", milestone: "M6", mod: "factory-reviews", preview: "08-reviews.png",
    what: "Teammates' PRs waiting on you, risk-ordered, each with a pending review drafted." },
  { id: "overwatch", title: "Overwatch", key: "4", icon: "terminal", milestone: "M2", mod: "factory-overwatch", agent: true, preview: "04-overwatch.png",
    what: "One overwatch agent for every factory, in a live terminal: ask what's blocked, start, pause or reorder tickets." },
  { id: "blueprint", title: "Blueprint", key: "5", icon: "git-branch", milestone: "M2", mod: "factory-blueprint", preview: "05-blueprint.png",
    what: "Each blueprint as a graph of stages, with run counts and gates." },
  { id: "metrics", title: "Metrics", key: "6", icon: "clock", milestone: "M2", mod: "factory-metrics", preview: "06-metrics.png",
    what: "Throughput, Cost, Quality, Learning and Benchmarks over a date range." },
  { id: "repo-config", title: "Repo config", key: "7", icon: "folder", milestone: "M1", mod: "factory-repo-config", preview: "07-config.png",
    what: "Each repo's own .factory/ files, what each overrides, its schema check, and ⌘O to open your editor." },
  { id: "config", title: "Config", key: "8", icon: "settings", milestone: "M1", mod: "factory-config", preview: "07-config.png",
    what: "The daemon, and the factory's global files in ~/.factory: agents, skills, shared steps and account files." },
  // Not in the menu: you reach it by opening a ticket.
  { id: "ticket", title: "Ticket", key: null, icon: "file-text", milestone: "M1", mod: "factory-ticket", preview: "02-ticket.png",
    what: "One ticket's stage timeline beside its live agent terminal." },
];

// "⌘1–⌘8": the keys the menu pages take, for the header's hint.
export const keyRange = () => { const k = PAGES.filter((p) => p.key).map((p) => p.key); return `⌘${k[0]}–⌘${k.at(-1)}`; };

export const page = (id) => PAGES.find((p) => p.id === id) ?? PAGES[0];

export function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

// The page the stack shows now, read from the live layout tree.
export const activePage = (tree) => page(findNode(tree, STACK)?.active);
