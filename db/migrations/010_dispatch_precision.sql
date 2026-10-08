-- Dispatch precision (EXTRACTOR_VERSION 7; its full re-extract fills every column).

-- is_local: declared inside a callable, initializer, lambda, object literal or anonymous
-- class body rather than directly in its parent container (or at top level): never a
-- member property, never an override. type_params: a class's own type parameter names,
-- in order. param_type_vars: per parameter, the name of an enclosing class's type
-- parameter the parameter is typed with, '*' for the method's own unbounded type
-- parameter, NULL otherwise.
ALTER TABLE ci_symbols
  ADD COLUMN is_local BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN type_params TEXT[],
  ADD COLUMN param_type_vars TEXT[];

-- Per type argument of the clause entry (`Repo<Foo>` → {Foo}): canonical simple name,
-- NULL for a wildcard or a non-path type.
ALTER TABLE ci_inheritance_refs ADD COLUMN type_args TEXT[];

-- The lookup class a calls edge resolved in (the receiver's static type); NULL when
-- unknown or for a top-level or extension function. impact's dispatch step keeps a
-- caller only when the reached method's class can be such a receiver.
ALTER TABLE ci_edges ADD COLUMN receiver_class_id UUID;

-- Each repo class with every ancestor, itself included; rebuilt with the edges.
CREATE TABLE ci_class_ancestors (
  repo_id     UUID NOT NULL REFERENCES ci_repos(id) ON DELETE CASCADE,
  class_id    UUID NOT NULL REFERENCES ci_symbols(id) ON DELETE CASCADE,
  ancestor_id UUID NOT NULL REFERENCES ci_symbols(id) ON DELETE CASCADE,
  PRIMARY KEY (class_id, ancestor_id)
);
CREATE INDEX idx_ci_class_ancestors_ancestor ON ci_class_ancestors (ancestor_id);
CREATE INDEX idx_ci_class_ancestors_repo ON ci_class_ancestors (repo_id);
