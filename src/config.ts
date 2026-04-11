import { join } from "path";
import type { SupportedLanguage } from "./indexer/parser.ts";

export interface RepoConfig {
  name: string;
  path: string;
  languages?: SupportedLanguage[];
  exclude?: string[];
}

const CONFIG_FILE = "repos.json";

/** Load repo configuration from repos.json or CLI args. */
export async function loadRepoConfigs(
  configPath?: string,
): Promise<RepoConfig[]> {
  const path = configPath ?? join(process.cwd(), CONFIG_FILE);
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return [];
  }

  const raw = await file.json();
  if (!Array.isArray(raw)) {
    throw new Error(`${path}: expected a JSON array of repo configs`);
  }

  return raw.map((entry: any) => ({
    name: entry.name,
    path: entry.path,
    languages: entry.languages,
    exclude: entry.exclude,
  }));
}

/** Create a RepoConfig from CLI arguments. */
export function repoConfigFromArgs(
  repoPath: string,
  name?: string,
): RepoConfig {
  const resolvedPath = repoPath.startsWith("/")
    ? repoPath
    : join(process.cwd(), repoPath);

  return {
    name: name ?? resolvedPath.split("/").pop() ?? "unknown",
    path: resolvedPath,
  };
}
