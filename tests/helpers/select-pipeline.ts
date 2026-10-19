import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initParser, loadLanguage, parseSource } from "../../src/indexer/parser.ts";
import { buildQualifiedNames, extractSymbols } from "../../src/indexer/symbol-extractor.ts";
import { parseGitDiff } from "../../src/search/diff-parse.ts";
import { parseSourceTree } from "../../src/search/container-rule.ts";
import { selectChangedSymbols } from "../../src/search/detect-changes.ts";

export type Lang = "kotlin" | "java";

export interface PipelineSymbol {
  id: string;
  kind: string;
  qualified_name: string;
  start_line: number;
  end_line: number;
  parent_id: string | null;
  file_path: string;
}

/** The base file's symbols as the indexer extracts them; ids are positions. */
export async function extract(lang: Lang, source: string, filePath: string): Promise<PipelineSymbol[]> {
  await initParser();
  const language = await loadLanguage(lang);
  const tree = parseSource(source, language)!;
  try {
    const result = extractSymbols(source, tree, lang, language);
    const names = buildQualifiedNames(result);
    return result.symbols.map((s, i) => ({
      id: String(i),
      kind: s.kind,
      qualified_name: names[i],
      start_line: s.startLine,
      end_line: s.endLine,
      parent_id: s.parentIndex === null ? null : String(s.parentIndex),
      file_path: filePath,
    }));
  } finally {
    tree.delete();
  }
}

/** `git diff --no-index` of two versions of one file, with detect_changes' flags. */
export async function diffText(lang: Lang, base: string, head: string): Promise<{ text: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ygg-select-"));
  const file = lang === "kotlin" ? "F.kt" : "F.java";
  try {
    await mkdir(join(dir, "base"));
    await mkdir(join(dir, "head"));
    await writeFile(join(dir, "base", file), base);
    await writeFile(join(dir, "head", file), head);
    const proc = Bun.spawn(
      ["git", "-c", "core.quotePath=false", "diff", "--no-index", "--unified=0", "--inter-hunk-context=0", "--no-color",
        "--src-prefix=a/", "--dst-prefix=b/", "--no-textconv", "--no-ext-diff", `base/${file}`, `head/${file}`],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return { text, path: `base/${file}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The base-side container rule end to end on one file, without a database. */
export async function select(lang: Lang, base: string, head: string) {
  const { text, path } = await diffText(lang, base, head);
  const diff = parseGitDiff(text);
  const symbols = await extract(lang, base, path);
  const ext = lang === "kotlin" ? ".kt" : ".java";
  const indexed = await parseSourceTree(`F${ext}`, base);
  const headTree = await parseSourceTree(`F${ext}`, head);
  try {
    const { changed, reasons } = selectChangedSymbols([
      { symbols, ranges: diff.baseFiles.get(path) ?? [], indexed, head: headTree },
    ]);
    return {
      changed: changed.map((s) => s.qualified_name).sort(),
      kept: Object.fromEntries(changed.filter((s) => reasons.has(s.id)).map((s) => [s.qualified_name, reasons.get(s.id)])),
    };
  } finally {
    indexed?.delete();
    headTree?.delete();
  }
}
