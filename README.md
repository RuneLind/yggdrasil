# Yggdrasil

Code intelligence engine that indexes codebases into a searchable knowledge graph. Extracts symbols, builds call graphs, and provides blast radius analysis via MCP tools for AI coding agents.

Named after the Norse world tree connecting all realms — companion to [Muninn](../muninn) (memory/conversations) and [Huginn](../huginn) (knowledge search).

## What it does

Given a multi-repo codebase, Yggdrasil:

1. Parses every source file into an AST (Java, Kotlin, TypeScript)
2. Extracts all symbols (classes, methods, interfaces, etc.) with their signatures
3. Resolves imports and builds a call graph between symbols
4. Generates embeddings for semantic search
5. Exposes everything as MCP tools that AI agents can call

```mermaid
graph LR
    A[Source Files] --> B[Tree-sitter AST]
    B --> C[Symbol Extraction]
    C --> D[Import Resolution]
    D --> E[Call Graph]
    C --> F[Embeddings]
    E --> G[(PostgreSQL)]
    F --> G
    G --> H[MCP Server]
    H --> I[AI Agent]
```

## Quick start

```bash
bun install
bun run db:migrate                    # Apply schema to Postgres
bun run index ~/source/nav/melosys-api   # Index a codebase
bun run search "BehandlingService"    # Search from CLI
bun run start                         # Start MCP server on port 9130
```

## Architecture

### Indexing pipeline

```mermaid
flowchart TD
    subgraph "Phase 1: Symbols"
        A[Walk repo] --> B[Filter by extension + hash]
        B --> C{File changed?}
        C -->|No| D[Skip]
        C -->|Yes| E[Parse with Tree-sitter]
        E --> F[Extract symbols]
        F --> G[Store in ci_symbols]
        F --> H[Store imports in ci_import_map]
    end

    subgraph "Phase 2: Edges"
        G --> I[Resolve imports → edges]
        H --> I
        E --> J[Extract call expressions]
        J --> K[Resolve inheritance]
        K --> L[Resolve method calls]
        I --> M[Store in ci_edges]
        L --> M
    end

    subgraph "Phase 3: Embeddings"
        G --> N[Generate 384-dim vectors]
        N --> O[Store in ci_symbols.embedding]
    end
```

### Database schema

```mermaid
erDiagram
    ci_repos ||--o{ ci_files : contains
    ci_files ||--o{ ci_symbols : defines
    ci_files ||--o{ ci_import_map : imports
    ci_symbols ||--o{ ci_symbols : parent
    ci_symbols ||--o{ ci_edges : source
    ci_symbols ||--o{ ci_edges : target

    ci_repos {
        uuid id PK
        text name UK
        text path
        text last_commit
        timestamptz indexed_at
    }

    ci_files {
        uuid id PK
        uuid repo_id FK
        text path
        text language
        text content_hash
    }

    ci_symbols {
        uuid id PK
        uuid file_id FK
        text name
        text qualified_name
        text kind
        uuid parent_id FK
        int start_line
        int end_line
        text signature
        vector embedding
        tsvector search_vector
    }

    ci_edges {
        uuid id PK
        uuid source_id FK
        uuid target_id FK
        text kind
        int line
    }
```

### MCP tools

The server exposes 6 tools over streamable HTTP on port 9130:

| Tool | Description | Example use |
|------|-------------|-------------|
| `search` | Hybrid search (FTS + semantic + name match via RRF) | "Find code related to payment processing" |
| `symbol_context` | 360-degree view of a symbol: callers, callees, inheritance | "What calls this method? What does it extend?" |
| `impact` | Blast radius — what breaks if this symbol changes? | "If I change Behandling, what's affected?" |
| `detect_changes` | Map a git diff to affected symbols + their blast radius | "What's the impact of this PR?" |
| `file_outline` | All symbols in a file with hierarchy and signatures | "Show me the structure of this file" |
| `list_repos` | List all indexed repositories with metadata | "What repos are indexed?" |

### Search algorithm

```mermaid
flowchart LR
    Q[Query] --> FTS[Full-text search]
    Q --> SEM[Semantic search]
    Q --> NAME[Name matching]
    
    FTS --> RRF[Reciprocal Rank Fusion]
    SEM --> RRF
    NAME --> RRF
    
    RRF --> BOOST[Kind boost]
    BOOST --> RESULTS[Top-K results]

    style RRF fill:#f9f,stroke:#333
```

Each search channel returns candidates ranked independently. RRF merges them with:
- FTS weight: 1.0
- Semantic weight: 1.0
- Name match weight: 1.5 (case-sensitive exact gets rank 1.0)

Then a kind-based boost is applied: classes/interfaces get 1.5x, properties get 0.7x.

## Performance

Tested on the Melosys multi-repo stack:

| Metric | melosys-api | melosys-eessi |
|--------|-------------|---------------|
| Source files | 1,993 | 529 |
| Symbols extracted | 26,505 | 4,239 |
| Import edges | 23,866 | 2,747 |
| Extends/implements edges | 415 | ~90 |
| Full index time | ~8s | ~10s |
| Incremental (no changes) | 485ms | — |
| Embedding generation | ~5 min (30K symbols) | — |

## Configuration

### repos.json

```json
[
  {
    "name": "melosys-api",
    "path": "/Users/rune/source/nav/melosys-api",
    "languages": ["java", "kotlin"],
    "exclude": ["**/build/**", "**/target/**"]
  }
]
```

### Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://muninn:muninn@127.0.0.1:5435/muninn` | Postgres connection |
| `YGGDRASIL_PORT` | `9130` | MCP server port |

### MCP client configuration

Add to your agent's `.mcp.json`:

```json
{
  "mcpServers": {
    "yggdrasil": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:9130/mcp"
    }
  }
}
```

## Stack

- **Runtime:** Bun
- **Language:** TypeScript
- **Database:** PostgreSQL + pgvector
- **Parsing:** web-tree-sitter (WASM grammars for Java, Kotlin, TypeScript)
- **Embeddings:** Xenova/all-MiniLM-L6-v2 (384 dimensions)
- **Protocol:** MCP (streamable HTTP, stateful sessions)

## Project structure

```
src/
├── indexer/
│   ├── index.ts              Orchestrator (incremental + full)
│   ├── file-walker.ts        Discover + hash source files
│   ├── parser.ts             Tree-sitter WASM setup
│   ├── symbol-extractor.ts   AST → symbols per language
│   ├── ast-utils.ts          Shared AST helpers
│   ├── import-resolver.ts    Resolve imports → edges
│   ├── call-graph.ts         Extract calls + inheritance
│   └── edge-resolver.ts      Resolve calls → symbol IDs
├── search/
│   ├── hybrid-search.ts      RRF over FTS + semantic + name
│   ├── impact.ts             Blast radius (recursive CTE)
│   └── detect-changes.ts     Git diff → affected symbols
├── db/
│   ├── connection.ts         Postgres pool
│   ├── repos.ts              ci_repos CRUD
│   ├── files.ts              ci_files CRUD
│   ├── symbols.ts            ci_symbols CRUD + vector ops
│   └── edges.ts              ci_edges CRUD + traversal
├── mcp/
│   └── server.ts             MCP streamable HTTP server
├── embeddings.ts             Xenova model wrapper
├── cli.ts                    CLI entry point
└── config.ts                 Repo config loader
```
