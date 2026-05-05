-- Partial index to make the embed-loop drain query (SELECT … WHERE embedding IS NULL)
-- O(remaining work) instead of O(repo size). The HNSW index on `embedding` itself
-- doesn't help NULL filtering, and once coverage approaches 100% a full scan to find
-- the last few stragglers becomes wasteful.

CREATE INDEX IF NOT EXISTS idx_ci_symbols_embedding_null
  ON ci_symbols (file_id)
  WHERE embedding IS NULL;
