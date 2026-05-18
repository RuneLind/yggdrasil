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

const EXT_RE = /\.(java|kt|kts|ts|tsx|js|jsx)$/;
const TYPE_LEVEL_KINDS = new Set(["class", "interface", "enum", "object"]);

function stripExt(basename: string): string {
  return basename.replace(EXT_RE, "");
}

function classNameFromPath(filePath: string): string {
  const basename = filePath.split("/").pop() ?? "";
  return stripExt(basename);
}

/**
 * Run name-suffix rules against a single candidate string. Returns the archetype or
 * null if no rule matched. Callers stack multiple candidates (symbol name, parent
 * class from qualified_name, file basename) so Kotlin multi-decl files still get
 * classified correctly.
 */
function tryArchetypeFromName(candidate: string): Archetype | null {
  if (!candidate) return null;

  // Test variants (TestBuilder/TestFixture before Builder so they don't get demoted).
  if (/(Test|IT|Spec|TestBuilder|TestFixture|TestData)$/.test(candidate)) return "test";

  if (/Builder$/.test(candidate)) return "builder";

  if (/(Controller|Resource|Endpoint|RestController)$/.test(candidate)) return "controller";

  // Repository before Service so e.g. "SakerForFooRepository" doesn't fall through.
  if (/(Repository|Repo|Dao)$/.test(candidate)) return "repository";

  if (/(Service|ServiceImpl|UseCase|Handler)$/.test(candidate)) return "service";

  if (/(Mapper|Converter|Translator|Marshaller|Unmarshaller)$/.test(candidate)) return "mapper";

  if (/(Dto|DTO|Request|Response|Payload|Command|Query|Event|Message)$/.test(candidate)) return "dto";

  if (/(Config|Configuration|Properties|Settings)$/.test(candidate)) return "config";

  if (/(Util|Utils|Helper|Helpers)$/.test(candidate)) return "util";

  if (/(Exception|Error)$/.test(candidate)) return "exception";

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
  kind: string;
}): Archetype {
  const { file_path, qualified_name, name, kind } = input;

  // 1. Path-based test detection — wins over everything else.
  if (/\/(test|tests|testFixtures)\//i.test(file_path)) return "test";
  if (/\/__tests__\//i.test(file_path)) return "test";

  // 2. Build the candidate list.
  const segments = qualified_name.split(".");
  const lastSeg = segments[segments.length - 1] ?? "";
  const parentSeg = segments[segments.length - 2] ?? "";
  const basename = classNameFromPath(file_path);

  const candidates: string[] = TYPE_LEVEL_KINDS.has(kind)
    ? [name, lastSeg, basename]
    : [parentSeg, basename, lastSeg];

  // 3. Name-suffix rules against each candidate; first match wins.
  for (const cand of candidates) {
    const hit = tryArchetypeFromName(cand);
    if (hit) return hit;
  }

  // 4. Path-based fallback for naked domain classes (entities, dtos in dedicated packages).
  if (/\/(dto|payload)\//i.test(file_path)) return "dto";
  if (/\/(entity|entities|domain)\//i.test(file_path)) return "entity";
  if (/\/(repository|repositories|dao)\//i.test(file_path)) return "repository";
  if (/\/(controller|controllers|rest)\//i.test(file_path)) return "controller";
  if (/\/(service|services)\//i.test(file_path)) return "service";
  if (/\/(mapper|mappers)\//i.test(file_path)) return "mapper";
  if (/\/(config|configuration)\//i.test(file_path)) return "config";
  if (/\/(util|utils|helpers)\//i.test(file_path)) return "util";
  if (/\/(exception|exceptions|errors)\//i.test(file_path)) return "exception";

  return "other";
}

/** Tag-and-filter helper used by impact/detect_changes/analyze_ticket. */
export function tagWithArchetype<T extends { name: string; qualified_name: string; file_path: string; kind: string }>(
  entries: T[],
): (T & { archetype: Archetype })[] {
  return entries.map((e) => ({ ...e, archetype: classifyArchetype(e) }));
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
