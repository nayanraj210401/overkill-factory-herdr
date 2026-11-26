{{neighbours}}

Ticket #{{ticket.id}}: {{ticket.title}}. You groom it: decide how it should be built and what must be asked before anyone starts. Change no files in the repo.

{{issue}}

{{digest}}

The owner's note outweighs everything else here: {{ticket.notes}} What it answers, don't ask again.

The code is in {{repo}}.

{{agent.prompt}}

It may need changes in more than this repo. The factory's other repos: {{repos}}. If it does, record every repo it touches, this one first: factory repos {{ticket.id}} {{slug}} <owner/name>…

Pick the blueprint it runs, one of {{blueprints}} (each is in {{repo}}/.factory/blueprints/): factory pick {{ticket.id}} <blueprint>

Ask only what the issue and the code can't settle, and ask the person here, in this session, with your question tool (AskUserQuestion): each question with two to four concrete options, the one you'd pick first. Wait for the answers; never guess what to build, for whom, what users see, wording, pricing or scope. The factory tells the person this ticket needs them.

If it is really several tickets, propose each part in the order they should ship, one command each: factory split {{ticket.id}} add <title> --scope "<what it covers>".

Write what you found, in a few lines, to {{folder}}/GROOMING.md, then a `## Decisions` section with each question you asked and the person's answer: the stages after you follow them and don't reopen them.

When you're done, run: factory stage-done {{ticket.id}}
