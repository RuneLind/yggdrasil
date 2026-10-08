import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { resolveDiffSides } from "../src/search/detect-changes.ts";

/**
 * Base/head resolution per ref form (D1), against a throwaway git repo:
 *
 *   c0 ── c1 (main)
 *     └── c2 (feature)
 *
 * so the merge-base of main...feature (c0) differs from both sides.
 */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const isolated = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
  const proc = Bun.spawn(["git", ...isolated, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  return out.trim();
}

describe("resolveDiffSides", () => {
  let dir: string;
  let c0: string, c1: string, c2: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "yggdrasil-refs-"));
    await git(dir, "init", "-q", "-b", "main");
    await writeFile(join(dir, "a.txt"), "0\n");
    await git(dir, "add", ".");
    await git(dir, "commit", "-q", "-m", "c0");
    c0 = await git(dir, "rev-parse", "HEAD");
    await git(dir, "checkout", "-q", "-b", "feature");
    await writeFile(join(dir, "a.txt"), "2\n");
    await git(dir, "commit", "-q", "-am", "c2");
    c2 = await git(dir, "rev-parse", "HEAD");
    await git(dir, "checkout", "-q", "main");
    await writeFile(join(dir, "a.txt"), "1\n");
    await git(dir, "commit", "-q", "-am", "c1");
    c1 = await git(dir, "rev-parse", "HEAD");
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

  test("a ref that does not exist → throws, naming the ref", async () => {
    await expect(resolveDiffSides(dir, "no-such-ref")).rejects.toThrow(/no-such-ref/);
    await expect(resolveDiffSides(dir, "main...no-such-ref")).rejects.toThrow(/no-such-ref/);
    await expect(resolveDiffSides(dir, "no-such-ref..main")).rejects.toThrow(/no-such-ref/);
  });
});
