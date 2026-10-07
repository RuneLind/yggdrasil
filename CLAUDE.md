# Yggdrasil — Code Intelligence Engine

Indexes codebases into a searchable knowledge graph with symbol extraction, call graph traversal, and blast radius analysis. Exposes tools via MCP for AI coding agents.

Named after the Norse world tree connecting all realms — companion to [Muninn](../muninn) (memory) and [Huginn](../huginn) (knowledge search).

## Stack

- **Runtime:** Bun
- **Language:** TypeScript
- **Database:** PostgreSQL + pgvector (tables prefixed `ci_`)
- **Parsing:** web-tree-sitter (WASM — Java, Kotlin, TypeScript)
- **Embeddings:** Configurable (default: Xenova/multilingual-e5-small, 384 dims)
- **Protocol:** MCP (streamable-http)

## Running

```bash
bun install
bun run db:migrate          # Apply schema
bun run index <repo-path>   # Index a codebase (parses, extracts symbols, embeds)
bun run index --no-embed <repo-path>   # Skip embedding for fast iteration
bun run embed               # Backfill embeddings for any symbols missing one
bun run dev                 # MCP server with --watch
bun run start               # MCP server (production)
```

## Architecture

```
source files → Tree-sitter AST → symbol extraction → import resolution
  → call graph edges → embeddings → Postgres (symbols + edges + vectors)
  → MCP server (search, symbol_context, impact, detect_changes, file_outline)
```

### Indexing pipeline

1. **File discovery** — walk repo, filter by extension, skip unchanged (content hash)
2. **AST parsing** — web-tree-sitter WASM, per-language grammars
3. **Symbol extraction** — Tree-sitter Query API, extract classes/methods/functions/interfaces
4. **Import resolution** — Java packages, Kotlin, TS relative paths → symbol references
5. **Call graph** — Phase 1 stores call sites (`ci_call_sites`, owned by the outermost method/function/constructor containing the call inside its innermost class/interface/enum/object, else inside the next container out; `receiver_type`, `arg_types`/`arg_names` and `implicit_receiver_type` come from the one-pass AST scope walk in `src/indexer/scope-walk.ts`) and inheritance refs (`ci_inheritance_refs`). Phase 2 deletes and rebuilds every `calls`/`extends`/`implements` edge in the repo from those rows in one transaction whenever a file changed or was removed, so incremental reindexes keep incoming cross-file edges. It resolves type names through member types (inherited ones included), imports (aliases included), the same package and wildcard imports, looks methods up the `extends`/`implements` hierarchy of the receiver's class (receiverless calls: the caller's class, then each enclosing class), keeps the arity-compatible (`min_params`..`max_params`), visible, non-overridden overloads, narrows them by argument types (`src/indexer/overloads.ts`), and tags each `calls` edge with `ci_edges.resolution` (`local`/`static`/`typed`). `EXTRACTOR_VERSION` in `src/indexer/index.ts` gates the index: a mismatch with `ci_repos.extractor_version` forces a full re-extract. Bump it whenever extraction output changes.
6. **Embeddings** — at end of `indexRepo`, embed every symbol in the repo that doesn't have an embedding yet (qualified_name + signature + doc_comment, 384-dim). Idempotent; skip with `--no-embed` and backfill later via `bun run embed`. Without embeddings, semantic search is dead and any multi-word natural-language `search` query returns `[]`.

### MCP tools

| Tool | Purpose |
|------|---------|
| `search` | Hybrid search (FTS + semantic + name match via RRF). Optional `trace` arg → pointer-mode trace (see Tracing below) |
| `symbol_context` | 360-degree view: callers, callees, inheritance |
| `impact` | Blast radius with confidence scoring by depth. Each result carries the `resolution` of the edge that reached it and is tagged with an `archetype` (controller/service/mapper/dto/entity/repository/test/config/util/builder/exception/other) via name+path heuristics. Optional `archetype_exclude` arg trims noise; `archetype_counts` on the response shows the pre-filter distribution. |
| `detect_changes` | Git diff → affected symbols and their blast radius (inherits archetype tagging via `impact`) |
| `analyze_ticket` | Ticket text → top candidate symbols, each bundled with caller/callee/inheritance context + blast radius + affected tests. One round-trip orchestration over `search`/`symbol_context`/`impact` (inherits archetype tagging). |
| `file_outline` | All symbols in a file with hierarchy |
| `read_source` | Read source code of an indexed file with line numbers |
| `list_repos` | List all indexed repositories |
| `search_pattern` | Text/regex search across indexed source files (ripgrep) |
| `list_files` | List files in an indexed repo, filterable by glob |

## Tracing

Pointer-mode tracing for the four pipeline tools (`search`, `impact`, `search_pattern`, `detect_changes`). When enabled, the tool result ends with a trailing `yggdrasil-trace-url: http://127.0.0.1:<port>/api/trace/<id>` line. The trace itself is held in an in-memory TTL store and fetched out-of-band via `GET /api/trace/<id>`. Mirrors huginn's pattern; consumed by muninn.

Per-tool trace coverage:

| Tool | Traced? | Schema variant | Why |
|------|---------|----------------|-----|
| `search` | yes | `TraceSearchV1` | Hybrid retrieval pipeline (FTS + semantic + name → RRF → final) |
| `impact` | yes | `TraceImpactV1` | BFS hop counts, confidence buckets, top results |
| `search_pattern` | yes | `TracePatternV1` | rg invocation, per-repo match counts, pre-trim totals |
| `detect_changes` | yes | `TraceDetectChangesV1` | Diff stats, per-file symbol extraction, blast radius per changed symbol |
| `analyze_ticket` | no (v1) | — | Composes already-traced primitives; pass `trace: true` to `search` / `impact` directly if needed. A typed `TraceAnalyzeTicketV1` variant can be added later. |
| `symbol_context`, `read_source`, `file_outline`, `list_files`, `list_repos` | no | — | Single-step deterministic queries; nothing to surface |

`TraceV1` is a discriminated union over the four variants plus a `TraceGenericV1` escape hatch (discriminator `shape: "generic"`) used for any future tool that ships before getting a typed shape.

Env flags:

| Variable | Default | Effect |
|----------|---------|--------|
| `YGGDRASIL_TRACE_POINTER` | off | Master switch. Set to `1` to enable any tracing (zero overhead when off). |
| `YGGDRASIL_TRACE_DEFAULT` | off | Set to `1` to record a trace on every traced tool call without callers passing `trace: true`. Requires the master switch. |
| `YGGDRASIL_TRACE_TTL_SECONDS` | `600` | How long stored traces are fetchable. |

Run with traces:

```bash
YGGDRASIL_TRACE_POINTER=1 YGGDRASIL_TRACE_DEFAULT=1 bun run dev
```

See `src/tracing/trace.ts` for the `TraceV1` union and per-tool tracer classes, and `src/tracing/trace-store.ts` for the store + pointer-line helper.

## Conventions

- Use `bun` not `node` — Bun loads .env automatically
- Use `postgres` npm package for DB (not Bun.sql)
- Use `web-tree-sitter` (WASM), not native `tree-sitter`
- Database tables prefixed with `ci_` (code intelligence)
- Embeddings: configurable model via EMBEDDING_MODEL env var (default 384-dim)
- All timestamps as `TIMESTAMPTZ` in DB

## Database

Uses the same PostgreSQL instance as Muninn (or standalone).

- URL: configured via `DATABASE_URL` in `.env`
- Schema: `db/migrations/` (numbered .sql files)
- Tables: `ci_repos`, `ci_files`, `ci_symbols`, `ci_edges`, `ci_import_map`, `ci_call_sites`, `ci_inheritance_refs`

## Configuration

Repos to index are passed via CLI or configured in `repos.json`:

```json
[
  {
    "name": "melosys-api",
    "path": "/Users/rune/source/nav/melosys-api",
    "languages": ["java", "kotlin"],
    "exclude": ["**/test/**", "**/build/**", "**/target/**"]
  }
]
```

## Module structure

```
src/
├── indexer/
│   ├── index.ts             — orchestrator (full + incremental)
│   ├── file-walker.ts       — discover + hash source files
│   ├── parser.ts            — tree-sitter setup + parse
│   ├── symbol-extractor.ts  — extract symbols from AST per language
│   ├── import-resolver.ts   — resolve imports to symbol references
│   ├── call-graph.ts        — per-language dispatch; inheritance clauses
│   ├── scope-walk.ts        — one-pass scope walk: call sites with receiver/argument types
│   ├── overloads.ts         — argument-type narrowing among overloads
│   ├── edge-resolver.ts     — store call sites; rebuild calls + inheritance edges repo-wide
│   └── embedder.ts          — end-of-repo batch embedding (idempotent)
├── search/
│   ├── hybrid-search.ts     — RRF over FTS + semantic + name match
│   ├── impact.ts            — blast radius traversal
│   ├── archetype.ts         — name+path heuristics for arketype-tagging impact results
│   ├── analyze-ticket.ts    — ticket → candidate symbols + context bundle
│   └── detect-changes.ts    — git diff → affected symbols
├── db/
│   ├── connection.ts        — postgres connection
│   ├── repos.ts             — ci_repos CRUD
│   ├── files.ts             — ci_files CRUD
│   ├── symbols.ts           — ci_symbols CRUD + search
│   └── edges.ts             — ci_edges CRUD + traversal
├── mcp/
│   └── server.ts            — MCP server (streamable-http) + /api/trace/<id> endpoint
├── tracing/
│   ├── trace.ts             — Tracer + TraceV1 schema
│   └── trace-store.ts       — in-memory TTL trace store + pointer-line helper
├── embeddings.ts            — Xenova embedding generation
├── cli.ts                   — CLI entry point
└── config.ts                — repo configuration
```
