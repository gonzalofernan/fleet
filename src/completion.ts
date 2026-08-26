import { execFileSync } from "node:child_process";

export interface CompletionProof {
  commit: string;
  upstream: string;
  pullRequestUrl: string;
}

export type GitCommandRunner = (worktreePath: string, args: string[]) => string;
export type PullRequestCommandRunner = (worktreePath: string, args: string[]) => string;

export function ensurePullRequest(worktreePath: string, branch: string, runPullRequest: PullRequestCommandRunner = pullRequest): string {
  try {
    const existing = runPullRequest(worktreePath, ["pr", "view", "--json", "url", "--jq", ".url"]);
    if (existing) return existing;
  } catch {
    // Create the PR below when the branch does not have one yet.
  }
  const created = runPullRequest(worktreePath, ["pr", "create", "--fill", "--head", branch]);
  if (!created) throw new Error("GitHub CLI did not return a pull request URL after creation");
  return created.split(/\r?\n/).find((line) => /^https:\/\//.test(line.trim()))?.trim() ?? created.trim();
}

export function validateWorktreeReadyForCompletion(
  worktreePath: string,
  expectedBranch: string,
  runGit: GitCommandRunner = git,
  runPullRequest: PullRequestCommandRunner = pullRequest,
): CompletionProof {
  const branch = runGit(worktreePath, ["branch", "--show-current"]);
  if (branch !== expectedBranch) {
    throw new Error(`Worktree is on ${branch || "no branch"}, expected ${expectedBranch}`);
  }
  if (runGit(worktreePath, ["status", "--porcelain"])) {
    throw new Error("Worktree has uncommitted or untracked changes");
  }
  const commit = runGit(worktreePath, ["rev-parse", "HEAD"]);
  const upstream = runGit(worktreePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const upstreamCommit = runGit(worktreePath, ["rev-parse", "@{u}"]);
  if (commit !== upstreamCommit) {
    throw new Error(`Local HEAD ${commit.slice(0, 8)} is not pushed to ${upstream}`);
  }
  const pullRequestUrl = runPullRequest(worktreePath, ["pr", "view", "--json", "url", "--jq", ".url"]);
  if (!pullRequestUrl) throw new Error("No pull request exists for the pushed branch");
  return { commit, upstream, pullRequestUrl };
}

function git(worktreePath: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", worktreePath, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Git validation failed for ${args.join(" ")}: ${detail}`);
  }
}

function pullRequest(worktreePath: string, args: string[]): string {
  try {
    return execFileSync("gh", args, { cwd: worktreePath, encoding: "utf8", stdio: "pipe" }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`GitHub CLI validation failed: ${detail}`);
  }
}
