---
name: commit-message
description: Write the commit message for staged changes. Use before every git commit a factory agent makes.
---

# Commit message

1. Run `git diff --cached --stat` and `git diff --cached` to see what is staged.
2. Write a subject line of at most 60 characters, in the imperative ("Add", "Fix", "Remove"), with no period at the end. Name what changed for the user of the code, not the files touched.
3. If the reason isn't plain from the subject, add a blank line and a body of one to three short paragraphs: why the change is needed, and anything a reviewer could miss. Wrap at 72 characters.
4. Never mention the ticket's stage, the factory, or that an agent wrote it, unless the repo's own rules ask for it.
5. Commit with `git commit -F <file>` so the message keeps its line breaks.
