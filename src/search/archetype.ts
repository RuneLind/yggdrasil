/**
 * Archetype classification for symbols — name + path heuristics.
 *
 * Used to label blast-radius results so the LLM (or a future structured filter) can
 * trim transitive callers down to the ones that actually matter for a given change.
 *
 * No annotation data is stored on ci_symbols, so this is suffix/path-only. Bias is
 * Melosys-style conventions (Service/Mapper/Dto suffix, /test/ paths). For other
 * stacks the rules can be extended without re-indexing.
 */

import { CONTAINER_KINDS, type SymbolKind } from "../indexer/symbol-extractor.ts";

export const ARCHETYPES = [
  "test",
  "builder",
  "controller",
  "service",
  "mapper",
  "repository",
  "entity",
  "dto",
  "config",
  "util",
  "exception",
  "other",
] as const;

export type Archetype = (typeof ARCHETYPES)[number];

const EXT_RE = /\.(java|kt|ts|tsx)$/;

const TEST_PATH_RE = /\/(test|tests|testFixtures|__tests__)\//i;

// Suffix rules. Order matters within tryArchetypeFromName because a single candidate
// is matched against each in turn; Repository sits ahead of Service so a name like
// "SakerForFooRepository" doesn't get demoted by the /service/ package match later.
const NAME_RULES: Array<readonly [RegExp, Archetype]> = [
  [/(Test|IT|Spec|TestBuilder|TestFixture|TestData)$/, "test"],
  [/Builder$/, "builder"],
  [/(Controller|Resource|Endpoint|RestController)$/, "controller"],
  [/(Repository|Repo|Dao)$/, "repository"],
  [/(Service|ServiceImpl|UseCase|Handler)$/, "service"],
  [/(Mapper|Converter|Translator|Marshaller|Unmarshaller)$/, "mapper"],
  [/(Dto|DTO|Request|Response|Payload|Command|Query|Event|Message)$/, "dto"],
  [/(Config|Configuration|Properties|Settings)$/, "config"],
  [/(Util|Utils|Helper|Helpers)$/, "util"],
  [/(Exception|Error)$/, "exception"],
];

// Path-fallback rules for naked domain classes (entities, dtos in dedicated packages).
const PATH_RULES: Array<readonly [RegExp, Archetype]> = [
  [/\/(dto|payload)\//i, "dto"],
  [/\/(entity|entities|domain)\//i, "entity"],
  [/\/(repository|repositories|dao)\//i, "repository"],
  [/\/(controller|controllers|rest)\//i, "controller"],
  [/\/(service|services)\//i, "service"],
  [/\/(mapper|mappers)\//i, "mapper"],
  [/\/(config|configuration)\//i, "config"],
  [/\/(util|utils|helpers)\//i, "util"],
  [/\/(exception|exceptions|errors)\//i, "exception"],
];

function classNameFromPath(filePath: string): string {
  const basename = filePath.split("/").pop() ?? "";
  return basename.replace(EXT_RE, "");
}

function tryArchetypeFromName(candidate: string): Archetype | null {
  if (!candidate) return null;
  for (const [re, archetype] of NAME_RULES) {
    if (re.test(candidate)) return archetype;
  }
  return null;
}

/**
 * Classify a symbol into an archetype based on its name, qualified name, file path, and kind.
 *
 * Order matters: test wins over everything (a TodoService under /test/ is a fixture, not a service).
 *
 * Candidate strategy:
 *   - Type-level symbols (class/interface/enum/object): check own name, then qualified_name
 *     last segment, then file basename.
 *   - Methods/properties/functions: check parent segment of qualified_name (the containing
 *     type) first, then file basename. The symbol's own name (e.g. `save`) is uninformative.
 */
export function classifyArchetype(input: {
  name: string;
  qualified_name: string;
  file_path: string;
  kind: SymbolKind | string;
}): Archetype {
  const { file_path, qualified_name, name, kind } = input;

  if (TEST_PATH_RE.test(file_path)) return "test";

  const segments = qualified_name.split(".");
  const lastSeg = segments[segments.length - 1] ?? "";
  const parentSeg = segments[segments.length - 2] ?? "";
  const basename = classNameFromPath(file_path);

  const candidates: string[] = CONTAINER_KINDS.has(kind)
    ? [name, lastSeg, basename]
    : [parentSeg, basename, lastSeg];

  for (const cand of candidates) {
    const hit = tryArchetypeFromName(cand);
    if (hit) return hit;
  }

  for (const [re, archetype] of PATH_RULES) {
    if (re.test(file_path)) return archetype;
  }

  return "other";
}

/** Filter entries by excluding archetypes. Empty/undefined list returns input unchanged. */
export function filterByArchetypeExclude<T extends { archetype: Archetype }>(
  entries: T[],
  exclude: Archetype[] | undefined,
): T[] {
  if (!exclude || exclude.length === 0) return entries;
  const set = new Set(exclude);
  return entries.filter((e) => !set.has(e.archetype));
}
