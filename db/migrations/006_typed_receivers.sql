-- Typed receiver resolution. Each column is filled at extraction, so the first index run
-- after this migration needs EXTRACTOR_VERSION 3's full re-extract to populate it.

-- Declared type of the receiver variable (parameter, local, field, constructor property),
-- normalized: no generic arguments, no nullable `?`. NULL when the receiver is not a
-- variable the extractor could find in scope.
ALTER TABLE ci_call_sites ADD COLUMN receiver_type TEXT;

-- From the AST, not from `signature` (cut at `{`, at the first line, at 200 chars).
-- declared_type: a property's type or a method's return type. min_params: parameters
-- without a default; max_params: all parameters, NULL for a vararg.
ALTER TABLE ci_symbols
  ADD COLUMN declared_type TEXT,
  ADD COLUMN min_params INT,
  ADD COLUMN max_params INT;

ALTER TABLE ci_files ADD COLUMN package_name TEXT;

-- How a `calls` edge was resolved: local (no receiver or `this`), static (class-name
-- receiver), typed (variable receiver with a declared type). NULL for other edge kinds.
ALTER TABLE ci_edges ADD COLUMN resolution TEXT;
