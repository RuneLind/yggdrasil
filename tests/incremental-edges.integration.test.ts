import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
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
  // Each test builds its own repo, so none depends on another's state or order.
  let repo: FixtureRepo | undefined;

  const signature = async (r: FixtureRepo) => {
    const [row] = await sql<{ signature: string }[]>`
      SELECT s.signature FROM ci_symbols s
      JOIN ci_files f ON f.id = s.file_id JOIN ci_repos r ON r.id = f.repo_id
      WHERE r.name = ${r.name} AND s.qualified_name = 'p.B.helper'
    `;
    return row?.signature;
  };
  const storedVersion = async (r: FixtureRepo) => {
    const [row] = await sql<{ extractor_version: number }[]>`
      SELECT extractor_version FROM ci_repos WHERE name = ${r.name}`;
    return row.extractor_version;
  };
  const staleSignatures = (r: FixtureRepo) => sql`
    UPDATE ci_symbols SET signature = 'STALE' WHERE file_id IN (
      SELECT f.id FROM ci_files f JOIN ci_repos r ON r.id = f.repo_id WHERE r.name = ${r.name})`;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
  });

  test("the first index stamps the current version", async () => {
    repo = await createFixtureRepo({ "src/main/java/p/B.java": B_V1 });
    expect(await storedVersion(repo)).toBe(EXTRACTOR_VERSION);
  });

  test("matching version: an unchanged file keeps its stored rows", async () => {
    repo = await createFixtureRepo({ "src/main/java/p/B.java": B_V1 });
    await staleSignatures(repo);
    expect((await repo.reindex()).changedFiles).toBe(0);
    expect(await signature(repo)).toBe("STALE");
  });

  test("stale version: an unchanged file is re-extracted and the version updated", async () => {
    repo = await createFixtureRepo({ "src/main/java/p/B.java": B_V1 });
    await staleSignatures(repo);
    await sql`UPDATE ci_repos SET extractor_version = ${EXTRACTOR_VERSION - 1} WHERE name = ${repo.name}`;
    expect((await repo.reindex()).changedFiles).toBe(1);
    expect(await signature(repo)).toBe("public static int helper()");
    expect(await storedVersion(repo)).toBe(EXTRACTOR_VERSION);
  });
});
