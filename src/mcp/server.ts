import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { hybridSearch } from "../search/hybrid-search.ts";
import { analyzeImpact } from "../search/impact.ts";
import { detectChanges } from "../search/detect-changes.ts";
import { findSymbolByQualifiedName, getSymbolsByFile } from "../db/symbols.ts";
import { getIncomingEdges, getOutgoingEdges } from "../db/edges.ts";
import { getRepo, listRepos } from "../db/repos.ts";
import { sql } from "../db/connection.ts";
import {
  SearchTracer,
  ImpactTracer,
  PatternTracer,
  DetectChangesTracer,
  shouldTrace,
} from "../tracing/trace.ts";
import { defaultTraceStore, pointerModeEnabled, tracePointerLine } from "../tracing/trace-store.ts";

/** Stash a trace and return the pointer line to append to a tool's text output. */
function maybeAppendTracePointer(tracer: { toJSON(): unknown } | undefined): string {
  if (!tracer) return "";
  const traceId = defaultTraceStore().put(tracer.toJSON());
  return tracePointerLine(traceId, PORT);
}

const PORT = parseInt(process.env.YGGDRASIL_PORT ?? "9130", 10);

/** Convert a simple glob pattern to SQL LIKE: * → %, ? → _, ** → % */
function globToLike(glob: string): string {
  return glob
    .replace(/%/g, "\\%")   // escape existing SQL wildcards
    .replace(/_/g, "\\_")
    .replace(/\*\*/g, "%")  // ** matches any path depth
    .replace(/\*/g, "%")    // * matches within a segment
    .replace(/\?/g, "_");   // ? matches single char
}
const TOOL_COUNT = 9;

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
    // Pointer mode is the only supported wire format, so it gates recording too.
    const tracer = shouldTrace(trace) && pointerModeEnabled() ? new SearchTracer() : undefined;
    const results = await hybridSearch(query, { repo, kind, language, limit, tracer });
    return textResponse(JSON.stringify(results, null, 2) + maybeAppendTracePointer(tracer));
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
  "Analyze blast radius: what code is transitively affected if this symbol changes?",
  {
    qualified_name: z.string().describe("Fully qualified symbol name"),
    repo: z.string().optional().describe("Filter to a specific repository"),
    max_depth: z.number().optional().describe("Max traversal depth (default 3)"),
    trace: z.boolean().optional().describe("If true, attach a trace pointer URL to the response"),
  },
  async ({ qualified_name, repo, max_depth, trace }) => {
    const tracer = shouldTrace(trace) && pointerModeEnabled() ? new ImpactTracer() : undefined;
    const result = await analyzeImpact(qualified_name, { repo, maxDepth: max_depth, tracer });
    if (!result) {
      return textResponse(`No symbol found matching: ${qualified_name}` + maybeAppendTracePointer(tracer));
    }
    return textResponse(JSON.stringify(result, null, 2) + maybeAppendTracePointer(tracer));
  },
);

server.tool(
  "detect_changes",
  "Given a git diff or commit range, identify which symbols changed and what is affected",
  {
    repo: z.string().describe("Repository name"),
    ref: z.string().optional().describe("Git ref or range (default: uncommitted changes)"),
    trace: z.boolean().optional().describe("If true, attach a trace pointer URL to the response"),
  },
  async ({ repo, ref, trace }) => {
    const tracer = shouldTrace(trace) && pointerModeEnabled() ? new DetectChangesTracer() : undefined;
    const result = await detectChanges(repo, ref, tracer);
    if (!result) return textResponse(`Repository not found: ${repo}` + maybeAppendTracePointer(tracer));
    return textResponse(JSON.stringify(result, null, 2) + maybeAppendTracePointer(tracer));
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

    const fullPath = `${repoRow.path}/${filePath}`;
    const file = Bun.file(fullPath);
    if (!await file.exists()) return textResponse(`File not found: ${fullPath}`);

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
  "List all indexed repositories with their stats",
  {},
  async () => jsonResponse(await listRepos()),
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
    const tracer = shouldTrace(trace) && pointerModeEnabled() ? new PatternTracer() : undefined;
    const queryShape = {
      pattern,
      ...(repo !== undefined ? { repo } : {}),
      ...(path_glob !== undefined ? { pathGlob: path_glob } : {}),
      maxResults: max_results,
      contextLines: context_lines,
    };
    tracer?.setQuery(queryShape);

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
    const proc = Bun.spawn(["rg", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

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

    // Parse ripgrep JSON lines
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

    let pendingContext: string[] = [];
    let currentMatch: typeof matches[0] | null = null;
    let preTrimMatchCount = 0;
    let collectingMatches = true;
    const tParseStart = performance.now();

    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.type === "context") {
        if (!collectingMatches) continue;
        const text = msg.data?.lines?.text?.trimEnd() ?? "";
        if (currentMatch) {
          currentMatch.context_after.push(text);
        } else {
          pendingContext.push(text);
        }
      } else if (msg.type === "match") {
        // Always count for the trace, even after the matches[] cap is hit.
        preTrimMatchCount += 1;
        if (tracer) {
          const filePath: string = msg.data?.path?.text ?? "";
          const repoEntry = repoPaths.find(([rp]) => filePath.startsWith(rp));
          tracer.incrementRepoMatch(repoEntry?.[1] ?? "unknown");
        }

        if (!collectingMatches) continue;

        // Flush previous match
        if (currentMatch) {
          matches.push(currentMatch);
          if (matches.length >= max_results) {
            collectingMatches = false;
            currentMatch = null;
            continue;
          }
        }

        const filePath: string = msg.data?.path?.text ?? "";
        const repoEntry = repoPaths.find(([rp]) => filePath.startsWith(rp));
        const relPath = repoEntry ? filePath.slice(repoEntry[0].length + 1) : filePath;

        currentMatch = {
          repo: repoEntry?.[1] ?? "unknown",
          path: relPath,
          line: msg.data?.line_number ?? 0,
          content: (msg.data?.lines?.text ?? "").trimEnd(),
          context_before: [...pendingContext],
          context_after: [],
        };
        pendingContext = [];
      } else if (msg.type === "end" || msg.type === "begin") {
        if (!collectingMatches) continue;
        // Flush on file boundary
        if (currentMatch) {
          matches.push(currentMatch);
          if (matches.length >= max_results) {
            collectingMatches = false;
            currentMatch = null;
            continue;
          }
          currentMatch = null;
        }
        pendingContext = [];
      }
    }
    // Flush last match
    if (currentMatch && matches.length < max_results) {
      matches.push(currentMatch);
    }
    tracer?.recordTiming("parse", performance.now() - tParseStart);
    tracer?.setTotals(preTrimMatchCount, matches.length, preTrimMatchCount > matches.length);

    if (matches.length === 0) {
      return textResponse(`No matches found for pattern: ${pattern}` + maybeAppendTracePointer(tracer));
    }

    return textResponse(
      JSON.stringify({ pattern, total_matches: matches.length, matches }, null, 2) +
        maybeAppendTracePointer(tracer),
    );
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
