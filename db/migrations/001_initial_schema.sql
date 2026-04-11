-- Yggdrasil Code Intelligence — initial schema
CREATE EXTENSION IF NOT EXISTS vector;

-- Tracked repositories
CREATE TABLE ci_repos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  path        TEXT NOT NULL,
  last_commit TEXT,
  indexed_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexed source files
CREATE TABLE ci_files (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id      UUID NOT NULL REFERENCES ci_repos(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  language     TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(repo_id, path)
);

CREATE INDEX idx_ci_files_repo ON ci_files(repo_id);

-- Extracted symbols
CREATE TABLE ci_symbols (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id        UUID NOT NULL REFERENCES ci_files(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  kind           TEXT NOT NULL,
  parent_id      UUID REFERENCES ci_symbols(id) ON DELETE CASCADE,
  start_line     INT NOT NULL,
  end_line       INT NOT NULL,
  signature      TEXT,
  doc_comment    TEXT,
  visibility     TEXT,
  is_static      BOOLEAN DEFAULT false,
  embedding      vector(384),
  search_vector  TSVECTOR
);

CREATE INDEX idx_ci_symbols_file ON ci_symbols(file_id);
CREATE INDEX idx_ci_symbols_name ON ci_symbols(name);
CREATE INDEX idx_ci_symbols_qualified ON ci_symbols(qualified_name);
CREATE INDEX idx_ci_symbols_kind ON ci_symbols(kind);
CREATE INDEX idx_ci_symbols_embedding ON ci_symbols USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_ci_symbols_search ON ci_symbols USING GIN(search_vector);

-- Auto-update FTS vector on insert/update
CREATE OR REPLACE FUNCTION ci_symbols_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    coalesce(NEW.name, '') || ' ' ||
    coalesce(replace(NEW.qualified_name, '.', ' '), '') || ' ' ||
    coalesce(NEW.doc_comment, '') || ' ' ||
    coalesce(NEW.signature, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ci_symbols_search_trigger
  BEFORE INSERT OR UPDATE ON ci_symbols
  FOR EACH ROW EXECUTE FUNCTION ci_symbols_search_vector_update();

-- Edges between symbols (calls, imports, extends, implements, etc.)
CREATE TABLE ci_edges (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES ci_symbols(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES ci_symbols(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  line      INT,
  UNIQUE(source_id, target_id, kind, line)
);

CREATE INDEX idx_ci_edges_source ON ci_edges(source_id);
CREATE INDEX idx_ci_edges_target ON ci_edges(target_id);
CREATE INDEX idx_ci_edges_kind ON ci_edges(kind);

-- Raw import declarations (intermediate step for resolution)
CREATE TABLE ci_import_map (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id     UUID NOT NULL REFERENCES ci_files(id) ON DELETE CASCADE,
  import_path TEXT NOT NULL,
  alias       TEXT,
  is_wildcard BOOLEAN DEFAULT false
);

CREATE INDEX idx_ci_imports_file ON ci_import_map(file_id);
CREATE INDEX idx_ci_imports_path ON ci_import_map(import_path);

-- Migration tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
