Ticket #{{ticket.id}}: {{ticket.title}}. You groom it: decide how it should be built and what must be asked before anyone starts. Change no files in the repo.

{{issue}}

The code is in {{repo}}.

{{agent.prompt}}

It may need changes in more than this repo. The factory's other repos: {{repos}}. If it does, record every repo it touches, this one first: factory repos {{ticket.id}} {{slug}} <owner/name>…

Pick the blueprint it runs, one of {{blueprints}} (each is in {{repo}}/.factory/blueprints/): factory pick {{ticket.id}} <blueprint>

Ask only what the issue and the code can't settle, one command per question. What to build, for whom, what users see, wording, pricing or scope: factory question {{ticket.id}} product <question>. How to build it: factory question {{ticket.id}} engineering <question>. Never guess a product question.

If it is really several tickets, propose each part in the order they should ship, one command each: factory split {{ticket.id}} add <title> --scope "<what it covers>".

Write what you found, in a few lines, to {{folder}}/GROOMING.md.

When you're done, run: factory stage-done {{ticket.id}}
