-- Overload narrowing, visibility and extension receivers (EXTRACTOR_VERSION 4; its full
-- re-extract fills every column).

-- Callables: one entry per parameter. param_types holds canonical simple names (boxed
-- twins folded: Long/long/java.lang.Long → long), NULL for a type parameter, array,
-- function type or vararg. extension_receiver: a Kotlin extension function's receiver
-- type, normalized like receiver_type.
ALTER TABLE ci_symbols
  ADD COLUMN param_types TEXT[],
  ADD COLUMN param_names TEXT[],
  ADD COLUMN extension_receiver TEXT;

-- One entry per argument: arg_types like param_types plus '#int' for an integer literal
-- without a suffix, NULL when unknown; arg_names: the parameter name of a Kotlin named
-- argument, NULL when no argument is named. implicit_receiver_type: the declared type of
-- the receiver of the enclosing Kotlin with/apply/run lambda (receiverless calls only).
ALTER TABLE ci_call_sites
  ADD COLUMN arg_types TEXT[],
  ADD COLUMN arg_names TEXT[],
  ADD COLUMN implicit_receiver_type TEXT;
