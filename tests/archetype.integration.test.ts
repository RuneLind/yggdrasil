import { describe, test, expect } from "bun:test";
import { analyzeImpact } from "../src/search/impact.ts";

/**
 * Integration smoke test for archetype tagging against a live index.
 *
 * Gated on YGGDRASIL_INTEGRATION_TESTS=1 because it needs:
 *   - a running Postgres with the ci_* schema migrated
 *   - melosys-api indexed (Behandling at minimum)
 *
 * Run with: `YGGDRASIL_INTEGRATION_TESTS=1 bun test tests/archetype.integration.test.ts`
 */
const RUN = process.env.YGGDRASIL_INTEGRATION_TESTS === "1";

describe.skipIf(!RUN)("archetype tagging against real melosys-api index", () => {
  // No closeDb() here: bun runs every test file in one process on one shared pool,
  // so ending it in this file's afterAll failed the integration files that ran after it.

  test("Behandling blast radius gets sensible archetype distribution", async () => {
    const result = await analyzeImpact("no.nav.melosys.domain.Behandling", {
      repo: "melosys-api",
      maxDepth: 2,
    });
    expect(result).not.toBeNull();
    expect(result!.symbol.archetype).toBe("entity");

    // Expect substantial blast radius (hundreds of transitive callers).
    expect(result!.affected.length).toBeGreaterThan(100);

    const counts = result!.archetype_counts;
    expect(counts.test).toBeGreaterThan(0);
    expect(counts.service).toBeGreaterThan(0);
    expect(counts.controller).toBeGreaterThan(0);

    // Every entry must be tagged.
    expect(result!.affected.every((e) => e.archetype)).toBe(true);

    // archetype_counts sums to affected.length (no filter applied here).
    const sum = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
    expect(sum).toBe(result!.affected.length);
  });

  test("archetype_exclude drops the requested archetypes", async () => {
    const full = await analyzeImpact("no.nav.melosys.domain.Behandling", {
      repo: "melosys-api",
      maxDepth: 2,
    });
    const filtered = await analyzeImpact("no.nav.melosys.domain.Behandling", {
      repo: "melosys-api",
      maxDepth: 2,
      archetypeExclude: ["test"],
    });
    expect(full).not.toBeNull();
    expect(filtered).not.toBeNull();

    // Filtered set is strictly smaller (assuming the index has any test callers).
    expect(filtered!.affected.length).toBeLessThan(full!.affected.length);

    // No filtered entry has archetype 'test'.
    expect(filtered!.affected.every((e) => e.archetype !== "test")).toBe(true);

    // archetype_counts on the filtered result still reflects the pre-filter distribution,
    // so callers can see what got dropped.
    expect(filtered!.archetype_counts.test).toBeGreaterThan(0);
  });
});
