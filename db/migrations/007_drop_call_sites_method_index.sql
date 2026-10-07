-- The per-rule rebuild (migration 006, EXTRACTOR_VERSION 3) joins call sites by id and
-- file, never by method_name alone: 0 scans of this index over 3 melosys-api rebuilds.
DROP INDEX IF EXISTS idx_ci_call_sites_method;
