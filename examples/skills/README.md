# Factory skills

A factory skill is a folder holding a `SKILL.md`, in Claude Code's own skill format. An agent gets a skill only when its frontmatter lists it:

```markdown
---
role: build
skills: [commit-message]
tools: [Read, Edit, Write, Bash, Grep, Glob]
---
You build one slice at a time…
```

## Where skills live

- `examples/skills/<name>/` in this repo: the shipped skills. `factory init` and `factory setup` copy each one into `~/.factory/skills/<name>/` once. A skill folder already there is yours and is never overwritten.
- `~/.factory/skills/<name>/`: every repo's agents and the factory agents can list these. Put your own skills here too.
- `<repo>/.factory/skills/<name>/`: one repo's own skills. For that repo's agents it wins over `~/.factory/skills/`. Factory agents (Overwatch, the maintainer, the babysitter, the learner) don't read it.

`factory validate` checks every agent's `skills:` and names both places when a skill isn't found. It also checks each `SKILL.md` in `~/.factory/skills/`.

## The format

```
<name>/
  SKILL.md        the header and the instructions
  scripts/…       optional: files the instructions tell the agent to run or read
```

`SKILL.md` starts with a YAML header between `---` lines:

- `name`: the folder's name.
- `description`: what the skill does and when to use it. The session reads only this until it loads the skill, so say when it applies.

The instructions follow the header. Keep them short and concrete: steps the agent follows, the commands it runs.

## How a session gets its skills

When a session starts, the factory copies the agent's listed skills into a plugin folder of that session's own (`<ticket folder>/.skills/<agent>/`, or `~/.factory/.skills/overwatch/`) and starts `claude --plugin-dir=<that folder>`. The session sees each one as `factory:<name>`, and its brief names them in one line. It never writes into your repo checkout or your `~/.claude/skills/`. An agent that lists no skills gets none of the factory's.

`tools:` becomes `claude --tools=<list>`: the session has only those built-in tools. When the agent also lists skills, `Skill` is added so the session can load them. An agent with no `tools:` keeps every tool.

`commit-message/` is a working example.
