// Exact Claude model IDs. Claude Code resolves `--model sonnet` by its own version (2.1.330
// gave claude-sonnet-4-6 while 5.5 was current), so a factory run could change model under
// you between runs and benchmarks wouldn't know what they compared. Every agent the daemon
// starts gets an exact ID: the shipped files name them, and an alias left in any file
// (an agent, factory.yaml, an override, a benchmark variant) is pinned here at launch.
// Update this table when a new model ships.
export const MODELS: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-2",
};

export const DEFAULT_MODEL = MODELS.sonnet;

// An alias becomes its exact ID; an exact ID (or another harness's model) passes through.
export const pinModel = (m: string | undefined) => (m ? MODELS[m.trim().toLowerCase()] ?? m : m);
