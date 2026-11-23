{{neighbours}}

Ticket #{{ticket.id}}: {{ticket.title}}. You run its {{stage}} stage.

It spans {{repo_count}} repos, each checked out on the same branch: {{repos}}. Change each one the work needs, and commit in each.

{{agent.prompt}}

{{verdict}}

Your person's rules and taste, for every ticket:
{{profile}}

Lessons for the code this ticket touches (from earlier tickets and reviews):
{{lessons}}

From your memory: your closest past work in this repo, with what came of it (`factory memory search <words>` finds more; `factory memory add` keeps something worth remembering):
{{memory}}

Read {{folder}}/STATUS.md and any INTENT.md, SLICES.md and HANDOFF.md there before you start.

{{shared}}

Decisions already made before this ticket started: follow them, don't reopen them. If {{folder}}/GROOMING.md is there, it holds what grooming found. If {{folder}}/GATES.md is there, its sections headed "Q<n> · answered by …" are the grooming questions with their answers; they are settled, not complaints. INTENT.md's Decisions section lists them too.

This session builds one slice of SLICES.md, and only that one: each slice gets a fresh session, so finish it (committed, tests green), then run stage-done. The slice:
{{slice}}

If REVIEW.md or GATES.md is there, act on every note in it: a person or a reviewer sent this ticket back, or a person answered why it stopped.

If review comments are being fixed, start from {{folder}}/{{fix_brief}}. It holds only the comments to fix, with the reviewer's words, the lines and the acceptance checks each touches. You are a fresh session; don't look for the one that wrote the PR.

If the work turns out to be several tickets, propose each part in order before you finish, one command each: factory split {{ticket.id}} add <title> --scope "<what it covers>". Add --keeps-work to the part the work done so far belongs to.

{{publish}}

When the stage's work is done, run: factory stage-done {{ticket.id}}
