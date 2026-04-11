import { Parser, Language, type Query } from "web-tree-sitter";

export type SupportedLanguage = "java" | "kotlin" | "typescript" | "tsx";

const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  ".java": "java",
  ".kt": "kotlin",
  ".ts": "typescript",
  ".tsx": "tsx",
};

let initialized = false;
const languages: Partial<Record<SupportedLanguage, Language>> = {};

/** Initialize Tree-sitter WASM runtime. Call once at startup. */
export async function initParser(): Promise<void> {
  if (initialized) return;
  await Parser.init();
  initialized = true;
}

/** Load a language grammar (cached). */
export async function loadLanguage(lang: SupportedLanguage): Promise<Language> {
  if (languages[lang]) return languages[lang]!;

  const wasmPaths: Record<SupportedLanguage, string> = {
    java: require.resolve("tree-sitter-java/tree-sitter-java.wasm"),
    kotlin: require.resolve(
      "@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm",
    ),
    typescript: require.resolve(
      "tree-sitter-typescript/tree-sitter-typescript.wasm",
    ),
    tsx: require.resolve("tree-sitter-typescript/tree-sitter-tsx.wasm"),
  };

  const language = await Language.load(wasmPaths[lang]);
  languages[lang] = language;
  return language;
}

/** Parse source code into a Tree-sitter tree. Caller must call tree.delete() when done. */
export function parseSource(
  source: string,
  language: Language,
): ReturnType<Parser["parse"]> {
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  parser.delete();
  return tree;
}

/** Map file extension to language, or undefined if unsupported. */
export function extensionToLanguage(ext: string): SupportedLanguage | undefined {
  return EXTENSION_MAP[ext];
}

export { Parser, Language, Query };
