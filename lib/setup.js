// Home's first-run checklist: status.json's `setup` field, while the factory has no .factory/.
// The sample is what smoke.sh shows through the factory-home test layout's `setup` prop.

export const SETUP_SAMPLE = {
  steps: [
    { id: "herdr-core", label: "herdr-core (hc) is installed", status: "ok", fix: null },
    { id: "gh", label: "GitHub CLI installed and logged in", status: "missing", fix: "gh auth login" },
    { id: "harness", label: "An agent harness (claude or codex) is on PATH", status: "ok", fix: null },
    { id: "service", label: "The daemon runs at login", status: "missing", fix: "factory service install" },
    { id: "queue", label: "The queue is set in factory.yaml", status: "skipped", fix: "set queue: { github_project: owner/<n or title>, column: Ready, assignee: me } in .factory/factory.yaml" },
    { id: "basics", label: "Budgets, merge gate and max_running are set", status: "missing", fix: "factory setup write --budget 3M/150k --merge human --max-running 3" },
    { id: "factory-dir", label: ".factory/ is written", status: "missing", fix: "factory setup write" },
  ],
};

// "2 of 7 done", counting a skipped step as set aside, not done.
export function setupProgress(setup) {
  const total = setup.steps.length;
  const done = setup.steps.filter((s) => s.status === "ok").length;
  const skipped = setup.steps.filter((s) => s.status === "skipped").length;
  return { done, total, skipped, text: `${done} of ${total} done${skipped ? `, ${skipped} skipped` : ""}` };
}
