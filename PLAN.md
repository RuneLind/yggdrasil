# Yggdrasil — Work Plan

Code intelligence engine for Jira code analysis across the Melosys multi-repo stack.

## Phase 1: MVP — Working Indexer + Search (target: 1-2 weeks)

The goal is to index a real Melosys repo and get useful search results via MCP.

### 1.1 Validate Tree-sitter parsing
- [x] Run parser against a real Java file from melosys-api — verify AST output
- [x] Run parser against a real Kotlin file — verify AST output
- [x] Fix Kotlin grammar query patterns (known quirks: `type_identifier` vs `simple_identifier`, interface/enum as `class_declaration` with modifiers)
  - Kotlin uses `identifier` not `type_identifier`/`simple_identifier` for class/function names
  - Imports are individual `import` nodes (not wrapped in `import_list`)
  - Properties use `(property_declaration (variable_declaration (identifier)))` pattern
  - Must use `Map` not plain object for capture names to avoid `Object.prototype` collision with "constructor"
  - Must use `source.slice(node.startIndex, node.endIndex)` fallback for `.text` — WASM builds can return undefined
- [ ] Fix any TypeScript grammar issues
- [ ] Write tests for parser + symbol extraction per language

### 1.2 Get indexer working end-to-end
- [x] Run `bun run db:migrate` — verify schema applies cleanly to Muninn Postgres
  - Muninn `schema_migrations` table has extra `name` column — migrate script adapted
- [x] Index melosys-api as first test — 1993 files, 26505 symbols, ~5s
- [x] Debug and fix issues — file walker exclusions, qualified name building, batch inserts
- [x] Verify symbols in DB: class 2030, method 3629, function 7294, property 12842, constructor 513, interface 55, enum 53, object 89
- [x] Index melosys-eessi as second test — 529 files, 4239 symbols, ~1s
- [x] Incremental re-indexing works — 0 files changed, 485ms (content hash skipping)

### 1.3 Embeddings
- [x] Run embedding generation on indexed symbols — 30744 embedded, 0 failed
- [x] Verify vector search works
- [x] Handle large repos — batch in groups of 50, show progress

### 1.4 Hybrid search
- [x] Test FTS search alone — `search_vector` trigger works
- [x] Test semantic search alone — vector similarity works
- [x] Test RRF combination — results make sense
- [x] Tuned: name-match weight 1.5x, kind-based boost (class 1.5x, property 0.7x), case-sensitive exact match gets rank 1.0 vs 0.9 for case-insensitive

### 1.5 MCP server
- [x] Start server, verify `/health` endpoint
- [x] Test `search` tool via MCP client
- [x] Test `list_repos` tool — returns both repos with metadata
- [x] All 6 tools registered: search, symbol_context, impact, detect_changes, file_outline, list_repos
- [x] Fixed: use `WebStandardStreamableHTTPServerTransport` for Bun (not Node.js StreamableHTTP)
- [x] Fixed: use stateful mode with session IDs for multi-request sessions
- [x] Create `repos.json` with melosys-api + melosys-eessi configs
- [ ] Test `file_outline` tool with real file
- [ ] Add to a bot's `.mcp.json` and verify it works from an AI agent

### Phase 1 done when:
"Given a Jira ticket description, the AI agent can search for relevant symbols across Melosys repos and get useful results."

---

## Phase 2: Call Graph + Impact Analysis (target: 2-3 weeks)

The goal is blast radius analysis — "if I change X, what breaks?"

### 2.1 Import resolution
- [ ] Java: resolve `import no.nav.melosys...` to ci_symbols by qualified_name
- [ ] Java: handle wildcard imports (`import ...service.*`)
- [ ] Kotlin: resolve imports (same as Java package model + top-level functions)
- [ ] TypeScript: resolve relative imports (`./foo` → file lookup + extension resolution)
- [ ] TypeScript: handle barrel re-exports (`export { x } from './y'`, max depth 5)
- [ ] Store resolved imports as ci_edges with `kind = "imports"`
- [ ] Write tests per language

### 2.2 Call graph extraction
- [ ] Extract call expressions from Java AST (method invocations)
- [ ] Extract call expressions from Kotlin AST
- [ ] Extract call expressions from TypeScript AST
- [ ] Resolve callees: local methods → imported symbols → same-package symbols
- [ ] Store as ci_edges with `kind = "calls"`
- [ ] Handle inheritance: `extends` and `implements` edges
- [ ] Write tests

### 2.3 Impact analysis
- [ ] Test `symbol_context` tool — verify incoming/outgoing edges look correct
- [ ] Test `impact` tool — verify recursive CTE traversal works
- [ ] Tune confidence scoring — does depth 0=1.0, 1=0.7, 2=0.4, 3=0.2 feel right?
- [ ] Test with a real example: pick a service method, verify blast radius makes sense

### 2.4 Change detection
- [ ] Test `detect_changes` tool against a real git diff
- [ ] Verify it maps changed lines → symbols → impact correctly
- [ ] Test with working tree changes (no ref) and with commit ranges

### 2.5 Incremental re-indexing
- [ ] Verify content hash skipping works (unchanged files not re-parsed)
- [ ] Verify stale file cleanup (deleted files removed from index)
- [ ] Test: make a change, re-index, verify only changed file is re-processed
- [ ] Add `--full` flag to force full re-index

### Phase 2 done when:
"Given a symbol name, the agent can show blast radius with confidence scores. Given a git diff, it can identify affected code."

---

## Phase 3: Polish + Integration (target: 1-2 weeks)

### 3.1 Multi-repo
- [ ] Index all Melosys repos (api, eessi, eux-rina-api, trygdeavgift, fakturering, mock)
- [ ] Cross-repo edge resolution (e.g. melosys-api using types from melosys-eessi)
- [ ] Test search across all repos at once

### 3.2 Jira integration
- [ ] Integrate with Muninn bot's Jira research flow — auto-search when analyzing a ticket
- [ ] Test end-to-end: Jira ticket → relevant code symbols + blast radius

### 3.3 Auto re-index
- [ ] Git hook or file watcher for automatic re-indexing on commit
- [ ] Or: scheduled re-index via Muninn scheduler

### 3.4 Muninn dashboard page
- [ ] Add "Code Intel" page (like Serena page) — repo list, symbol counts, index age
- [ ] Reindex button per repo
- [ ] Search test UI

### 3.5 Tool proxy integration
- [ ] Add Yggdrasil to Muninn's Serena tool proxy on port 9120
- [ ] Or: keep standalone on port 9130 with direct `.mcp.json` entry

### Phase 3 done when:
"Full Jira analysis workflow works end-to-end: ticket → code search → blast radius → relevant tests → actionable summary."

---

## Known risks and open questions

1. **Kotlin Tree-sitter grammar quirks** — the `@tree-sitter-grammars/tree-sitter-kotlin` grammar may have different node types than documented. Will need to inspect real AST output and adjust queries.

2. **Cross-file resolution accuracy** — 80% accuracy is the target for MVP. Barrel re-exports and wildcard imports are the hard cases. Can iterate.

3. **Embedding quality for code** — `all-MiniLM-L6-v2` is trained on natural language, not code. Qualified names + signatures may not embed as well as prose. Monitor search quality and consider code-specific models (e.g. `jinaai/jina-embeddings-v2-base-code`) if needed.

4. **Index size** — a large repo (50K+ files) may take significant time for first index. Incremental should be fast after that.

5. **Postgres recursive CTE performance** — for deep call graphs (depth 3+), the recursive CTE may be slow on large symbol tables. Add `LIMIT` guards and monitor query plans.
