/**
 * Run git in a fixture repo, isolated from the user's global config (no signing prompt,
 * no hooks). Returns trimmed stdout; throws with stderr on a non-zero exit.
 */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const isolated = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
  const proc = Bun.spawn(["git", ...isolated, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}
