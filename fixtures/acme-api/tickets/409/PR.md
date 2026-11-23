Bumps 14 dependencies to their latest minor versions; nothing in the app's behavior changes.

**What changed:** `package.json`, `package-lock.json`.
**Why:** monthly upkeep; two of the bumps close advisories.
**How it was verified:** 212 of 212 tests, typecheck, and the login scenario.
**Risk:** low. `zod` 3.23 changes an error message we don't match on.
**Check:** the lockfile diff for unexpected new packages.
