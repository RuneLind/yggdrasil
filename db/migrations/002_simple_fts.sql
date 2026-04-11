-- Switch FTS from 'english' to 'simple' config.
-- The codebase uses Norwegian identifiers (behandling, trygdeavgift, saksbehandler)
-- which the English stemmer mangles. 'simple' does exact token matching which is
-- better for mixed-language code search.

CREATE OR REPLACE FUNCTION ci_symbols_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('simple',
    coalesce(NEW.name, '') || ' ' ||
    coalesce(replace(NEW.qualified_name, '.', ' '), '') || ' ' ||
    coalesce(NEW.doc_comment, '') || ' ' ||
    coalesce(NEW.signature, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Rebuild all search vectors with the new config
UPDATE ci_symbols SET search_vector = to_tsvector('simple',
  coalesce(name, '') || ' ' ||
  coalesce(replace(qualified_name, '.', ' '), '') || ' ' ||
  coalesce(doc_comment, '') || ' ' ||
  coalesce(signature, '')
);
