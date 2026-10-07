import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "./helpers/fixture-repo.ts";
import { sql } from "../src/db/connection.ts";
import { EXTRACTOR_VERSION } from "../src/indexer/index.ts";

/**
 * G3: an incremental reindex of file B must keep the edges from unchanged files into B.
 * Changing B deletes B's symbols, and ci_edges cascades on them; Phase 2 used to
 * re-resolve edges only for the changed files, so A's `calls` edge and C's `extends`
 * edge into B were lost.
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/incremental-edges.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

const B_V1 = `package p;

public class B {
    public static int helper() { return 1; }
}
`;

const B_V2 = `package p;

public class B {
    public static int other() { return 2; }

    public static int helper() { return 1; }
}
`;

describe.skipIf(!RUN)("incremental reindex keeps incoming cross-file edges", () => {
  let repo: FixtureRepo;
  let before: { calls: string[]; extends: string[] };
  let changedFiles: number;

  const sources = async (target: string, kind: string) =>
    (await repo.edgesTo(target, kind)).map((e) => e.source);

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/java/p/B.java": B_V1,
      "src/main/java/p/A.java": `package p;

public class A {
    int run() { return B.helper(); }
}
`,
      "src/main/java/p/C.java": `package p;

public class C extends B {
}
`,
    });
    before = { calls: await sources("p.B.helper", "calls"), extends: await sources("p.B", "extends") };
    changedFiles = (await repo.reindex({ "src/main/java/p/B.java": B_V2 })).changedFiles;
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  // Control: the full index resolves both edges, and the reindex touched only B.
  test("initial index has both edges and the reindex changes only B", () => {
    expect(before).toEqual({ calls: ["p.A.run"], extends: ["p.C"] });
    expect(changedFiles).toBe(1);
  });

  test("calls edge from unchanged A into changed B survives", async () => {
    expect(await sources("p.B.helper", "calls")).toEqual(["p.A.run"]);
  });

  test("extends edge from unchanged C into changed B survives", async () => {
    expect(await sources("p.B", "extends")).toEqual(["p.C"]);
  });
});

/**
 * G6: a plain `indexRepo` re-extracts only files whose content hash changed, so an
 * index silently keeps rows from an older extractor. A ci_repos.extractor_version that
 * differs from EXTRACTOR_VERSION must force re-extraction of unchanged files.
 */
describe.skipIf(!RUN)("extractor version gate", () => {
  let repo: FixtureRepo;

  const signature = async () => {
    const [row] = await sql<{ signature: string }[]>`
      SELECT s.signature FROM ci_symbols s
      JOIN ci_files f ON f.id = s.file_id JOIN ci_repos r ON r.id = f.repo_id
      WHERE r.name = ${repo.name} AND s.qualified_name = 'p.B.helper'
    `;
    return row?.signature;
  };

  beforeAll(async () => {
    repo = await createFixtureRepo({ "src/main/java/p/B.java": B_V1 });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("the first index stamps the current version", async () => {
    const [row] = await sql<{ extractor_version: number }[]>`
      SELECT extractor_version FROM ci_repos WHERE name = ${repo.name}`;
    expect(row.extractor_version).toBe(EXTRACTOR_VERSION);
  });

  test("matching version: an unchanged file keeps its stored rows", async () => {
    await sql`UPDATE ci_symbols SET signature = 'STALE' WHERE file_id IN (
      SELECT f.id FROM ci_files f JOIN ci_repos r ON r.id = f.repo_id WHERE r.name = ${repo.name})`;
    expect((await repo.reindex()).changedFiles).toBe(0);
    expect(await signature()).toBe("STALE");
  });

  test("stale version: an unchanged file is re-extracted and the version updated", async () => {
    await sql`UPDATE ci_repos SET extractor_version = ${EXTRACTOR_VERSION - 1} WHERE name = ${repo.name}`;
    expect((await repo.reindex()).changedFiles).toBe(1);
    expect(await signature()).toBe("public static int helper()");
    const [row] = await sql<{ extractor_version: number }[]>`
      SELECT extractor_version FROM ci_repos WHERE name = ${repo.name}`;
    expect(row.extractor_version).toBe(EXTRACTOR_VERSION);
  });
});

/** A call site produces an edge from its innermost enclosing callable only. */
describe.skipIf(!RUN)("innermost owner of a call site", () => {
  let repo: FixtureRepo;

  beforeAll(async () => {
    repo = await createFixtureRepo({
      "src/main/java/p/B.java": B_V1,
      "src/main/kotlin/p/K.kt": `package p

class K {
    fun outer() {
        fun inner() {
            B.helper()
        }
        inner()
    }
}
`,
    });
  });

  afterAll(async () => {
    await repo?.cleanup();
  });

  test("the call in a local function links from the local function, not its host", async () => {
    expect((await repo.edgesTo("p.B.helper", "calls")).map((e) => e.source)).toEqual(["p.K.inner"]);
  });
});
