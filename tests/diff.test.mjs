import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiff } from "../lib/diff.js";

const DIFF = `diff --git a/src/limit.ts b/src/limit.ts
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/src/limit.ts
@@ -0,0 +1,2 @@
+export const MAX = 5;
+\treturn 429;
diff --git a/README.md b/README.md
index 1..2 100644
--- a/README.md
+++ b/README.md
@@ -10,3 +10,3 @@ Usage
 Intro
-old line
+new line
`;

test("a diff becomes file headers, hunks and numbered lines, with counts", () => {
  const d = parseDiff(DIFF);
  assert.deepEqual(d.files.map((f) => [f.path, f.add, f.del]), [["src/limit.ts", 2, 0], ["README.md", 1, 1]]);
  assert.deepEqual([d.add, d.del, d.cut], [3, 1, 0]);
  assert.deepEqual(d.rows.map((r) => [r.kind, r.number ?? null]), [
    ["file", null], ["@", null], ["+", 1], ["+", 2],
    ["file", null], ["@", null], [" ", 10], ["-", 11], ["+", 11],
  ]);
  assert.equal(d.rows[3].text, "    return 429;");
});

test("an empty diff has no rows; a huge one is cut and says by how much", () => {
  assert.deepEqual(parseDiff(""), { files: [], add: 0, del: 0, rows: [], cut: 0 });
  const d = parseDiff(DIFF, 4);
  assert.deepEqual([d.rows.length, d.cut, d.add], [4, 5, 3]);
});
