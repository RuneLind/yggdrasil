/**
 * Quick validation script: parse real Java/Kotlin files and inspect AST + symbol extraction.
 * Usage: bun run scripts/test-parse.ts <file-path>
 */
import { initParser, loadLanguage, parseSource, extensionToLanguage } from "../src/indexer/parser.ts";
import { extractSymbols, buildQualifiedNames } from "../src/indexer/symbol-extractor.ts";
import { readFile } from "fs/promises";
import { extname } from "path";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: bun run scripts/test-parse.ts <file-path>");
  process.exit(1);
}

const ext = extname(filePath);
const lang = extensionToLanguage(ext);
if (!lang) {
  console.error(`Unsupported extension: ${ext}`);
  process.exit(1);
}

console.log(`\n=== Parsing ${filePath} (${lang}) ===\n`);

await initParser();
const language = await loadLanguage(lang);
const source = await readFile(filePath, "utf-8");
const tree = parseSource(source, language);

// Print root node type and top-level children
console.log(`Root node type: ${tree.rootNode.type}`);
console.log(`Top-level children (${tree.rootNode.childCount}):`);
for (let i = 0; i < Math.min(tree.rootNode.childCount, 20); i++) {
  const child = tree.rootNode.child(i)!;
  console.log(`  [${i}] ${child.type} (${child.startPosition.row + 1}–${child.endPosition.row + 1})`);
}

console.log(`\n=== Symbol extraction ===\n`);

try {
  const result = extractSymbols(source, tree, lang, language);
  console.log(`Package: ${result.packageName}`);
  console.log(`Imports: ${result.imports.length}`);
  for (const imp of result.imports.slice(0, 10)) {
    console.log(`  ${imp.importPath}${imp.isWildcard ? ".*" : ""}`);
  }
  if (result.imports.length > 10) {
    console.log(`  ... and ${result.imports.length - 10} more`);
  }

  console.log(`\nSymbols: ${result.symbols.length}`);
  const qualifiedNames = buildQualifiedNames(result);
  for (let i = 0; i < result.symbols.length; i++) {
    const sym = result.symbols[i];
    console.log(`  [${sym.kind}] ${qualifiedNames[i]} (lines ${sym.startLine}–${sym.endLine})${sym.visibility ? ` [${sym.visibility}]` : ""}`);
    if (sym.signature) {
      console.log(`         sig: ${sym.signature.slice(0, 100)}`);
    }
  }
} catch (err) {
  console.error("Symbol extraction failed:", err);

  // Fallback: dump some AST node types to help debug
  console.log("\n=== AST node types (for debugging queries) ===\n");
  function printTree(node: any, depth: number = 0) {
    if (depth > 4) return;
    const indent = "  ".repeat(depth);
    const text = node.text?.slice(0, 60).replace(/\n/g, "\\n") ?? "";
    console.log(`${indent}${node.type}${node.isNamed ? "" : " (anonymous)"} "${text}"`);
    for (let i = 0; i < Math.min(node.childCount, 10); i++) {
      printTree(node.child(i), depth + 1);
    }
  }
  // Print first few top-level named children
  for (let i = 0; i < Math.min(tree.rootNode.namedChildCount, 5); i++) {
    printTree(tree.rootNode.namedChild(i), 0);
  }
}

tree.delete();
