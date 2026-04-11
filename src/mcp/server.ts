import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { hybridSearch } from "../search/hybrid-search.ts";
import { analyzeImpact } from "../search/impact.ts";
import { detectChanges } from "../search/detect-changes.ts";
import { findSymbolByQualifiedName, getSymbolsByFile } from "../db/symbols.ts";
import { getIncomingEdges, getOutgoingEdges } from "../db/edges.ts";
import { listRepos } from "../db/repos.ts";
import { sql } from "../db/connection.ts";

const PORT = parseInt(process.env.YGGDRASIL_PORT ?? "9130", 10);
const TOOL_COUNT = 6;

function jsonResponse(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

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
  },
  async ({ query, repo, kind, language, limit }) => {
    return jsonResponse(await hybridSearch(query, { repo, kind, language, limit }));
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
  },
  async ({ qualified_name, repo, max_depth }) => {
    const result = await analyzeImpact(qualified_name, { repo, maxDepth: max_depth });
    if (!result) return textResponse(`No symbol found matching: ${qualified_name}`);
    return jsonResponse(result);
  },
);

server.tool(
  "detect_changes",
  "Given a git diff or commit range, identify which symbols changed and what is affected",
  {
    repo: z.string().describe("Repository name"),
    ref: z.string().optional().describe("Git ref or range (default: uncommitted changes)"),
  },
  async ({ repo, ref }) => {
    const result = await detectChanges(repo, ref);
    if (!result) return textResponse(`Repository not found: ${repo}`);
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
  "list_repos",
  "List all indexed repositories with their stats",
  {},
  async () => jsonResponse(await listRepos()),
);

// --- Start server ---
const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
});

await server.connect(transport);

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/mcp") {
      return transport.handleRequest(req);
    }
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", tools: TOOL_COUNT });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`[yggdrasil] MCP server listening on http://127.0.0.1:${PORT}/mcp`);
