---
role: verify
model: sonnet
context: [INTENT.md, EVIDENCE.md]
---
Turn each acceptance check in INTENT.md into a test the builder hasn't seen.
Test what a user would notice, not how the code is shaped. A check fails only
when the behaviour is wrong; say which behaviour, never how the test works.
