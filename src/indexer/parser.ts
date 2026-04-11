import { Parser, Language, type Query } from "web-tree-sitter";

export type SupportedLanguage = "java" | "kotlin" | "typescript" | "tsx";

export const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  ".java": "java",
  ".kt": "kotlin",
  ".ts": "typescript",
  ".tsx": "tsx",
};

const WASM_PATHS: Record<SupportedLanguage, string> = {
  java: require.resolve("tree-sitter-java/tree-sitter-java.wasm"),
  kotlin: require.resolve(
    "@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm",
  ),
  typescript: require.resolve(
    "tree-sitter-typescript/tree-sitter-typescript.wasm",
  ),
  tsx: require.resolve("tree-sitter-typescript/tree-sitter-tsx.wasm"),
};

let initialized = false;
const languages: Partial<Record<SupportedLanguage, Language>> = {};
let parserInstance: Parser | null = null;

export async function initParser(): Promise<void> {
  if (initialized) return;
  await Parser.init();
  initialized = true;
}

export async function loadLanguage(lang: SupportedLanguage): Promise<Language> {
  if (languages[lang]) return languages[lang]!;
  const language = await Language.load(WASM_PATHS[lang]);
  languages[lang] = language;
  return language;
}

/** Parse source code into a Tree-sitter tree. Caller must call tree.delete() when done. */
export function parseSource(
  source: string,
  language: Language,
): ReturnType<Parser["parse"]> {
  if (!parserInstance) parserInstance = new Parser();
  parserInstance.setLanguage(language);
  return parserInstance.parse(source);
}

export function extensionToLanguage(ext: string): SupportedLanguage | undefined {
  return EXTENSION_MAP[ext];
}

export { Parser, Language, Query };
