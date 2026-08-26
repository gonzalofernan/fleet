import { execFileSync } from "node:child_process";

export interface MergedPullRequest {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  mergedAt: string;
}

interface GitHubPullRequestRow {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  mergedAt: string | null;
}

export interface PullRequestLookup {
  findMergedPullRequest(projectRoot: string, headBranch: string): MergedPullRequest | null;
}

export class GitHubPullRequestAdapter implements PullRequestLookup {
  findMergedPullRequest(projectRoot: string, headBranch: string): MergedPullRequest | null {
    const output = execFileSync("gh", [
      "pr", "list", "--state", "merged", "--head", headBranch, "--limit", "100",
      "--json", "number,url,headRefName,baseRefName,mergedAt",
    ], { cwd: projectRoot, encoding: "utf8", stdio: "pipe" });
    return selectMergedPullRequest(JSON.parse(output) as GitHubPullRequestRow[], headBranch);
  }
}

export function selectMergedPullRequest(rows: GitHubPullRequestRow[], headBranch: string): MergedPullRequest | null {
  const matches = rows.filter((row) => row.headRefName === headBranch && typeof row.mergedAt === "string" && row.mergedAt.length > 0);
  if (matches.length === 0) return null;
  matches.sort((left, right) => right.mergedAt!.localeCompare(left.mergedAt!));
  const merged = matches[0]!;
  return {
    number: merged.number,
    url: merged.url,
    headRefName: merged.headRefName,
    baseRefName: merged.baseRefName,
    mergedAt: merged.mergedAt!,
  };
}
