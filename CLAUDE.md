# Yggdrasil — Code Intelligence Engine

Indexes codebases into a searchable knowledge graph with symbol extraction, call graph traversal, and blast radius analysis. Exposes tools via MCP for AI coding agents.

Named after the Norse world tree connecting all realms — companion to [Muninn](../muninn) (memory) and [Huginn](../huginn) (knowledge search).

## Stack

- **Runtime:** Bun
- **Language:** TypeScript
- **Database:** PostgreSQL + pgvector (tables prefixed `ci_`)
- **Parsing:** web-tree-sitter (WASM — Java, Kotlin, TypeScript)
- **Embeddings:** Xenova/all-MiniLM-L6-v2 (384 dims)
- **Protocol:** MCP (streamable-http)

## Running

```bash
bun install
bun run db:migrate          # Apply schema
bun run index <repo-path>   # Index a codebase
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
5. **Call graph** — extract call expressions, resolve to target symbols, create edges
6. **Embeddings** — embed qualified_name + signature + doc_comment (384-dim)

### MCP tools

| Tool | Purpose |
|------|---------|
| `search` | Hybrid search (FTS + semantic + name match via RRF) |
| `symbol_context` | 360-degree view: callers, callees, inheritance |
| `impact` | Blast radius with confidence scoring by depth |
| `detect_changes` | Git diff → affected symbols and their blast radius |
| `file_outline` | All symbols in a file with hierarchy |

## Conventions

- Use `bun` not `node` — Bun loads .env automatically
- Use `postgres` npm package for DB (not Bun.sql)
- Use `web-tree-sitter` (WASM), not native `tree-sitter`
- Database tables prefixed with `ci_` (code intelligence)
- Embeddings: 384-dim, same model as Muninn for consistency
- All timestamps as `TIMESTAMPTZ` in DB

## Database

Uses the same PostgreSQL instance as Muninn (or standalone).

- URL: configured via `DATABASE_URL` in `.env`
- Schema: `db/migrations/` (numbered .sql files)
- Tables: `ci_repos`, `ci_files`, `ci_symbols`, `ci_edges`, `ci_import_map`

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
│   ├── call-graph.ts        — extract call expressions → edges
│   └── embedder.ts          — batch embedding generation
├── search/
│   ├── hybrid-search.ts     — RRF over FTS + semantic + name match
│   ├── impact.ts            — blast radius traversal
│   └── detect-changes.ts    — git diff → affected symbols
├── db/
│   ├── connection.ts        — postgres connection
│   ├── repos.ts             — ci_repos CRUD
│   ├── files.ts             — ci_files CRUD
│   ├── symbols.ts           — ci_symbols CRUD + search
│   └── edges.ts             — ci_edges CRUD + traversal
├── mcp/
│   └── server.ts            — MCP server (streamable-http)
├── embeddings.ts            — Xenova embedding generation
├── cli.ts                   — CLI entry point
└── config.ts                — repo configuration
```
