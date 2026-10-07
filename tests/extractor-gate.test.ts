import { describe, test, expect } from "bun:test";
import { isExtractorVersionStale } from "../src/indexer/index.ts";

describe("isExtractorVersionStale", () => {
  test("a repo never gated (NULL) is stale", () => {
    expect(isExtractorVersionStale(null, 2)).toBe(true);
  });

  test("an older or newer version is stale; the same version is not", () => {
    expect(isExtractorVersionStale(1, 2)).toBe(true);
    expect(isExtractorVersionStale(3, 2)).toBe(true);
    expect(isExtractorVersionStale(2, 2)).toBe(false);
  });

  // A missing column (migration 004 not applied) must not read as "stale": the stale
  // path deletes every file of the repo before it touches ci_call_sites.
  test("a missing extractor_version column throws and names the migration command", () => {
    expect(() => isExtractorVersionStale(undefined, 2)).toThrow(/bun run db:migrate/);
  });
});
