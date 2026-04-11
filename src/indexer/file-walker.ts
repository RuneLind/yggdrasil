import { Glob } from "bun";
import { extname, relative, join } from "path";
import { extensionToLanguage, type SupportedLanguage } from "./parser.ts";

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

/** Walk a repo directory and discover indexable source files. */
export async function walkRepo(
  repoPath: string,
  options?: {
    languages?: SupportedLanguage[];
    exclude?: string[];
  },
): Promise<DiscoveredFile[]> {
  const allowedLangs = new Set(options?.languages ?? ["java", "kotlin", "typescript", "tsx"]);
  const excludePatterns = options?.exclude ?? DEFAULT_EXCLUDE;

  const extensions = [".java", ".kt", ".ts", ".tsx"];
  const files: DiscoveredFile[] = [];

  for (const ext of extensions) {
    const lang = extensionToLanguage(ext);
    if (!lang || !allowedLangs.has(lang)) continue;

    const glob = new Glob(`**/*${ext}`);
    for await (const match of glob.scan({ cwd: repoPath, absolute: true })) {
      const relativePath = relative(repoPath, match);

      // Check exclude patterns
      if (excludePatterns.some((p) => matchGlob(relativePath, p))) continue;

      // Skip test files for now (configurable later)
      // We still index them — tests are useful for impact analysis

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

/** Simple glob matcher for exclude patterns. */
function matchGlob(path: string, pattern: string): boolean {
  // Convert glob to regex
  const regex = pattern
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<GLOBSTAR>>>/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regex}$`).test(path);
}
