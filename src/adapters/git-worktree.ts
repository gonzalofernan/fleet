import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface Worktree {
  branch: string;
  path: string;
}

export class GitWorktreeAdapter {
  create(projectRoot: string, agentId: string): Worktree {
    const shortId = agentId.slice(0, 8);
    const branch = `fleet/agent-${shortId}`;
    const path = join(dirname(projectRoot), ".fleet-worktrees", basename(projectRoot), shortId);
    mkdirSync(dirname(path), { recursive: true });
    execFileSync("git", ["-C", projectRoot, "worktree", "add", "-b", branch, path, "HEAD"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { branch, path };
  }

  list(projectRoot: string): Worktree[] {
    const output = execFileSync("git", ["-C", projectRoot, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return parseWorktreeList(output).filter((worktree) => worktree.branch.startsWith("fleet/agent-"));
  }
}

export function parseWorktreeList(output: string): Worktree[] {
  const worktrees: Worktree[] = [];
  for (const block of output.trim().split("\n\n")) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    if (path && branch) worktrees.push({ path, branch });
  }
  return worktrees;
}
