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
bun run dev                           # …or in watch mode (auto-reload on edits)
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
        E --> J[Extract call expressions + inheritance]
        J --> P[Store in ci_call_sites + ci_inheritance_refs]
    end

    subgraph "Phase 2: Edges (whole repo)"
        G --> I[Resolve imports → edges]
        H --> I
        P --> K[Rebuild inheritance edges]
        K --> R[Rebuild overrides edges]
        R --> L[Rebuild call edges]
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
    ci_files ||--o{ ci_call_sites : contains
    ci_files ||--o{ ci_inheritance_refs : contains
    ci_symbols ||--o{ ci_call_sites : calls_from
    ci_symbols ||--o{ ci_inheritance_refs : declares
    ci_symbols ||--o{ ci_symbols : parent
    ci_symbols ||--o{ ci_edges : source
    ci_symbols ||--o{ ci_edges : target

    ci_repos {
        uuid id PK
        text name UK
        text path
        text last_commit
        int extractor_version
        timestamptz indexed_at
    }

    ci_files {
        uuid id PK
        uuid repo_id FK
        text path
        text language
        text content_hash
        text package_name
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
        text declared_type
        int min_params
        int max_params
        text_array param_types
        text_array param_names
        text extension_receiver
        vector embedding
        tsvector search_vector
    }

    ci_edges {
        uuid id PK
        uuid source_id FK
        uuid target_id FK
        text kind
        int line
        text resolution
    }

    ci_call_sites {
        uuid id PK
        uuid file_id FK
        uuid source_symbol_id FK
        text receiver
        text receiver_kind
        text receiver_type
        text method_name
        int arg_count
        text_array arg_types
        text_array arg_names
        text implicit_receiver_type
        uuid receiver_site_id
        bool is_navigation
        bool receiver_declared
        int line
    }

    ci_inheritance_refs {
        uuid id PK
        uuid file_id FK
        uuid source_symbol_id FK
        text kind
        text type_name
    }
```

Phase 2 runs whenever a file changed or was removed. It deletes every `calls`, `extends`, `implements` and `overrides` edge in the repo and rebuilds them from `ci_call_sites`, `ci_inheritance_refs` and the symbols in one transaction, so an incremental reindex keeps edges from unchanged files into changed ones.

A call site belongs to the outermost method, function or constructor whose source range contains it and that lies inside the innermost class, interface, enum or object containing the call. When no callable inside that container contains the call, as in a local class's field initializer or init block, the owner is the outermost callable inside the next container out. Calls inside an anonymous class, object expression, lambda or local function count for the host. Calls in a top-level class's field initializers, static or instance initializers and Kotlin `init` blocks, and in top-level property initializers, have no owner and are not stored.

At extraction, one pass over each file's AST keeps a stack of scopes, reading each scope's declarations once. A receiver that is a single identifier gets the declared type of the variable it names (`ci_call_sites.receiver_type`): the innermost of locals declared before the call (Java pattern variables and Kotlin destructuring included), enclosing parameters (an untyped lambda parameter or a Kotlin implicit `it` shadows with no type), then fields, properties and constructor properties of the enclosing classes; in a Kotlin property initializer or `init` block, the primary constructor's plain parameters too. `this.`, `this@Label.` (looked up in that class), `!!`, a nullable `?` and generic arguments are stripped first. A name declared as a variable is never resolved as a class, even when it starts with an uppercase letter; a Kotlin `val x = mockk<T>()` (or `spyk`, `mock`, `spy`) is typed `T`. `ci_call_sites.receiver_declared` records whether anything in scope declares an identifier receiver, typed or not. A receiver that is itself a call (`a.b().c()`) or, in Kotlin, a navigation `a.b` (`a.b.c()`) points at that step through `receiver_site_id`; a navigation step is stored as its own row (`is_navigation`, `method_name` = `b`) only to type the call on it, and never becomes an edge. Each argument gets a type when cheap and certain (`arg_types`: a typed identifier, `this`, a literal, a constructor call), each Kotlin named argument its name (`arg_names`), and a receiverless call inside a Kotlin `with(x)`, `x.apply` or `x.run` lambda the declared type of `x` (`implicit_receiver_type`).

The rebuild resolves each type name (supertype, class-name receiver, receiver type, extension receiver) to one class: a member type of an enclosing class or of one of its supertypes (the innermost class first, its own member types before inherited ones; Java and Kotlin both let a member type shadow imports), an explicit import (alias included), the same package, a wildcard import, then the name as a qualified name. An explicit import of a class outside the repo resolves to nothing. A call then looks for a method of its name in groups of lookup classes, and the first group with a candidate that the known argument types do not rule out wins (else the first group with a candidate): the `with`/`apply`/`run` receiver; the receiver's class, or for a receiverless or `this` call the caller's class; then, for a receiverless call, each lexically enclosing class outward. Each lookup class contributes every method of its `extends`/`implements` hierarchy whose parameter range (`min_params`..`max_params`, open for a vararg) admits the argument count (named arguments count; a spread admits every overload), minus methods overridden in a subclass of their owner and `private` methods outside their own top-level class (or file, for a top-level function). A call without a member match resolves to an imported, same-package or wildcard-imported top-level function or static import; an extension function when its receiver class is in the hierarchy of the call's receiver, or for a receiverless call, of a lookup class or the caller's own extension receiver, or when it is the only reachable extension function of that name (lambda receivers such as DSL builders are not modelled; of several, none is picked). Among several candidates, the known argument types and names keep the overloads whose parameters fit (equal simple names, boxed twins equal, a Java integer literal widens to `long`/`float`/`double` and a Kotlin one fits any integer type, a subclass fits its supertype, a type-parameter argument is its bound); a parameter that certainly fits beats one that only may, and a specific parameter beats `Object`/`Any` only when a known argument certainly fits it. When none fits, all keep their edges. Among Java overloads, javac's phases decide: varargs only when no fixed-arity method certainly applies. Stored types fold boxed twins, so where a boxed type would change javac's pick (an `Integer` argument picks `a(Object)` over `a(int)`; `b(1)` cannot call `b(Long)`), both overloads keep their edges. Kotlin never widens a primitive. A type parameter, a vararg, `Object`/`Any` or an implemented external interface never outranks a parameter that only may apply; a repo class or an external superclass on the argument's `extends` chain does.

An `overrides` edge runs from each method to every ancestor method of the same name and signature (parameter types when both are fully known, else the parameter range) over the whole `extends`/`implements` closure, ancestors that do not declare it skipped. Constructors, static and private methods never override. `super.foo()` resolves to the nearest ancestor's `foo`; Kotlin `class X : I by impl` is an `implements` edge.

After every other call, two receiver kinds resolve through a symbol's `declared_type`, read in the declaring file (its imports, package and member types): a chain, through each target its receiver step resolved to (a method's return type; for a navigation step, a member property's type or a Java getter `getB()`'s return type), stopping after one hop; and an identifier nothing in the file's scope declares, through the nearest property of that name in the caller class's supertypes (an inherited `lateinit var` in a base test class).

Each `calls` edge records how it resolved in `ci_edges.resolution`: `local` (no receiver, `this` or `super`), `static` (a class name), `typed` (a variable, inherited property or scope-function receiver with a declared type) or `chain` (a one-hop chain); two calls on one line to one target keep the strongest (`typed`, `static`, `local`, then `chain`). `resolution` is NULL for `extends`, `implements`, `overrides` and `imports` edges. Other receivers produce no edge.

#### Known limits

These calls produce no edge, or an edge only by the rules above:

- Chains of more than one hop (`a.b().c().d()`: `d` has no edge), and steps whose declared type is generic (`List<Foo>`), outside the repo or not written in the source (an inferred return type).
- Kotlin constructor properties (`class Behandling(val fagsak: Fagsak)`) and Java fields are not symbols, so `behandling.fagsak.x()` stops at `fagsak`.
- Locals with an inferred type other than a constructor call, a literal or a mock factory (`val x = repo.hent()`).
- Kotlin extension functions beyond the receiver-class rule, and extension functions on a chain or inherited receiver.
- Receivers inside `apply`/`let`/`with`/`also` lambdas beyond the `with`/`apply`/`run` implicit-receiver rule; `it` is untyped.
- Method references (`Foo::bar`), constructor calls and reflection. (Java static imports, explicit and wildcard, resolve.)
- Argument types of chains and other expressions are unknown, so overloads of the same arity called with them all keep their edges.

When `ci_repos.extractor_version` differs from `EXTRACTOR_VERSION` in `src/indexer/index.ts`, a plain `bun run index` re-extracts every file, as with `--full`. Bump the constant whenever extraction output changes. The re-extract drops every embedding of the repo, so with `--no-embed` semantic search stays dead until you run `bun run embed`.

### MCP tools

The server exposes 10 tools over streamable HTTP on port 9130:

| Tool | Description | Example use |
|------|-------------|-------------|
| `search` | Hybrid search (FTS + semantic + name match via RRF). Optional `trace` arg attaches a trace pointer URL — see [Tracing](#tracing). | "Find code related to payment processing" |
| `symbol_context` | 360-degree view of a symbol: callers, callees, inheritance | "What calls this method? What does it extend?" |
| `impact` | Blast radius — what breaks if this symbol changes? Each result is tagged with an `archetype` (controller/service/mapper/dto/entity/repository/test/…) so an agent can filter the noise with `archetype_exclude`, and carries the `edge_kind` and `resolution` (`local`/`static`/`typed`/`chain`, `null` for other kinds) of the edge that reached it. Dispatch: `impact(FooImpl.bar)` also lists the callers of every `Foo.bar` it overrides, as `calls` with `via` naming `Foo.bar`; `impact(Foo.bar)` lists each implementation once with `edge_kind` `overrides`, then its callers. Optional `trace` arg. | "If I change Behandling, what's affected? (excluding tests and controllers)" |
| `detect_changes` | Map a git diff to affected symbols + their blast radius (inherits archetype tagging). Optional `trace` arg. | "What's the impact of this PR?" |
| `analyze_ticket` | One round-trip orchestration over `search` → `symbol_context` → `impact` per top candidate. Returns ticket → top symbols + caller/callee/inheritance + blast radius (archetype-tagged) + affected tests. | "Analyze this Jira ticket and tell me what to touch" |
| `file_outline` | All symbols in a file with hierarchy and signatures | "Show me the structure of this file" |
| `read_source` | Read source code of an indexed file with line numbers | "Show me lines 30-60 of BehandlingService.java" |
| `list_repos` | List all indexed repositories with metadata | "What repos are indexed?" |
| `search_pattern` | Text/regex search across indexed source files (delegates to ripgrep). Optional `trace` arg. | "Find all uses of `BigDecimal.ZERO`" |
| `list_files` | List files in an indexed repo, filterable by directory and glob | "What `.kt` files live under `service/`?" |

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

## Tracing

Four pipeline tools (`search`, `impact`, `search_pattern`, `detect_changes`) can emit a structured trace of their internal funnel so an orchestrator (e.g. [Muninn](../muninn)) can render a per-tool panel showing exactly what got filtered where.

The trace is delivered out-of-band: the tool result still carries the normal JSON output, plus a single trailing line:

```
yggdrasil-trace-url: http://127.0.0.1:9130/api/trace/<id>
```

The orchestrator parses the URL, fetches `GET /api/trace/<id>`, and pins the JSON to its tool span. The trace itself stays in an in-memory TTL store (10 min default), so the tool result text remains small (~80 bytes overhead) and never blows past MCP output-size limits.

### Per-tool trace coverage

| Tool | Traced? | Why |
|------|---------|-----|
| `search` | yes | Hybrid retrieval pipeline — FTS / semantic / name → RRF → final |
| `impact` | yes | BFS hop counts, confidence buckets, top results |
| `search_pattern` | yes | rg invocation, per-repo match counts, pre-trim totals |
| `detect_changes` | yes | Diff stats, per-file symbol extraction, blast radius per changed symbol |
| `symbol_context`, `read_source`, `file_outline`, `list_files`, `list_repos` | no | Single-step deterministic queries; nothing meaningful to surface |

### Enabling traces

Both env vars must be set on the server process:

```bash
YGGDRASIL_TRACE_POINTER=1 YGGDRASIL_TRACE_DEFAULT=1 bun run dev
```

- `YGGDRASIL_TRACE_POINTER=1` is the master switch — without it, the `trace` arg and `YGGDRASIL_TRACE_DEFAULT` are no-ops (zero overhead).
- `YGGDRASIL_TRACE_DEFAULT=1` records a trace on every traced call. Drop it if you want callers to opt in per-call via the `trace: true` arg instead.
- `YGGDRASIL_TRACE_TTL_SECONDS` (default `600`) controls how long a trace is fetchable before it's evicted.

### Trace schema (v1)

`TraceV1` is a discriminated union over per-tool variants plus a generic escape hatch:

```ts
type TraceV1 =
  | TraceSearchV1          // tool: "search"
  | TraceImpactV1          // tool: "impact"
  | TracePatternV1         // tool: "search_pattern"
  | TraceDetectChangesV1   // tool: "detect_changes"
  | TraceGenericV1;        // shape: "generic" — for tools without a typed variant
```

The discriminator is `tool` for typed variants; `TraceGenericV1` carries a separate `shape: "generic"` field so consumers can narrow cleanly. The `tool` field is the bare yggdrasil tool name (`"search"`, `"impact"`, …), not the MCP-prefixed form (`"mcp__yggdrasil__search"` / `"yggdrasil-search"`).

Example `TraceSearchV1`:

```jsonc
{
  "schemaVersion": 1,
  "tool": "search",
  "query": { "raw": "BehandlingService", "filters": { "repo": "melosys-api" } },
  "candidates": [{
    "symbolId": "...",
    "qualifiedName": "no.nav.melosys.service.BehandlingService",
    "kind": "class",
    "stages": {
      "fts":      { "rank": 1, "score": 0.42 },
      "semantic": { "rank": 3, "score": 0.88 },
      "name":     { "rank": 1, "score": 1.0 },
      "rrf":      { "rank": 1, "score": 0.033 },
      "final":    { "rank": 1, "score": 0.05 }
    }
  }],
  "timingsMs": { "embedding": 12, "fts": 8, "semantic": 14, "name": 3, "rrf": 1, "total": 38 }
}
```

Example `TraceImpactV1`:

```jsonc
{
  "schemaVersion": 1,
  "tool": "impact",
  "query": { "qualifiedName": "com.foo.Bar.baz", "repo": "melosys-api", "maxDepth": 3 },
  "start": { "symbolId": "...", "qualifiedName": "com.foo.Bar.baz", "kind": "method" },
  "hops": [{ "depth": 0, "candidateCount": 12 }, { "depth": 1, "candidateCount": 5 }],
  "confidenceBuckets": [
    { "min": 0.8, "max": 1.0, "count": 8 },
    { "min": 0.6, "max": 0.8, "count": 4 }
  ],
  "finalCount": 17,
  "topResults": [/* up to 20 entries */],
  "timingsMs": { "lookup": 12, "traversal": 80, "scoring": 4, "total": 98 }
}
```

See `src/tracing/trace.ts` for the full schema of each variant.

### `GET /api/trace/<id>`

| Status | Body | When |
|--------|------|------|
| 200 | The trace JSON | Trace exists and TTL hasn't expired |
| 404 | `{"detail": "trace not found or expired"}` | Unknown id, or evicted |

Reads are non-consumptive — fetching the same id twice within the TTL returns the same trace, so retries are safe.

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

### Evaluating call resolution

`bun run eval:callers [fixture.json]` scores incoming callers against an IntelliJ oracle. The default fixture is `eval/fixtures/melosys-api-callers.json`.

1. To capture the fixture, open the repo in IntelliJ and use an agent with the JetBrains MCP. For each eval method, call `analyze_calls` with `INCOMING_CALLS` and `depth: 1`, and write the result as JSON:

   ```json
   { "repo": "melosys-api", "commit": "<sha>", "captured": "<date>", "source": "intellij analyze_calls",
     "symbols": [ { "qualified_name": "no.nav.Foo.bar", "intellij_signature": "bar(Baz)", "file": "<repo-relative path>",
                    "callers": [ { "signature": "Caller.method(Baz)", "file": "<repo-relative path>", "usages": 1 } ] } ] }
   ```

2. Index the repo at the same commit, then run `bun run eval:callers`.

The report scores the depth-1 `impact` result, with raw incoming `calls` edges as a second column. It matches each fixture symbol to one overload by file, parameter count, then the IntelliJ parameter types against `ci_symbols.param_types`; only when that leaves several does it score their union, with a note. It matches a caller by file path and method name, and splits production callers from test callers (`/src/test/`). Callers that are not functions, such as property initializers, are excluded and counted. The script warns when the index's `last_commit` differs from the fixture's `commit`. It exits 0 after a report, whatever the scores, and when no fixture exists; it exits 1 on a malformed fixture, a repo that is not indexed, or a database error.

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
| `DATABASE_URL` | `postgresql://user:password@127.0.0.1:5432/yggdrasil` | Postgres connection (requires pgvector) |
| `YGGDRASIL_PORT` | `9130` | MCP server port |
| `EMBEDDING_MODEL` | `Xenova/multilingual-e5-small` | HuggingFace model ID (ONNX-compatible) |
| `EMBEDDING_DIMS` | `384` | Vector dimensions (must match model + DB column) |
| `YGGDRASIL_TRACE_POINTER` | _(off)_ | Set to `1` to enable trace pointer mode on the four traced tools (`search`, `impact`, `search_pattern`, `detect_changes`). Master switch — without it, the `trace` arg and `YGGDRASIL_TRACE_DEFAULT` are no-ops. |
| `YGGDRASIL_TRACE_DEFAULT` | _(off)_ | Set to `1` to record a trace on every traced call (no need for callers to pass `trace: true`). Requires `YGGDRASIL_TRACE_POINTER=1`. |
| `YGGDRASIL_TRACE_TTL_SECONDS` | `600` | How long stored traces live before eviction. |

The default embedding model supports Norwegian and other non-English identifiers. For English-only codebases, `Xenova/all-MiniLM-L6-v2` is faster. For code-optimized search, try `jinaai/jina-embeddings-v2-base-code` (768 dims — requires a schema change).

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
- **Embeddings:** Configurable (default: Xenova/multilingual-e5-small, 384 dims)
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
│   ├── call-graph.ts         Extract calls (receiver kind, receiver type, arg count) + inheritance
│   └── edge-resolver.ts      Store call sites; rebuild call/inheritance edges repo-wide
├── search/
│   ├── hybrid-search.ts      RRF over FTS + semantic + name
│   ├── impact.ts             Blast radius (recursive CTE) + archetype tagging
│   ├── archetype.ts          Name+path heuristics → archetype classification
│   ├── analyze-ticket.ts     Ticket → candidate symbols + context bundle
│   └── detect-changes.ts     Git diff → affected symbols
├── db/
│   ├── connection.ts         Postgres pool
│   ├── repos.ts              ci_repos CRUD
│   ├── files.ts              ci_files CRUD
│   ├── symbols.ts            ci_symbols CRUD + vector ops
│   └── edges.ts              ci_edges CRUD + traversal
├── mcp/
│   └── server.ts             MCP streamable HTTP server
├── tracing/
│   ├── trace.ts              TraceV1 union + per-tool tracer classes
│   └── trace-store.ts        In-memory TTL trace store + pointer-line helper
├── embeddings.ts             Xenova model wrapper
├── cli.ts                    CLI entry point
└── config.ts                 Repo config loader
```
