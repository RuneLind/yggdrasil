import { describe, test, expect } from "bun:test";
import { resolveSourcePath } from "../src/mcp/server.ts";

/**
 * Regression guard for the read_source path-traversal hole: the tool used to
 * concatenate the caller-supplied path straight onto the repo root, so
 * `path: "../../../../etc/passwd"` read arbitrary files. resolveSourcePath contains
 * the path to the repo root and returns null on any escape.
 *
 * (Importing server.ts is safe: its Bun.serve bootstrap is guarded by import.meta.main.)
 */
const ROOT = "/repo/root";

describe("resolveSourcePath", () => {
  test("accepts a normal relative path", () => {
    expect(resolveSourcePath(ROOT, "src/Foo.kt")).toBe("/repo/root/src/Foo.kt");
  });

  test("accepts a deeply nested path", () => {
    expect(resolveSourcePath(ROOT, "a/b/c/D.java")).toBe("/repo/root/a/b/c/D.java");
  });

  test("allows .. that stays within the repo", () => {
    expect(resolveSourcePath(ROOT, "src/../README.md")).toBe("/repo/root/README.md");
  });

  test("rejects ../ traversal escaping the repo", () => {
    expect(resolveSourcePath(ROOT, "../../etc/passwd")).toBeNull();
  });

  test("rejects an absolute path outside the repo", () => {
    expect(resolveSourcePath(ROOT, "/etc/passwd")).toBeNull();
  });

  test("rejects a sibling-dir climb (prefix-collision guard)", () => {
    // /repo/root + ../root-secret resolves to /repo/root-secret, which shares the
    // "/repo/root" string prefix but is NOT inside the repo — must be rejected.
    expect(resolveSourcePath(ROOT, "../root-secret/file")).toBeNull();
  });

  test("rejects a path that normalizes back to the repo root itself", () => {
    expect(resolveSourcePath(ROOT, ".")).toBeNull();
  });

  test("rejects a NUL byte (would make Bun.file/fs throw instead of returning cleanly)", () => {
    expect(resolveSourcePath(ROOT, "src/" + String.fromCharCode(0) + "foo.kt")).toBeNull();
  });
});
