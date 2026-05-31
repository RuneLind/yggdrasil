import { describe, test, expect } from "bun:test";
import { validateEmbedding, EMBEDDING_DIMS } from "../src/embeddings.ts";

/**
 * Regression guard for the "EMBEDDING_DIMS is dead config" footgun: the DB column is a
 * fixed-width pgvector, so a vector of the wrong length must never reach updateSymbolEmbedding.
 * validateEmbedding enforces the contract (returns null on mismatch). It logs to stderr on
 * the mismatch cases below — that console.error is expected, not a test failure.
 */
describe("validateEmbedding", () => {
  test("passes a correctly-sized vector through unchanged", () => {
    const vec = Array.from({ length: EMBEDDING_DIMS }, (_, i) => i / EMBEDDING_DIMS);
    expect(validateEmbedding(vec)).toBe(vec);
  });

  test("rejects an over-wide vector", () => {
    expect(validateEmbedding(new Array(EMBEDDING_DIMS + 1).fill(0))).toBeNull();
  });

  test("rejects an under-wide vector", () => {
    expect(validateEmbedding(new Array(EMBEDDING_DIMS - 1).fill(0))).toBeNull();
  });

  test("passes null through as null", () => {
    expect(validateEmbedding(null)).toBeNull();
  });
});
