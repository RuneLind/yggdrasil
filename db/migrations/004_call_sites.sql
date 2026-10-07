-- Store extracted call sites and inheritance references so Phase 2 can rebuild every
-- calls/extends/implements edge in the repo from the DB. Before this, edges were
-- resolved from the in-memory extraction of changed files only, so an incremental
-- reindex of file B dropped the edges from unchanged files into B (they cascade with
-- B's symbols) and never recreated them.

-- NULL until the first index run after this migration, which forces a full re-extract.
ALTER TABLE ci_repos ADD COLUMN extractor_version INT;

-- One row per call expression, owned by its innermost enclosing method, function or
-- constructor. Call sites outside one are not stored.
CREATE TABLE ci_call_sites (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id          UUID NOT NULL REFERENCES ci_files(id) ON DELETE CASCADE,
  source_symbol_id UUID NOT NULL REFERENCES ci_symbols(id) ON DELETE CASCADE,
  receiver         TEXT,
  receiver_kind    TEXT NOT NULL,
  method_name      TEXT NOT NULL,
  arg_count        INT,
  line             INT NOT NULL
);

CREATE INDEX idx_ci_call_sites_file ON ci_call_sites(file_id);
CREATE INDEX idx_ci_call_sites_source ON ci_call_sites(source_symbol_id);
CREATE INDEX idx_ci_call_sites_method ON ci_call_sites(method_name);

-- One row per extends/implements clause entry, owned by the declaring container.
CREATE TABLE ci_inheritance_refs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id          UUID NOT NULL REFERENCES ci_files(id) ON DELETE CASCADE,
  source_symbol_id UUID NOT NULL REFERENCES ci_symbols(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  type_name        TEXT NOT NULL
);

CREATE INDEX idx_ci_inheritance_refs_file ON ci_inheritance_refs(file_id);
CREATE INDEX idx_ci_inheritance_refs_source ON ci_inheritance_refs(source_symbol_id);
