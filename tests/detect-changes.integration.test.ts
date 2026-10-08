import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFile } from "fs/promises";
import { join } from "path";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";
import { detectChanges } from "../src/search/detect-changes.ts";

/**
 * detect_changes end to end on a fixture git repo with a non-ASCII file name (G8).
 *
 * Gated on YGGDRASIL_INTEGRATION_TESTS=1 (needs Postgres with the ci_* schema).
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/detect-changes.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

const FILE = "src/main/kotlin/no/nav/test/Årsavregning.kt";

async function git(cwd: string, ...args: string[]) {
  // Isolate from the user's global config: no signing prompt, no hooks.
  const isolated = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
  const proc = Bun.spawn(["git", ...isolated, ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

describe.skipIf(!RUN)("detect_changes on a fixture repo", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      [FILE]: `package no.nav.test

object Årsavregning {
    fun lagNy() = 1
}
`,
    });
    await git(repo.path, "init", "-q");
    await git(repo.path, "add", ".");
    await git(repo.path, "commit", "-q", "-m", "init");
    // Uncommitted edit inside lagNy; detectChanges diffs the working tree.
    await writeFile(
      join(repo.path, FILE),
      `package no.nav.test

object Årsavregning {
    fun lagNy() = 2
}
`,
    );
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("a changed file with Å in its path maps to its indexed symbols", async () => {
    const result = await detectChanges(repo.name);
    expect(result?.changedFiles).toEqual([FILE]);
    expect(result?.changedSymbols.map((s) => s.qualified_name)).toContain("no.nav.test.Årsavregning.lagNy");
  });
});

const SERVICE = "src/main/kotlin/no/nav/svc/Service.kt";
const SERVICE_BASE = `package no.nav.svc

class Service {
    val navn = "x"

    fun beregn(a: Int): Int {
        val b = a + 1
        return b
    }

    fun beregn(a: Int, c: Int): Int {
        return a + c
    }
}
`;

async function gitOut(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  return (await new Response(proc.stdout).text()).trim();
}

/**
 * Review mode (D1) and G7 on a fixture whose index sits at the PR's base `c0`:
 *   ins: inserts five lines inside beregn(Int, Int), the second overload — a pure
 *        insertion (`@@ -11,0 +12,5 @@`). Second, so a lookup by qualified name, which
 *        takes the first overload, would report the wrong callers.
 *   fld: edits only the field `navn`
 */
describe.skipIf(!RUN)("detect_changes review mode against an index of the base", () => {
  let repo: FixtureRepo;
  let c0: string, c1: string;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      [SERVICE]: SERVICE_BASE,
      "src/main/kotlin/no/nav/app/Bruker.kt": `package no.nav.app

import no.nav.svc.Service

class Bruker(private val service: Service) {
    fun brukEn(): Int = service.beregn(1)

    fun brukTo(): Int = service.beregn(1, 2)
}
`,
    });
    await git(repo.path, "init", "-q", "-b", "main");
    await git(repo.path, "add", ".");
    await git(repo.path, "commit", "-q", "-m", "c0");
    c0 = await gitOut(repo.path, "HEAD");
    await repo.reindex(); // records last_commit = c0

    await git(repo.path, "checkout", "-q", "-b", "ins");
    await writeFile(
      join(repo.path, SERVICE),
      SERVICE_BASE.replace(
        "    fun beregn(a: Int, c: Int): Int {\n",
        "    fun beregn(a: Int, c: Int): Int {\n        val x1 = 1\n        val x2 = 2\n        val x3 = 3\n        val x4 = 4\n        val x5 = x1 + x2 + x3 + x4\n",
      ),
    );
    await git(repo.path, "commit", "-q", "-am", "ins");
    c1 = await gitOut(repo.path, "HEAD");

    await git(repo.path, "checkout", "-q", "-b", "fld", "main");
    await writeFile(join(repo.path, SERVICE), SERVICE_BASE.replace(`val navn = "x"`, `val navn = "y"`));
    await git(repo.path, "commit", "-q", "-am", "fld");
    await git(repo.path, "checkout", "-q", "main");
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("an insertion inside a method flags only that method; the class is dropped", async () => {
    const result = await detectChanges(repo.name, { ref: "main...ins" });
    expect(result?.side).toBe("base");
    expect(result?.base).toBe(c0);
    expect(result?.head).toBe(c1);
    expect(result?.warnings).toEqual([]);
    expect(result?.changedSymbols.map((s) => `${s.qualified_name}:${s.start_line}`)).toEqual([
      "no.nav.svc.Service.beregn:11",
    ]);
    expect(result?.droppedContainers).toEqual(["no.nav.svc.Service"]);
  });

  test("blast radius follows the changed overload by id and carries edge_kind + resolution", async () => {
    const result = await detectChanges(repo.name, { ref: "main...ins" });
    const affected = result!.affectedSymbols.map((a) => `${a.qualified_name}@${a.edge_kind}/${a.resolution}`);
    expect(affected).toContain("no.nav.app.Bruker.brukTo@calls/typed");
    expect(affected.some((a) => a.startsWith("no.nav.app.Bruker.brukEn@"))).toBe(false);
    expect(result!.affectedSymbols.some((a) => a.edge_kind === "imports")).toBe(false);
  });

  test("a field-only change keeps the class, whose import graph sorts after calls", async () => {
    const result = await detectChanges(repo.name, { ref: "main..fld" });
    expect(result?.side).toBe("base");
    const changed = result!.changedSymbols.map((s) => s.qualified_name).sort();
    expect(changed).toEqual(["no.nav.svc.Service", "no.nav.svc.Service.navn"]);
    const kinds = result!.affectedSymbols.map((a) => a.edge_kind);
    expect(kinds).toContain("imports");
    const firstImport = kinds.indexOf("imports");
    expect(kinds.slice(firstImport).every((k) => k === "imports")).toBe(true);
  });

  test("side: 'head' keeps new-side intersection and warns that the index is not at the head", async () => {
    const result = await detectChanges(repo.name, { ref: "main...ins", side: "head" });
    expect(result?.side).toBe("head");
    expect(result?.warnings.join(" ")).toContain(c0.slice(0, 7));
  });

  test("auto mode against an index of the head intersects new-side lines", async () => {
    await git(repo.path, "checkout", "-q", "ins");
    await repo.reindex(); // last_commit = c1, which is not the base
    const result = await detectChanges(repo.name, { ref: "main...ins" });
    expect(result?.side).toBe("head");
    expect(result?.warnings).toEqual([]);
    // The inserted local vals are property symbols of the head index; the methods hit are what matters.
    const methods = result!.changedSymbols.filter((s) => s.kind !== "property");
    expect(methods.map((s) => `${s.qualified_name}:${s.start_line}`)).toEqual(["no.nav.svc.Service.beregn:11"]);

    const forced = await detectChanges(repo.name, { ref: "main...ins", side: "base" });
    expect(forced?.warnings.join(" ")).toContain(c1.slice(0, 7));
  });
});
