-- ci_symbols.parent_id cascades on delete; without an index each deleted symbol
-- seq-scans ci_symbols for children, which makes the extractor-version gate's
-- repo-wide delete take seconds per repo.
CREATE INDEX IF NOT EXISTS idx_ci_symbols_parent ON ci_symbols(parent_id);
