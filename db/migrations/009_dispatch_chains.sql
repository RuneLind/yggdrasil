-- Receiver chains and inherited receivers (EXTRACTOR_VERSION 6; its full re-extract fills
-- every column).

-- receiver_site_id: the call site (or navigation step) that this call's receiver is, as in
-- `a.b().c()` or `a.b.c()`; NULL otherwise. is_navigation: a navigation step `a.b` used as
-- a receiver, stored for typing only (method_name holds `b`); it never becomes an edge.
-- receiver_declared: a single-identifier receiver that a local, parameter or member in the
-- file's scope declares, typed or not; an undeclared one may be an inherited property.
ALTER TABLE ci_call_sites
  ADD COLUMN receiver_site_id UUID,
  ADD COLUMN is_navigation BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN receiver_declared BOOLEAN NOT NULL DEFAULT false;

-- `overrides` edges (method → every ancestor method it overrides) are rebuilt with the
-- other resolved edges; impact's dispatch step looks them up by source.
CREATE INDEX IF NOT EXISTS idx_ci_edges_overrides ON ci_edges (source_id) WHERE kind = 'overrides';
