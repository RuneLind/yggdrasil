import { Glob } from "bun";
import { relative } from "path";
import { EXTENSION_MAP, extensionToLanguage, type SupportedLanguage } from "./parser.ts";

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  language: SupportedLanguage;
  contentHash: string;
}

const DEFAULT_EXCLUDE = [
  "**/node_modules/**",
  "**/build/**",
  "**/target/**",
  "**/dist/**",
  "**/.git/**",
  "**/vendor/**",
  "**/.gradle/**",
  "**/.idea/**",
];

export async function walkRepo(
  repoPath: string,
  options?: {
    languages?: SupportedLanguage[];
    exclude?: string[];
  },
): Promise<DiscoveredFile[]> {
  const allowedLangs = new Set(options?.languages ?? ["java", "kotlin", "typescript", "tsx"]);
  const excludePatterns = options?.exclude ?? DEFAULT_EXCLUDE;
  const compiledExcludes = excludePatterns.map((p) => new Glob(p));

  const files: DiscoveredFile[] = [];

  for (const ext of Object.keys(EXTENSION_MAP)) {
    const lang = extensionToLanguage(ext);
    if (!lang || !allowedLangs.has(lang)) continue;

    const glob = new Glob(`**/*${ext}`);
    for await (const match of glob.scan({ cwd: repoPath, absolute: true })) {
      const relativePath = relative(repoPath, match);
      if (compiledExcludes.some((g) => g.match(relativePath))) continue;

      const content = await Bun.file(match).text();
      const contentHash = Bun.hash(content).toString(16);

      files.push({
        absolutePath: match,
        relativePath,
        language: lang,
        contentHash,
      });
    }
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
