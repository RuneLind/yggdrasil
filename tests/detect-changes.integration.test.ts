import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFile } from "fs/promises";
import { join } from "path";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";
import { git } from "./helpers/git.ts";
import { detectChanges } from "../src/search/detect-changes.ts";
import { detectChangesTool } from "../src/mcp/server.ts";
import { DetectChangesTracer } from "../src/tracing/trace.ts";

/**
 * detect_changes end to end on fixture git repos. Each describe owns its fixture and
 * never moves another's index or checkout, so the tests pass in any order.
 *
 * Gated on YGGDRASIL_INTEGRATION_TESTS=1 (needs Postgres with the ci_* schema).
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/detect-changes.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

const qnLines = (syms: Array<{ qualified_name: string; start_line: number }> | undefined) =>
  (syms ?? []).map((s) => `${s.qualified_name}:${s.start_line}`);

const FILE = "src/main/kotlin/no/nav/test/Årsavregning.kt";

describe.skipIf(!RUN)("detect_changes on a fixture repo with a non-ASCII file name", () => {
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
    await writeFile(join(repo.path, FILE), `package no.nav.test

object Årsavregning {
    fun lagNy() = 2
}
`);
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

const K_FILE = "src/main/kotlin/p/K.kt";
const K_BASE = `package p

class K {
    fun a(): Int {
        return 1
    }

    fun b(): Int {
        return 2
    }
}
`;
// Three lines inserted inside a(), and b()'s body changed. On the new side b() starts
// at line 11; its changed line is old line 9, which is a()'s closing brace on the new side.
const K_DIRTY = K_BASE.replace("    fun a(): Int {\n", "    fun a(): Int {\n        val x = 1\n        val y = 2\n        val z = 3\n").replace(
  "return 2",
  "return 3",
);

describe.skipIf(!RUN)("detect_changes against an index of the working tree", () => {
  let repo: FixtureRepo;
  let headSha: string;

  beforeAll(async () => {
    repo = await createFixtureRepo({ [K_FILE]: K_BASE });
    await git(repo.path, "init", "-q", "-b", "main");
    await git(repo.path, "add", ".");
    await git(repo.path, "commit", "-q", "-m", "c0");
    headSha = await git(repo.path, "rev-parse", "HEAD");
    await repo.reindex({ [K_FILE]: K_DIRTY }); // index holds the dirty tree; last_commit = HEAD
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("a single ref equal to last_commit diffs against the working tree, so the index is the head side", async () => {
    const result = await detectChanges(repo.name, { ref: "HEAD" });
    expect(result?.side).toBe("head");
    expect(result?.base).toBe(headSha);
    expect(result?.head).toBeNull();
    // A working-tree head never warns: last_commit cannot name it.
    expect(result?.warnings).toEqual([]);
    expect(result?.changedSymbols.map((s) => s.qualified_name)).toEqual(["p.K.a", "p.K.b"]);
  });

  test("no ref with last_commit equal to HEAD stays on the head side", async () => {
    const result = await detectChanges(repo.name);
    expect(result?.side).toBe("head");
    expect(result?.base).toBe(headSha);
    expect(result?.changedSymbols.map((s) => s.qualified_name)).toEqual(["p.K.a", "p.K.b"]);
  });
});

describe.skipIf(!RUN)("detect_changes with no ref compares the working tree against HEAD", () => {
  let repo: FixtureRepo;
  let headSha: string;

  beforeAll(async () => {
    repo = await createFixtureRepo({ [K_FILE]: K_BASE });
    await git(repo.path, "init", "-q", "-b", "main");
    await git(repo.path, "add", ".");
    await git(repo.path, "commit", "-q", "-m", "c0");
    headSha = await git(repo.path, "rev-parse", "HEAD");
    // a() edited and staged; b() edited and left unstaged.
    await writeFile(join(repo.path, K_FILE), K_BASE.replace("return 1", "return 10"));
    await git(repo.path, "add", K_FILE);
    await repo.reindex({ [K_FILE]: K_BASE.replace("return 1", "return 10").replace("return 2", "return 20") });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("staged and unstaged edits both count, and base is HEAD", async () => {
    const result = await detectChanges(repo.name);
    expect(result?.base).toBe(headSha);
    expect(result?.changedSymbols.map((s) => s.qualified_name)).toEqual(["p.K.a", "p.K.b"]);
  });
});

describe.skipIf(!RUN)("detect_changes in a repo without commits", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({ [K_FILE]: K_BASE });
    await git(repo.path, "init", "-q", "-b", "main");
    await git(repo.path, "add", ".");
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("diffs against the empty tree instead of throwing", async () => {
    const result = await detectChanges(repo.name);
    const emptyTree = await git(repo.path, "hash-object", "-t", "tree", "/dev/null");
    expect(result?.base).toBe(emptyTree);
    expect(result?.side).toBe("head");
    expect(result?.changedFiles).toEqual([K_FILE]);
    expect(result?.changedSymbols.map((s) => s.qualified_name)).toEqual(["p.K", "p.K.a", "p.K.b"]);
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

    fun lengde(): Int {
        return navn.length
    }
}
`;
const BRUKER = "src/main/kotlin/no/nav/app/Bruker.kt";
const BRUKER_BASE = `package no.nav.app

import no.nav.svc.Service

class Bruker(private val service: Service) {
    fun brukEn(): Int = service.beregn(1)

    fun brukTo(): Int = service.beregn(1, 2)
}
`;
const BEGGE = "src/main/kotlin/no/nav/app/Begge.kt";
const BEGGE_BASE = `package no.nav.app

import no.nav.svc.Service

class Begge(private val service: Service) {
    fun begge(): Int = service.beregn(1) + service.lengde()
}
`;
const INSERTED = "        val x1 = 1\n        val x2 = 2\n        val x3 = 3\n        val x4 = 4\n        val x5 = x1 + x2 + x3 + x4\n";
const SERVICE_INS = SERVICE_BASE.replace("    fun beregn(a: Int, c: Int): Int {\n", `    fun beregn(a: Int, c: Int): Int {\n${INSERTED}`);

/**
 * Review mode on a fixture whose index sits at the PR's base c0 (main). Branches:
 *   ins: five lines inserted inside beregn(Int, Int), the second overload (`@@ -11,0 +12,5 @@`).
 *        Second, so a lookup by qualified name, which takes the first overload, would
 *        report the wrong callers.
 *   fld: only the field `navn` changed
 *   two: beregn(Int) (on its local `val b`) and lengde() changed; Begge.begge calls both
 *   hdr: class header gains a constructor parameter, and lengde()'s body changed
 *   ann: `@Deprecated` inserted directly above beregn(Int, Int) (`@@ -10,0 +11 @@`)
 * The working tree stays on main and the index is never rebuilt.
 */
describe.skipIf(!RUN)("detect_changes review mode against an index of the base", () => {
  let repo: FixtureRepo;
  let c0: string, c1: string;

  const branch = async (name: string, content: string) => {
    await git(repo.path, "checkout", "-q", "-b", name, "main");
    await writeFile(join(repo.path, SERVICE), content);
    await git(repo.path, "commit", "-q", "-am", name);
    const sha = await git(repo.path, "rev-parse", "HEAD");
    await git(repo.path, "checkout", "-q", "main");
    return sha;
  };

  beforeAll(async () => {
    repo = await createFixtureRepo({ [SERVICE]: SERVICE_BASE, [BRUKER]: BRUKER_BASE, [BEGGE]: BEGGE_BASE });
    await git(repo.path, "init", "-q", "-b", "main");
    await git(repo.path, "add", ".");
    await git(repo.path, "commit", "-q", "-m", "c0");
    c0 = await git(repo.path, "rev-parse", "HEAD");
    await repo.reindex(); // records last_commit = c0

    c1 = await branch("ins", SERVICE_INS);
    await branch("fld", SERVICE_BASE.replace(`val navn = "x"`, `val navn = "y"`));
    await branch("two", SERVICE_BASE.replace("val b = a + 1", "val b = a + 2").replace("navn.length", "navn.length + 1"));
    await branch(
      "hdr",
      SERVICE_BASE.replace("class Service {", "class Service(private val id: Int) {").replace("navn.length", "navn.length + 1"),
    );
    await branch("ann", SERVICE_BASE.replace("    fun beregn(a: Int, c: Int): Int {\n", '    @Deprecated("x")\n    fun beregn(a: Int, c: Int): Int {\n'));
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
    expect(qnLines(result?.changedSymbols)).toEqual(["no.nav.svc.Service.beregn:11"]);
    expect(result?.droppedContainers).toEqual(["no.nav.svc.Service"]);
  });

  test("X^! diffs X against its first parent, like the matching a..b", async () => {
    const result = await detectChanges(repo.name, { ref: "ins^!" });
    expect(result?.side).toBe("base");
    expect(result?.base).toBe(c0);
    expect(result?.head).toBe(c1);
    expect(qnLines(result?.changedSymbols)).toEqual(["no.nav.svc.Service.beregn:11"]);
  });

  test("blast radius follows the changed overload by id and carries edge_kind + resolution", async () => {
    const result = await detectChanges(repo.name, { ref: "main...ins" });
    const affected = result!.affectedSymbols.map((a) => `${a.qualified_name}@${a.edge_kind}/${a.resolution}`);
    expect(affected).toContain("no.nav.app.Bruker.brukTo@calls/typed");
    expect(affected.some((a) => a.startsWith("no.nav.app.Bruker.brukEn@"))).toBe(false);
    expect(result!.affectedSymbols.some((a) => a.edge_kind === "imports")).toBe(false);
  });

  test("a field-only change keeps the class", async () => {
    const result = await detectChanges(repo.name, { ref: "main..fld" });
    expect(result?.side).toBe("base");
    expect(result!.changedSymbols.map((s) => s.qualified_name).sort()).toEqual(["no.nav.svc.Service", "no.nav.svc.Service.navn"]);
    expect(result?.droppedContainers).toEqual([]);
  });

  test("a caller of two changed methods lists both in changed_symbols", async () => {
    const result = await detectChanges(repo.name, { ref: "main...two" });
    const begge = result!.affectedSymbols.find((a) => a.qualified_name === "no.nav.app.Begge.begge");
    expect(begge?.changed_symbols).toEqual(["no.nav.svc.Service.beregn", "no.nav.svc.Service.lengde"]);
  });

  test("a function-local val is not reported as a changed property", async () => {
    const result = await detectChanges(repo.name, { ref: "main...two" });
    expect(result!.changedSymbols.filter((s) => s.kind === "property")).toEqual([]);
    expect(qnLines(result?.changedSymbols)).toEqual(["no.nav.svc.Service.beregn:6", "no.nav.svc.Service.lengde:15"]);
  });

  test("a changed class header keeps the class next to the changed method; its imports sort after calls", async () => {
    const result = await detectChanges(repo.name, { ref: "main...hdr" });
    expect(qnLines(result?.changedSymbols)).toEqual(["no.nav.svc.Service:3", "no.nav.svc.Service.lengde:15"]);
    expect(result?.droppedContainers).toEqual([]);
    const kinds = result!.affectedSymbols.map((a) => a.edge_kind);
    expect(kinds).toContain("calls");
    expect(kinds).toContain("imports");
    expect(kinds.slice(kinds.indexOf("imports")).every((k) => k === "imports")).toBe(true);
  });

  test("an annotation inserted directly above a method flags that method", async () => {
    const result = await detectChanges(repo.name, { ref: "main...ann" });
    expect(qnLines(result?.changedSymbols)).toEqual(["no.nav.svc.Service.beregn:11"]);
    expect(result?.droppedContainers).toEqual(["no.nav.svc.Service"]);
  });

  test("side 'head' on an index of the base reads new-side lines against base line numbers, and warns", async () => {
    const result = await detectChanges(repo.name, { ref: "main...ins", side: "head" });
    expect(result?.side).toBe("head");
    // New-side lines 12-16 run past beregn(Int, Int) (11-13) into lengde() on the base index.
    expect(qnLines(result?.changedSymbols)).toEqual([
      "no.nav.svc.Service:3",
      "no.nav.svc.Service.beregn:11",
      "no.nav.svc.Service.lengde:15",
    ]);
    expect(result?.warnings).toHaveLength(1);
    expect(result?.warnings[0]).toContain(`is at ${c0.slice(0, 7)}, but the diff's head is ${c1.slice(0, 7)}`);
  });

  test("a tracer records side, refs, warnings, dropped containers and edge kinds", async () => {
    const tracer = new DetectChangesTracer();
    await detectChanges(repo.name, { ref: "main...ins", tracer });
    const out = tracer.toJSON();
    expect(out.query).toEqual({ repo: repo.name, ref: "main...ins", side: "base" });
    expect(out.refs).toEqual({ base: c0, head: c1 });
    expect(out.droppedContainers).toEqual(["no.nav.svc.Service"]);
    expect(out.affectedByEdgeKind).toEqual({ calls: 1 });
    expect(out.warnings).toEqual([]);

    const forced = new DetectChangesTracer();
    await detectChanges(repo.name, { ref: "main...ins", side: "head", tracer: forced });
    expect(forced.toJSON().warnings).toHaveLength(1);
  });

  test("a trace of a failed ref keeps the repo and ref", async () => {
    const tracer = new DetectChangesTracer();
    await expect(detectChanges(repo.name, { ref: "no-such-ref", tracer })).rejects.toThrow(/no-such-ref/);
    expect(tracer.toJSON().query).toEqual({ repo: repo.name, ref: "no-such-ref" });
  });

  test("the MCP tool returns a bad ref as an error without the server's repo path", async () => {
    const response = await detectChangesTool({ repo: repo.name, ref: "no-such-ref" });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("no-such-ref");
    expect(response.content[0].text).not.toContain(repo.path);
  });
});

/** An index of the head: the fixture's index is rebuilt on branch ins (c1). */
describe.skipIf(!RUN)("detect_changes against an index of the PR's head", () => {
  let repo: FixtureRepo;
  let c0: string, c1: string;

  beforeAll(async () => {
    repo = await createFixtureRepo({ [SERVICE]: SERVICE_BASE, [BRUKER]: BRUKER_BASE });
    await git(repo.path, "init", "-q", "-b", "main");
    await git(repo.path, "add", ".");
    await git(repo.path, "commit", "-q", "-m", "c0");
    c0 = await git(repo.path, "rev-parse", "HEAD");
    await git(repo.path, "checkout", "-q", "-b", "ins");
    await writeFile(join(repo.path, SERVICE), SERVICE_INS);
    await git(repo.path, "commit", "-q", "-am", "ins");
    c1 = await git(repo.path, "rev-parse", "HEAD");
    await repo.reindex(); // last_commit = c1, which is not the base
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("auto mode intersects new-side lines and drops the inserted local vals", async () => {
    const result = await detectChanges(repo.name, { ref: "main...ins" });
    expect(result?.side).toBe("head");
    expect(result?.warnings).toEqual([]);
    expect(qnLines(result?.changedSymbols)).toEqual(["no.nav.svc.Service.beregn:11"]);
  });

  test("forcing side 'base' warns that the index is not at the base", async () => {
    const forced = await detectChanges(repo.name, { ref: "main...ins", side: "base" });
    expect(forced?.warnings).toHaveLength(1);
    expect(forced?.warnings[0]).toContain(`is at ${c1.slice(0, 7)}, but the diff's base is ${c0.slice(0, 7)}`);
  });
});

/**
 * Rename handling with `diff.renames=false` in the repo's config: detect_changes pins
 * rename detection, so a renamed file still diffs as a small edit on its old path.
 */
describe.skipIf(!RUN)("detect_changes on a renamed file", () => {
  let repo: FixtureRepo;
  const BRUKER_NY = "src/main/kotlin/no/nav/app/BrukerNy.kt";
  const NEW_FILE = "src/main/kotlin/no/nav/app/Ny.kt";

  beforeAll(async () => {
    repo = await createFixtureRepo({ [SERVICE]: SERVICE_BASE, [BRUKER]: BRUKER_BASE });
    await git(repo.path, "init", "-q", "-b", "main");
    await git(repo.path, "config", "diff.renames", "false");
    await git(repo.path, "add", ".");
    await git(repo.path, "commit", "-q", "-m", "c0");
    await repo.reindex();
    await git(repo.path, "checkout", "-q", "-b", "mv");
    await git(repo.path, "mv", BRUKER, BRUKER_NY);
    await writeFile(join(repo.path, BRUKER_NY), BRUKER_BASE.replace("service.beregn(1, 2)", "service.beregn(1, 3)"));
    await writeFile(join(repo.path, NEW_FILE), "package no.nav.app\n\nclass Ny\n");
    await git(repo.path, "add", ".");
    await git(repo.path, "commit", "-q", "-m", "mv");
    await git(repo.path, "checkout", "-q", "main");
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("base mode lists the old path, omits the added file, and flags only the edited method", async () => {
    const result = await detectChanges(repo.name, { ref: "main...mv" });
    expect(result?.side).toBe("base");
    expect(result?.changedFiles).toEqual([BRUKER]);
    expect(result?.changedSymbols.map((s) => s.qualified_name)).toEqual(["no.nav.app.Bruker.brukTo"]);
  });
});
