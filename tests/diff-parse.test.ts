import { describe, test, expect } from "bun:test";
import { parseGitDiff } from "../src/search/diff-parse.ts";

/**
 * Table-driven over real `git diff --unified=0 --no-color` output shapes.
 *
 * Regression coverage for rank 8: deletion-only hunks used to be dropped (the parser
 * keyed off the `+`side count, which is 0 for a pure deletion) and `+++ /dev/null`
 * leaked the previous file's name onto a deleted file's hunks.
 */

/** Normalize the files map into a comparable {path: sorted line numbers} object. */
function filesObject(diff: string): Record<string, number[]> {
  const { files } = parseGitDiff(diff);
  const out: Record<string, number[]> = {};
  for (const [path, lines] of files) out[path] = [...lines].sort((a, b) => a - b);
  return out;
}

describe("parseGitDiff", () => {
  test("pure addition → new-side line range", () => {
    const diff = `diff --git a/src/Bar.java b/src/Bar.java
index 1234567..89abcde 100644
--- a/src/Bar.java
+++ b/src/Bar.java
@@ -5,0 +6,2 @@ class Bar {
+    void added1() {}
+    void added2() {}`;
    expect(filesObject(diff)).toEqual({ "src/Bar.java": [6, 7] });
    const { addedLines, removedLines } = parseGitDiff(diff);
    expect(addedLines).toBe(2);
    expect(removedLines).toBe(0);
  });

  test("pure deletion → old-side line range (the rank-8 bug)", () => {
    const diff = `diff --git a/src/Foo.java b/src/Foo.java
index 1234567..89abcde 100644
--- a/src/Foo.java
+++ b/src/Foo.java
@@ -10,3 +9,0 @@ public class Foo {
-    void removed1() {}
-    void removed2() {}
-    void removed3() {}`;
    expect(filesObject(diff)).toEqual({ "src/Foo.java": [10, 11, 12] });
    const { addedLines, removedLines } = parseGitDiff(diff);
    expect(addedLines).toBe(0);
    expect(removedLines).toBe(3);
  });

  test("single-line deletion hunk without counts → one old-side line", () => {
    const diff = `diff --git a/a.kt b/a.kt
--- a/a.kt
+++ b/a.kt
@@ -42 +41,0 @@
-val gone = 1`;
    expect(filesObject(diff)).toEqual({ "a.kt": [42] });
  });

  test("mixed add + delete hunks in one file", () => {
    const diff = `diff --git a/src/Baz.java b/src/Baz.java
--- a/src/Baz.java
+++ b/src/Baz.java
@@ -3,2 +3,0 @@
-    int oldField1;
-    int oldField2;
@@ -20,0 +19,1 @@
+    int newField;`;
    expect(filesObject(diff)).toEqual({ "src/Baz.java": [3, 4, 19] });
    const { addedLines, removedLines } = parseGitDiff(diff);
    expect(addedLines).toBe(1);
    expect(removedLines).toBe(2);
  });

  test("rename with edits → attributed to the new path", () => {
    const diff = `diff --git a/src/Old.java b/src/New.java
similarity index 90%
rename from src/Old.java
rename to src/New.java
index 1234567..89abcde 100644
--- a/src/Old.java
+++ b/src/New.java
@@ -7 +7 @@
-    void old() {}
+    void renamed() {}`;
    expect(filesObject(diff)).toEqual({ "src/New.java": [7] });
  });

  test("deleted file (+++ /dev/null) → attributed to its old path, old-side lines", () => {
    const diff = `diff --git a/src/Gone.java b/src/Gone.java
deleted file mode 100644
index 1234567..0000000
--- a/src/Gone.java
+++ /dev/null
@@ -1,4 +0,0 @@
-package x;
-class Gone {
-  void a() {}
-}`;
    expect(filesObject(diff)).toEqual({ "src/Gone.java": [1, 2, 3, 4] });
    const { removedLines } = parseGitDiff(diff);
    expect(removedLines).toBe(4);
  });

  test("added file (--- /dev/null) → new-side lines, no leak", () => {
    const diff = `diff --git a/src/Added.java b/src/Added.java
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/Added.java
@@ -0,0 +1,3 @@
+package x;
+class Added {}
+// end`;
    expect(filesObject(diff)).toEqual({ "src/Added.java": [1, 2, 3] });
  });

  test("binary file → no entry", () => {
    const diff = `diff --git a/img/logo.png b/img/logo.png
index 1234567..89abcde 100644
Binary files a/img/logo.png and b/img/logo.png differ`;
    expect(filesObject(diff)).toEqual({});
  });

  test("deleted-file hunks don't leak onto a preceding modified file", () => {
    const diff = `diff --git a/src/Keep.java b/src/Keep.java
--- a/src/Keep.java
+++ b/src/Keep.java
@@ -2,0 +3,1 @@
+    int added;
diff --git a/src/Drop.java b/src/Drop.java
deleted file mode 100644
--- a/src/Drop.java
+++ /dev/null
@@ -1,2 +0,0 @@
-class Drop {}
-// gone`;
    expect(filesObject(diff)).toEqual({
      "src/Keep.java": [3],
      "src/Drop.java": [1, 2], // its own path, NOT merged into Keep.java
    });
  });

  test("deleted content lines that look like ---/+++ headers are not mistaken for headers", () => {
    // A removed SQL/Lua comment renders as `--- old…` and an added one as `+++ new…`.
    // Header parsing is anchored on `diff --git` + an in-header flag, so these stay
    // hunk body and never hijack currentFile.
    const diff = `diff --git a/src/q.sql b/src/q.sql
--- a/src/q.sql
+++ b/src/q.sql
@@ -2 +2 @@
--- old SQL comment
+++ new SQL comment`;
    expect(filesObject(diff)).toEqual({ "src/q.sql": [2] });
  });

  test("C-quoted non-ASCII path → decoded as UTF-8 (G8)", () => {
    // git's default core.quotePath quotes Å as its UTF-8 bytes in octal (\303\205).
    // Decoding each escape to its own char would yield "Ã\x85rsavregning" instead.
    const diff = String.raw`diff --git "a/src/no/\303\205rsavregning.kt" "b/src/no/\303\205rsavregning.kt"
index 1234567..89abcde 100644
--- "a/src/no/\303\205rsavregning.kt"
+++ "b/src/no/\303\205rsavregning.kt"
@@ -3 +3 @@
-    fun old() = 1
+    fun lagNy() = 1`;
    expect(filesObject(diff)).toEqual({ "src/no/Årsavregning.kt": [3] });
  });

  test("C-quoted path with \\\" \\\\ \\t escapes → unescaped", () => {
    const diff = String.raw`diff --git "a/x/q\"b\\c\td.kt" "b/x/q\"b\\c\td.kt"
--- "a/x/q\"b\\c\td.kt"
+++ "b/x/q\"b\\c\td.kt"
@@ -1 +1 @@
-a
+b`;
    expect(filesObject(diff)).toEqual({ 'x/q"b\\c\td.kt': [1] });
  });

  // git appends a TAB to a `---`/`+++` path that contains a space (shapes captured from git 2.x).
  test("quoted path with a space: trailing TAB after the closing quote is dropped", () => {
    const q = String.raw`"b/\303\205 b.kt"`;
    const diff = [
      String.raw`diff --git "a/\303\205 b.kt" "b/\303\205 b.kt"`,
      String.raw`--- "a/\303\205 b.kt"` + "\t",
      `+++ ${q}\t`,
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    expect(filesObject(diff)).toEqual({ "Å b.kt": [1] });
  });

  test("quotePath=false path with a space: trailing TAB is dropped", () => {
    const diff = ["diff --git a/a b.kt b/a b.kt", "--- a/a b.kt\t", "+++ b/a b.kt\t", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    expect(filesObject(diff)).toEqual({ "a b.kt": [1] });
  });

  test("deleted file with a space: old-side path loses its TAB too", () => {
    const diff = ["diff --git a/Å b.kt b/Å b.kt", "--- a/Å b.kt\t", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-a", "-b"].join("\n");
    expect(filesObject(diff)).toEqual({ "Å b.kt": [1, 2] });
  });

  test("empty diff → no files", () => {
    expect(filesObject("")).toEqual({});
  });
});
