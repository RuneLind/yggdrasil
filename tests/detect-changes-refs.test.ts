import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { git } from "./helpers/git.ts";
import { resolveDiffSides } from "../src/search/detect-changes.ts";

/**
 * Base/head resolution per ref form, against a throwaway git repo:
 *
 *   c0 ── c1 (main) ── m (merged: merge of feature, first parent c1)
 *     └── c2 (feature) ──┘
 *
 * so the merge-base of main...feature (c0) differs from both sides.
 */
describe("resolveDiffSides", () => {
  let dir: string;
  let c0: string, c1: string, c2: string, m: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "yggdrasil-refs-"));
    await git(dir, "init", "-q", "-b", "main");
    await writeFile(join(dir, "a.txt"), "0\n");
    await git(dir, "add", ".");
    await git(dir, "commit", "-q", "-m", "c0");
    c0 = await git(dir, "rev-parse", "HEAD");
    await git(dir, "checkout", "-q", "-b", "feature");
    await writeFile(join(dir, "a.txt"), "2\n");
    await git(dir, "commit", "-q", "-am", "c2 feature-commit");
    c2 = await git(dir, "rev-parse", "HEAD");
    await git(dir, "checkout", "-q", "main");
    await writeFile(join(dir, "a.txt"), "1\n");
    await git(dir, "commit", "-q", "-am", "c1");
    c1 = await git(dir, "rev-parse", "HEAD");
    await git(dir, "checkout", "-q", "-b", "merged");
    await git(dir, "merge", "-q", "-s", "ours", "-m", "m", "feature");
    m = await git(dir, "rev-parse", "HEAD");
    await git(dir, "checkout", "-q", "main");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("no ref → base is HEAD, head is the working tree", async () => {
    expect(await resolveDiffSides(dir)).toEqual({ base: c1, head: null });
  });

  test("single ref → base is that ref, head is the working tree", async () => {
    expect(await resolveDiffSides(dir, "feature")).toEqual({ base: c2, head: null });
  });

  test("a..b → base is a, head is b", async () => {
    expect(await resolveDiffSides(dir, "main..feature")).toEqual({ base: c1, head: c2 });
  });

  test("a...b → base is the merge-base, head is b", async () => {
    expect(await resolveDiffSides(dir, "main...feature")).toEqual({ base: c0, head: c2 });
  });

  test("an omitted side of a range means HEAD", async () => {
    // HEAD on feature, so HEAD differs from main.
    await git(dir, "checkout", "-q", "feature");
    try {
      expect(await resolveDiffSides(dir, "main..")).toEqual({ base: c1, head: c2 });
      expect(await resolveDiffSides(dir, "..main")).toEqual({ base: c2, head: c1 });
      expect(await resolveDiffSides(dir, "main...")).toEqual({ base: c0, head: c2 });
      expect(await resolveDiffSides(dir, "...main")).toEqual({ base: c0, head: c1 });
    } finally {
      await git(dir, "checkout", "-q", "main");
    }
  });

  test("X^! → X's first parent against X", async () => {
    expect(await resolveDiffSides(dir, "feature^!")).toEqual({ base: c0, head: c2 });
    expect(await resolveDiffSides(dir, "merged^!")).toEqual({ base: c1, head: m });
  });

  test("X^- and X^-n → X's n-th parent (default 1) against X", async () => {
    expect(await resolveDiffSides(dir, "merged^-")).toEqual({ base: c1, head: m });
    expect(await resolveDiffSides(dir, "merged^-1")).toEqual({ base: c1, head: m });
    expect(await resolveDiffSides(dir, "merged^-2")).toEqual({ base: c2, head: m });
  });

  test(":/text resolves as a single ref, even when the text holds '..'", async () => {
    expect(await resolveDiffSides(dir, ":/feature-commit")).toEqual({ base: c2, head: null });
    await git(dir, "commit", "-q", "--allow-empty", "-m", "fix a..b parsing");
    try {
      const fix = await git(dir, "rev-parse", "HEAD");
      expect(await resolveDiffSides(dir, ":/fix a..b")).toEqual({ base: fix, head: null });
    } finally {
      await git(dir, "reset", "-q", "--hard", c1);
    }
  });

  test("an annotated tag resolves to its commit on either side and as a single ref", async () => {
    await git(dir, "tag", "-a", "v0", "-m", "v0", c0);
    await git(dir, "tag", "-a", "v2", "-m", "v2", c2);
    try {
      expect(await resolveDiffSides(dir, "v0")).toEqual({ base: c0, head: null });
      expect(await resolveDiffSides(dir, "v0...v2")).toEqual({ base: c0, head: c2 });
      expect(await resolveDiffSides(dir, "v2..main")).toEqual({ base: c2, head: c1 });
    } finally {
      await git(dir, "tag", "-d", "v0", "v2");
    }
  });

  test("a directory that is not a git repo → throws instead of diffing against the empty tree", async () => {
    const plain = await mkdtemp(join(tmpdir(), "yggdrasil-nogit-"));
    try {
      await expect(resolveDiffSides(plain)).rejects.toThrow(/resolving ref 'HEAD'/);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  test("a ref that does not exist → throws, naming the ref", async () => {
    await expect(resolveDiffSides(dir, "no-such-ref")).rejects.toThrow(/no-such-ref/);
    await expect(resolveDiffSides(dir, "main...no-such-ref")).rejects.toThrow(/no-such-ref/);
    await expect(resolveDiffSides(dir, "no-such-ref..main")).rejects.toThrow(/no-such-ref/);
  });

  test("flag-style refs are rejected", async () => {
    for (const flag of ["--cached", "--staged", "-R", "--output=/tmp/x"]) {
      await expect(resolveDiffSides(dir, flag)).rejects.toThrow(/not a revision/);
    }
  });

  test("a repo without commits and no ref → base is the empty tree", async () => {
    const empty = await mkdtemp(join(tmpdir(), "yggdrasil-unborn-"));
    try {
      await git(empty, "init", "-q");
      const emptyTree = await git(empty, "hash-object", "-t", "tree", "/dev/null");
      expect(await resolveDiffSides(empty)).toEqual({ base: emptyTree, head: null });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
