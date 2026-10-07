import { describe, test, expect } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { runEval, tempFixture } from "./helpers/run-eval.ts";

/** Exit codes of `bun run eval:callers` that need no database. */
describe("eval-callers exit code", () => {
  test("no fixture → 0 (nothing to report is not a failure)", async () => {
    const r = await runEval(join(tmpdir(), `yggdrasil-no-such-fixture-${crypto.randomUUID()}.json`));
    expect(r.stdout).toContain("No fixture at");
    expect(r.code).toBe(0);
  });

  test("malformed JSON → 1", async () => {
    const r = await runEval(await tempFixture("{ not json"));
    expect(r.code).toBe(1);
  });
});
