import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { hybridSearch } from "../search/hybrid-search.ts";
import { analyzeImpact } from "../search/impact.ts";
import { ARCHETYPES } from "../search/archetype.ts";
import { detectChanges, DetectChangesError } from "../search/detect-changes.ts";
import { analyzeTicket } from "../search/analyze-ticket.ts";
import { findSymbolByQualifiedName, getSymbolsByFile } from "../db/symbols.ts";
import { getIncomingEdges, getOutgoingEdges } from "../db/edges.ts";
import { getRepo, listRepos, listReposWithStats } from "../db/repos.ts";
import { sql } from "../db/connection.ts";
import {
  SearchTracer,
  ImpactTracer,
  PatternTracer,
  DetectChangesTracer,
  shouldTrace,
} from "../tracing/trace.ts";
import { defaultTraceStore, pointerModeEnabled, tracePointerLine } from "../tracing/trace-store.ts";

const PORT = parseInt(process.env.YGGDRASIL_PORT ?? "9130", 10);

/** Construct a tracer iff tracing is requested and pointer mode is enabled (the only supported wire format). */
function gateTracer<T>(traceArg: boolean | undefined, ctor: () => T): T | undefined {
  return shouldTrace(traceArg) && pointerModeEnabled() ? ctor() : undefined;
}

/** Stash a trace and return the pointer line to append to a tool's text output. */
function maybeAppendTracePointer(tracer: { toJSON(): unknown } | undefined): string {
  if (!tracer) return "";
  const traceId = defaultTraceStore().put(tracer.toJSON());
  return tracePointerLine(traceId, PORT);
}

/** JSON-stringify the payload, append the optional trace pointer line, wrap as a text response. */
function jsonResponseWithTrace(data: unknown, tracer: { toJSON(): unknown } | undefined) {
  return textResponse(JSON.stringify(data, null, 2) + maybeAppendTracePointer(tracer));
}

/**
 * Resolve a caller-supplied repo-relative path against the repo root, refusing any
 * path that *lexically* escapes the root (`../../etc/passwd`, absolute paths, `..`
 * climbs, sibling-dir prefix collisions). Returns null on escape so the tool can reject
 * without touching the file. Containment is checked on the normalized absolute path.
 *
 * NOTE: this is lexical only — it does NOT resolve symlinks, so a symlink committed
 * inside the repo that points outside it would still pass. Closing that needs a
 * realpath check (tracked as a follow-up); the reported caller-input traversal is closed.
 */
export function resolveSourcePath(repoPath: string, filePath: string): string | null {
  // A NUL byte passes the lexical containment check but makes Bun.file()/fs throw
  // (TypeError: must be a string without null bytes) instead of returning cleanly.
  if (filePath.includes("\0")) return null;
  const root = resolve(repoPath);
  const full = resolve(root, filePath);
  // Must be strictly inside root (root + separator). Equality (full === root) means the
  // path resolved to the repo dir itself — not a file — so reject that too.
  if (!full.startsWith(root + sep)) return null;
  return full;
}

/**
 * Convert a simple glob pattern to a SQL LIKE pattern.
 *   *   → %  (within a path segment)
 *   **  → %  (any path depth)
 *   ?   → _  (single char)
 * A `**​/` collapses its trailing separator too, so `**​/*Test*` → `%Test%` rather than
 * `%/%Test%` — the latter would never match a root-level `FooTest.kt`. Literal `%`/`_`
 * are escaped first, and runs of adjacent wildcards collapse to a single `%`.
 */
export function globToLike(glob: string): string {
  // Map every wildcard to a NUL placeholder so a wildcard-`%` can't be conflated with
  // an escaped literal `%` (`\%`) when we collapse adjacent wildcards at the end.
  const W = "\x00";
  return glob
    .replace(/\\/g, "\\\\")      // escape literal backslashes first (LIKE's escape char);
                                 // otherwise a trailing `\` is a dangling escape (Postgres
                                 // 22025 error) and an interior `\` silently drops a char
    .replace(/%/g, "\\%")        // escape existing SQL wildcards
    .replace(/_/g, "\\_")
    .replace(/\*\*\//g, W)       // **/ absorbs the path separator
    .replace(/\*\*/g, W)         // bare ** → any depth
    .replace(/\*/g, W)           // * → within a segment
    .replace(/\x00+/g, "%")      // collapse runs of wildcards to one %
    .replace(/\?/g, "_");        // ? → single char
}
const TOOL_COUNT = 10;

function jsonResponse(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function createServer(): McpServer {
const server = new McpServer({
  name: "yggdrasil",
  version: "0.1.0",
});

server.tool(
  "search",
  "Search for code symbols across indexed repositories using hybrid text + semantic search",
  {
    query: z.string().describe("Natural language query or symbol name"),
    repo: z.string().optional().describe("Filter to a specific repository"),
    kind: z.string().optional().describe("Filter by symbol kind: class, method, function, interface, enum"),
    language: z.string().optional().describe("Filter by language: java, kotlin, typescript"),
    limit: z.number().optional().describe("Max results (default 10)"),
    trace: z.boolean().optional().describe("If true, attach a trace pointer URL to the response"),
  },
  async ({ query, repo, kind, language, limit, trace }) => {
    const tracer = gateTracer(trace, () => new SearchTracer());
    const results = await hybridSearch(query, { repo, kind, language, limit, tracer });
    return jsonResponseWithTrace(results, tracer);
  },
);

server.tool(
  "symbol_context",
  "Get full context for a symbol: callers, callees, inheritance, file location",
  {
    qualified_name: z.string().describe("Fully qualified symbol name (or partial — will match)"),
    repo: z.string().optional().describe("Filter to a specific repository"),
  },
  async ({ qualified_name, repo }) => {
    const symbols = await findSymbolByQualifiedName(qualified_name, repo);
    if (symbols.length === 0) {
      return textResponse(`No symbol found matching: ${qualified_name}`);
    }

    const target = symbols[0];
    const [incoming, outgoing] = await Promise.all([
      getIncomingEdges(target.id),
      getOutgoingEdges(target.id),
    ]);

    return jsonResponse({
      symbol: {
        name: target.name,
        qualified_name: target.qualified_name,
        kind: target.kind,
        file: `${target.repo_name}/${target.file_path}`,
        lines: `${target.start_line}-${target.end_line}`,
        signature: target.signature,
        visibility: target.visibility,
      },
      callers: incoming.filter((e) => e.kind === "calls"),
      callees: outgoing.filter((e) => e.kind === "calls"),
      extends: outgoing.filter((e) => e.kind === "extends"),
      implements: outgoing.filter((e) => e.kind === "implements"),
      extended_by: incoming.filter((e) => e.kind === "extends"),
      implemented_by: incoming.filter((e) => e.kind === "implements"),
    });
  },
);

server.tool(
  "impact",
  "Analyze blast radius: what code is transitively affected if this symbol changes? Each result is tagged with an archetype (controller/service/mapper/dto/entity/repository/test/config/util/builder/exception/other) so the agent can filter or prioritize. `archetype_counts` shows the pre-filter distribution.",
  {
    qualified_name: z.string().describe("Fully qualified symbol name"),
    repo: z.string().optional().describe("Filter to a specific repository"),
    max_depth: z.number().optional().describe("Max traversal depth (default 3)"),
    archetype_exclude: z
      .array(z.enum(ARCHETYPES))
      .optional()
      .describe(
        "Drop entries whose archetype is in this list. Common: ['test'] to skip test fixtures, ['test','controller'] to skip thin controllers too.",
      ),
    trace: z.boolean().optional().describe("If true, attach a trace pointer URL to the response"),
  },
  async ({ qualified_name, repo, max_depth, archetype_exclude, trace }) => {
    const tracer = gateTracer(trace, () => new ImpactTracer());
    const result = await analyzeImpact(qualified_name, {
      repo,
      maxDepth: max_depth,
      tracer,
      archetypeExclude: archetype_exclude,
    });
    if (!result) {
      return textResponse(`No symbol found matching: ${qualified_name}` + maybeAppendTracePointer(tracer));
    }
    return jsonResponseWithTrace(result, tracer);
  },
);

server.tool(
  "detect_changes",
  "Given a git diff or commit range, identify which symbols changed and what calls them. " +
    "For a PR review, index the PR's base and pass ref 'base...head': the old-side hunk lines are matched against the base's symbols, so you get the callers of what the PR changes (side 'base'). " +
    "A class is left out of changedSymbols (listed in droppedContainers) when one of its methods changed. " +
    "affectedSymbols carry edge_kind and resolution; calls/overrides sort above imports. Check `warnings` for an index at the wrong commit.",
  {
    repo: z.string().describe("Repository name"),
    ref: z.string().optional().describe("Git ref or range: 'a...b' (base = merge-base), 'a..b' (base = a), 'a' (a vs working tree). Default: uncommitted changes"),
    side: z
      .enum(["base", "head"])
      .optional()
      .describe("Which side of the diff the index holds. Default: 'base' when a ref is given and the index's last commit is the diff's base, else 'head'"),
    trace: z.boolean().optional().describe("If true, attach a trace pointer URL to the response"),
  },
  async ({ repo, ref, side, trace }) => {
    const tracer = gateTracer(trace, () => new DetectChangesTracer());
    let result;
    try {
      result = await detectChanges(repo, { ref, side, tracer });
    } catch (err) {
      if (err instanceof DetectChangesError) return textResponse(err.message + maybeAppendTracePointer(tracer));
      throw err;
    }
    if (!result) return textResponse(`Repository not found: ${repo}` + maybeAppendTracePointer(tracer));
    return jsonResponseWithTrace(result, tracer);
  },
);

server.tool(
  "analyze_ticket",
  "Analyze a ticket: search for relevant symbols, then bundle each one's context (callers/callees/inheritance) + blast radius + affected tests into a single structured response. Pure orchestration over search/symbol_context/impact — one round-trip instead of 5–10. Pass the ticket title + description as `ticket`.",
  {
    ticket: z.string().describe("Ticket text — title + description (the full natural-language ticket the agent is triaging)"),
    repo: z.string().optional().describe("Filter to a specific repository"),
    top_k: z.number().optional().describe("How many candidate symbols to expand with full context (default 5)"),
    max_depth: z.number().optional().describe("Blast-radius traversal depth per candidate (default 2 — kept lower than `impact` since K candidates are expanded)"),
  },
  async ({ ticket, repo, top_k, max_depth }) => {
    const result = await analyzeTicket(ticket, { repo, topK: top_k, maxDepth: max_depth });
    return jsonResponse(result);
  },
);

server.tool(
  "file_outline",
  "List all symbols in a file with their hierarchy, signatures, and line numbers",
  {
    repo: z.string().describe("Repository name"),
    path: z.string().describe("File path relative to repo root"),
  },
  async ({ repo: repoName, path: filePath }) => {
    const [file] = await sql<{ id: string }[]>`
      SELECT f.id FROM ci_files f
      JOIN ci_repos r ON r.id = f.repo_id
      WHERE r.name = ${repoName} AND f.path = ${filePath}
    `;
    if (!file) return textResponse(`File not found: ${repoName}/${filePath}`);

    const symbols = await getSymbolsByFile(file.id);
    const tree = symbols
      .filter((s) => !s.parent_id)
      .map((parent) => ({
        ...parent,
        children: symbols.filter((s) => s.parent_id === parent.id),
      }));

    return jsonResponse(tree);
  },
);

server.tool(
  "read_source",
  "Read the source code of an indexed file. Use after search/impact to inspect the actual code.",
  {
    repo: z.string().describe("Repository name"),
    path: z.string().describe("File path relative to repo root"),
    start_line: z.number().optional().describe("Start line (1-based, default: beginning)"),
    end_line: z.number().optional().describe("End line (1-based, default: end of file)"),
  },
  async ({ repo: repoName, path: filePath, start_line, end_line }) => {
    const [repoRow] = await sql<{ path: string }[]>`
      SELECT path FROM ci_repos WHERE name = ${repoName}
    `;
    if (!repoRow) return textResponse(`Repository not found: ${repoName}`);

    const fullPath = resolveSourcePath(repoRow.path, filePath);
    if (!fullPath) return textResponse(`Path escapes repository: ${filePath}`);
    const file = Bun.file(fullPath);
    // Report the caller-supplied relative path, never the absolute server path.
    if (!await file.exists()) return textResponse(`File not found: ${repoName}/${filePath}`);

    const source = await file.text();
    const lines = source.split("\n");

    const start = Math.max(1, start_line ?? 1);
    const end = Math.min(lines.length, end_line ?? lines.length);
    const slice = lines.slice(start - 1, end);

    // Return with line numbers for easy reference
    const numbered = slice.map((line, i) => `${start + i}: ${line}`).join("\n");
    return textResponse(numbered);
  },
);

server.tool(
  "list_repos",
  "List all indexed repositories with their stats (incl. embedding coverage)",
  {},
  async () => jsonResponse(await listReposWithStats()),
);

server.tool(
  "search_pattern",
  "Search for a text or regex pattern across indexed source files. Use for finding usage patterns like .last(), @OneToMany, BigDecimal.ZERO that symbol-based search misses.",
  {
    pattern: z.string().describe("Text or regex pattern to search for"),
    repo: z.string().optional().describe("Filter to a specific repository (default: all indexed repos)"),
    path_glob: z.string().optional().describe("Filter files by glob pattern (e.g. '*.kt', 'src/main/**')"),
    max_results: z.number().optional().describe("Max matches to return (default 20)"),
    context_lines: z.number().optional().describe("Lines of context before/after each match (default 2)"),
    trace: z.boolean().optional().describe("If true, attach a trace pointer URL to the response"),
  },
  async ({ pattern, repo, path_glob, max_results = 20, context_lines = 2, trace }) => {
    const tracer = gateTracer(trace, () => new PatternTracer());
    tracer?.setQuery({
      pattern,
      ...(repo !== undefined ? { repo } : {}),
      ...(path_glob !== undefined ? { pathGlob: path_glob } : {}),
      maxResults: max_results,
      contextLines: context_lines,
    });

    let repos: { name: string; path: string }[];
    if (repo) {
      const r = await getRepo(repo);
      if (!r) return textResponse(`Repository not found: ${repo}` + maybeAppendTracePointer(tracer));
      repos = [r];
    } else {
      repos = await listRepos();
    }
    if (repos.length === 0) return textResponse("No indexed repositories found" + maybeAppendTracePointer(tracer));

    const args = [
      "--json",
      "-C", String(context_lines),
      "--max-count", String(max_results * 2), // per-file cap, we trim total later
    ];
    if (path_glob) {
      args.push("--glob", path_glob);
    }
    // Capture invocation BEFORE appending repo paths so the trace stays compact.
    tracer?.setInvocation([...args, pattern], repos.map((r) => r.name));
    args.push(pattern, ...repos.map(r => r.path));

    const tRgStart = performance.now();
    const proc = Bun.spawn(["rg", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    tracer?.recordTiming("rg", performance.now() - tRgStart);

    // Exit code 1 = no matches (not an error)
    if (proc.exitCode !== 0 && proc.exitCode !== 1) {
      return textResponse(`ripgrep error (exit ${proc.exitCode}): ${stderr.trim()}` + maybeAppendTracePointer(tracer));
    }

    const matches: {
      repo: string;
      path: string;
      line: number;
      content: string;
      context_before: string[];
      context_after: string[];
    }[] = [];

    // Pre-sort by path length descending for correct longest-prefix match
    const repoPaths = repos
      .map(r => [r.path, r.name] as const)
      .sort((a, b) => b[0].length - a[0].length);

    const repoNameForFilePath = (filePath: string): string => {
      const repoEntry = repoPaths.find(([rp]) => filePath.startsWith(rp));
      return repoEntry?.[1] ?? "unknown";
    };

    const lines = stdout.split("\n");
    const tParseStart = performance.now();
    let pendingContext: string[] = [];
    let currentMatch: typeof matches[0] | null = null;
    let preTrimMatchCount = 0;
    let i = 0;

    // Phase 1: collect up to max_results matches; break on cap (original fast path).
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.type === "context") {
        const text = msg.data?.lines?.text?.trimEnd() ?? "";
        if (currentMatch) currentMatch.context_after.push(text);
        else pendingContext.push(text);
      } else if (msg.type === "match") {
        preTrimMatchCount += 1;
        const filePath: string = msg.data?.path?.text ?? "";
        const repoName = repoNameForFilePath(filePath);
        tracer?.incrementRepoMatch(repoName);

        if (currentMatch) {
          matches.push(currentMatch);
          currentMatch = null;
          if (matches.length >= max_results) { i++; break; }
        }
        const repoEntry = repoPaths.find(([rp]) => filePath.startsWith(rp));
        const relPath = repoEntry ? filePath.slice(repoEntry[0].length + 1) : filePath;
        currentMatch = {
          repo: repoName,
          path: relPath,
          line: msg.data?.line_number ?? 0,
          content: (msg.data?.lines?.text ?? "").trimEnd(),
          context_before: [...pendingContext],
          context_after: [],
        };
        pendingContext = [];
      } else if (msg.type === "end" || msg.type === "begin") {
        if (currentMatch) {
          matches.push(currentMatch);
          currentMatch = null;
          if (matches.length >= max_results) { i++; break; }
        }
        pendingContext = [];
      }
    }
    if (currentMatch && matches.length < max_results) matches.push(currentMatch);

    // Phase 2: when tracing, scan remaining lines to count any uncounted matches.
    // Cheap substring prefilter avoids JSON.parse on context/begin/end events.
    if (tracer) {
      for (; i < lines.length; i++) {
        const line = lines[i];
        if (!line.startsWith('{"type":"match"')) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type !== "match") continue;
        preTrimMatchCount += 1;
        tracer.incrementRepoMatch(repoNameForFilePath(msg.data?.path?.text ?? ""));
      }
    }

    tracer?.recordTiming("parse", performance.now() - tParseStart);
    tracer?.setTotals(preTrimMatchCount, matches.length, preTrimMatchCount > matches.length);

    if (matches.length === 0) {
      return textResponse(`No matches found for pattern: ${pattern}` + maybeAppendTracePointer(tracer));
    }
    return jsonResponseWithTrace({ pattern, total_matches: matches.length, matches }, tracer);
  },
);

server.tool(
  "list_files",
  "List files in an indexed repository, optionally filtered by directory and glob pattern.",
  {
    repo: z.string().describe("Repository name"),
    path: z.string().optional().describe("Directory path within repo (default: root)"),
    pattern: z.string().optional().describe("Glob filter (e.g. '*.kt', '**/*Test*')"),
    limit: z.number().optional().describe("Max files to return (default 200)"),
  },
  async ({ repo: repoName, path: dirPath, pattern: globPattern, limit = 200 }) => {
    const dirFilter = dirPath
      ? sql`AND f.path LIKE ${(dirPath.endsWith("/") ? dirPath : dirPath + "/") + '%'}`
      : sql``;
    const globFilter = globPattern
      ? sql`AND f.path LIKE ${globToLike(globPattern)}`
      : sql``;

    const files = await sql<{ path: string; language: string }[]>`
      SELECT f.path, f.language
      FROM ci_files f JOIN ci_repos r ON r.id = f.repo_id
      WHERE r.name = ${repoName} ${dirFilter} ${globFilter}
      ORDER BY f.path
      LIMIT ${limit}
    `;

    if (files.length === 0) {
      return textResponse(`No files found in repo "${repoName}" with the given filters`);
    }

    return jsonResponse({
      repo: repoName,
      total_files: files.length,
      truncated: files.length === limit,
      files,
    });
  },
);

return server;
}

// --- Start server ---
function startServer() {
  // Create a new McpServer + transport per session so multiple clients can connect
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return Response.json({ status: "ok", tools: TOOL_COUNT });
      }

      if (url.pathname.startsWith("/api/trace/")) {
        const id = url.pathname.slice("/api/trace/".length);
        const trace = defaultTraceStore().get(id);
        if (!trace) {
          return Response.json({ detail: "trace not found or expired" }, { status: 404 });
        }
        return Response.json(trace);
      }

      if (url.pathname !== "/mcp") {
        return new Response("Not found", { status: 404 });
      }

      // Check for existing session
      const sessionId = req.headers.get("mcp-session-id");
      if (sessionId && sessions.has(sessionId)) {
        return sessions.get(sessionId)!.handleRequest(req);
      }

      // New session: create fresh server + transport
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };

      const server = createServer();
      await server.connect(transport);

      return transport.handleRequest(req);
    },
  });

  console.log(`[yggdrasil] MCP server listening on http://127.0.0.1:${PORT}/mcp`);
}

// Only bind the port when run as the entry point — importing this module (e.g. in
// tests, to exercise pure helpers like resolveSourcePath) must not start the server.
if (import.meta.main) {
  startServer();
}
