/**
 * Score yggdrasil's incoming-call resolution against an IntelliJ oracle fixture.
 *
 *   bun run eval:callers [fixture.json]     (default: eval/fixtures/melosys-api-callers.json)
 *
 * The fixture is captured with IntelliJ's `analyze_calls` (INCOMING_CALLS, depth 1);
 * see README "Evaluating call resolution". Per symbol, the primary column scores the
 * depth-1 result of `analyzeImpactBySymbolId` (what the `impact` tool ships); the
 * secondary column scores raw incoming `calls` edges. A caller is keyed by
 * (file path, method name), so several usages or overloads of one caller count once.
 * A fixture symbol is matched to one overload by file, parameter count, then the
 * IntelliJ parameter types against ci_symbols.param_types; only when those cannot pick
 * one does the row score the union of the remaining overloads (and say so in a note).
 *
 * Exits 0 on a report, whatever the scores, and when no fixture exists: this is a report,
 * not a gate. Exits 1 when the run itself fails: malformed fixture, repo not indexed, DB error.
 */
import { sql, closeDb } from "../src/db/connection.ts";
import { getRepo } from "../src/db/repos.ts";
import { findSymbolByQualifiedName } from "../src/db/symbols.ts";
import { analyzeImpactBySymbolId } from "../src/search/impact.ts";
import { intellijMethodName, intellijParamCount, intellijParamTypes, declaredParamCount } from "./eval-callers-parse.ts";

interface FixtureCaller {
  signature: string;
  file: string;
  usages?: number;
}

interface FixtureSymbol {
  qualified_name: string;
  intellij_signature?: string;
  file?: string;
  callers?: FixtureCaller[];
  error?: string;
}

interface Fixture {
  repo: string;
  commit?: string;
  captured?: string;
  source?: string;
  symbols: FixtureSymbol[];
}

const DEFAULT_FIXTURE = "eval/fixtures/melosys-api-callers.json";

/** Kotlin test names are stored with their backticks in ci_symbols, not by IntelliJ. */
const stripBackticks = (s: string) => s.replace(/`/g, "");

const isTest = (path: string) => `/${path}`.includes("/src/test/");

const callerKey = (file: string, method: string) => `${file}#${stripBackticks(method)}`;

interface Score {
  expected: Set<string>;
  found: Set<string>;
}

const hits = (s: Score) => [...s.found].filter((k) => s.expected.has(k)).length;
const falsePositives = (s: Score) => s.found.size - hits(s);

const pct = (num: number, den: number) => (den === 0 ? "  -  " : `${((100 * num) / den).toFixed(0).padStart(3)}%`);

/** Same length, and equal at every position where both types are known. */
function paramTypesMatch(want: (string | null)[], have: (string | null)[] | null | undefined): boolean {
  if (!have || have.length !== want.length) return false;
  return want.every((w, i) => w === null || have[i] === null || w === have[i]);
}

function split(keys: Set<string>): { prod: Set<string>; all: Set<string> } {
  return { prod: new Set([...keys].filter((k) => !isTest(k))), all: keys };
}

async function main() {
  const fixturePath = process.argv[2] ?? DEFAULT_FIXTURE;
  const file = Bun.file(fixturePath);
  if (!(await file.exists())) {
    console.log(`No fixture at ${fixturePath}.`);
    console.log(`Capture one with IntelliJ analyze_calls (see README "Evaluating call resolution"), or pass a path.`);
    return;
  }
  const fixture = (await file.json()) as Fixture;

  const repo = await getRepo(fixture.repo);
  if (!repo) {
    console.error(`Repo "${fixture.repo}" is not indexed. Run \`bun run index <path>\` first.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Fixture:  ${fixturePath} (${fixture.symbols.length} symbols, commit ${fixture.commit ?? "?"}, captured ${fixture.captured ?? "?"})`);
  console.log(`Index:    ${repo.name} last_commit=${repo.last_commit ?? "?"} indexed_at=${repo.indexed_at?.toISOString() ?? "?"}`);
  if (fixture.commit && !repo.last_commit?.startsWith(fixture.commit)) {
    console.log(`WARNING:  index last_commit does not start with fixture commit ${fixture.commit}; scores mix two code states.`);
  }
  console.log("");

  const rows: string[][] = [];
  const totals = {
    impact: { prod: { tp: 0, exp: 0, found: 0 }, all: { tp: 0, exp: 0, found: 0 } },
    edges: { prod: { tp: 0, exp: 0, found: 0 }, all: { tp: 0, exp: 0, found: 0 } },
  };
  let excludedTotal = 0;
  const notes: string[] = [];

  for (const fs of fixture.symbols) {
    const wantParams = fs.intellij_signature ? intellijParamCount(fs.intellij_signature) : null;
    // Overloads appear as separate fixture entries; the arity tells their rows apart.
    const label = fs.qualified_name.split(".").slice(-2).join(".") + (wantParams !== null ? `/${wantParams}` : "");
    if (fs.error) {
      notes.push(`${label}: skipped, fixture error: ${fs.error}`);
      continue;
    }

    // Expected callers: functions only. Property initializers and init blocks have no
    // enclosing method in yggdrasil, so they could never be matched.
    const callers = fs.callers ?? [];
    const functionCallers = callers.filter((c) => c.signature.includes("("));
    const excluded = callers.length - functionCallers.length;
    excludedTotal += excluded;
    const expected = new Set(functionCallers.map((c) => callerKey(c.file, intellijMethodName(c.signature))));

    // Resolve to yggdrasil symbol ids: narrow an overload set by file, by parameter
    // count, then by parameter types; if that still leaves several, score their union.
    let candidates = await findSymbolByQualifiedName(fs.qualified_name, fixture.repo);
    if (fs.file && candidates.some((c) => c.file_path === fs.file)) {
      candidates = candidates.filter((c) => c.file_path === fs.file);
    } else if (fs.file && candidates.length > 0) {
      notes.push(`${label}: file ${fs.file} matches no candidate, not narrowed by file`);
    }
    if (candidates.length > 1 && wantParams !== null) {
      const byCount = candidates.filter((c) => declaredParamCount(c.min_params, c.max_params) === wantParams);
      if (byCount.length > 0) candidates = byCount;
    }
    const wantTypes = fs.intellij_signature ? intellijParamTypes(fs.intellij_signature) : null;
    if (candidates.length > 1 && wantTypes !== null) {
      // to_json: postgres.js parses a NULL array element as the string "NULL".
      const stored = new Map(
        (await sql<{ id: string; param_types: (string | null)[] | null }[]>`
          SELECT id, to_json(param_types) AS param_types FROM ci_symbols WHERE id = ANY(${candidates.map((c) => c.id)})`
        ).map((r) => [r.id, r.param_types]),
      );
      const byTypes = candidates.filter((c) => paramTypesMatch(wantTypes, stored.get(c.id)));
      if (byTypes.length > 0) candidates = byTypes;
      else notes.push(`${label}: IntelliJ parameter types match no overload`);
    }
    if (candidates.length === 0) notes.push(`${label}: not found in the index`);
    else if (candidates.length > 1) notes.push(`${label}: ${candidates.length} overloads not disambiguated, scored as union`);
    const ids = candidates.map((c) => c.id);

    const impactFound = new Set<string>();
    for (const id of ids) {
      const impact = await analyzeImpactBySymbolId(id, { maxDepth: 1 });
      for (const a of impact?.affected ?? []) impactFound.add(callerKey(a.file_path, a.name));
    }

    const edgeRows = ids.length
      ? await sql<{ name: string; file_path: string }[]>`
          SELECT s.name, f.path AS file_path
          FROM ci_edges e
          JOIN ci_symbols s ON s.id = e.source_id
          JOIN ci_files f ON f.id = s.file_id
          WHERE e.target_id = ANY(${ids}) AND e.kind = 'calls'
        `
      : [];
    const edgeFound = new Set(edgeRows.map((r) => callerKey(r.file_path, r.name)));

    const exp = split(expected);
    const imp = split(impactFound);
    const edg = split(edgeFound);
    const impProd: Score = { expected: exp.prod, found: imp.prod };
    const impAll: Score = { expected: exp.all, found: imp.all };
    const edgProd: Score = { expected: exp.prod, found: edg.prod };
    const edgAll: Score = { expected: exp.all, found: edg.all };

    for (const [bucket, s] of [
      [totals.impact.prod, impProd], [totals.impact.all, impAll],
      [totals.edges.prod, edgProd], [totals.edges.all, edgAll],
    ] as const) {
      bucket.tp += hits(s);
      bucket.exp += s.expected.size;
      bucket.found += s.found.size;
    }

    rows.push([
      label + (candidates.length > 1 ? ` (x${candidates.length})` : candidates.length === 0 ? " (missing)" : ""),
      String(exp.prod.size),
      String(hits(impProd)),
      pct(hits(impProd), exp.prod.size),
      String(falsePositives(impProd)),
      String(exp.all.size),
      pct(hits(impAll), exp.all.size),
      String(falsePositives(impAll)),
      pct(hits(edgProd), exp.prod.size),
      pct(hits(edgAll), exp.all.size),
      String(excluded),
    ]);
  }

  const header = ["symbol", "exp prod", "found prod", "recall prod", "FP prod", "exp all", "recall all", "FP all", "edges R prod", "edges R all", "non-fn excl"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  console.log("Primary: impact depth 1. Secondary (edges R): raw incoming calls edges.");
  console.log(fmt(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(fmt(r));
  console.log("");

  const line = (name: string, t: { tp: number; exp: number; found: number }) =>
    `  ${name.padEnd(16)} recall ${pct(t.tp, t.exp)} (${t.tp}/${t.exp})   precision ${pct(t.tp, t.found)} (${t.tp}/${t.found})`;
  console.log("Totals (impact depth 1):");
  console.log(line("production", totals.impact.prod));
  console.log(line("all callers", totals.impact.all));
  console.log("Totals (raw calls edges):");
  console.log(line("production", totals.edges.prod));
  console.log(line("all callers", totals.edges.all));
  console.log(`Excluded non-function callers (initializers, init blocks): ${excludedTotal}`);

  if (notes.length > 0) {
    console.log("");
    console.log("Notes:");
    for (const n of notes) console.log(`  ${n}`);
  }
}

try {
  await main();
} catch (e) {
  console.error("eval-callers failed:", e);
  process.exitCode = 1;
} finally {
  await closeDb();
}
