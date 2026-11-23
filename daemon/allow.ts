// What a factory agent may run without asking. Claude sessions run with acceptEdits (file
// edits in their folders) plus this allowlist; anything else still asks, and the hard-stop
// guard watches every call on top. Never bypassPermissions (decided with benchmarks, #60).

// A benchmark replay: file tools, read-only git, and the repo's own test commands.
export function benchAllow(commands: string[]) {
  const bash = new Set(["git status", "git diff", "git log", "git show", "ls", "cat"].map((c) => `Bash(${c}:*)`));
  for (const c of commands) {
    bash.add(`Bash(${c})`);
    const head = c.trim().split(/\s+/).slice(0, 2).join(" ");
    if (!/[|&;<>$`'"]/.test(head)) bash.add(`Bash(${head}:*)`);
  }
  return ["Read", "Glob", "Grep", "Edit", "MultiEdit", "Write", ...bash];
}

// A ticket's agent (grooming, a stage, a handoff): the replay's set, plus the factory CLI it
// reports through (stage-done, verdict, question, pick…), committing on its branch, and
// reading its issue. Not git push: only the daemon opens PRs.
export const agentAllow = (commands: string[]) =>
  [...benchAllow(commands), "Bash(factory:*)", "Bash(git add:*)", "Bash(git commit:*)", "Bash(gh issue view:*)"];
