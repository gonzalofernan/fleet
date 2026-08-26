import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export interface Worktree {
  branch: string;
  path: string;
}

export class GitWorktreeAdapter {
  constructor(private readonly worktreesRoot?: string) {}

  create(projectRoot: string, agentId: string): Worktree {
    const shortId = agentId.slice(0, 8);
    const branch = `fleet/agent-${shortId}`;
    const path = this.worktreesRoot
      ? join(this.worktreesRoot, basename(projectRoot), shortId)
      : join(dirname(projectRoot), ".fleet-worktrees", basename(projectRoot), shortId);
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

  remove(projectRoot: string, worktree: Worktree): void {
    if (!worktree.branch.startsWith("fleet/agent-")) throw new Error(`Refusing to remove non-Fleet branch: ${worktree.branch}`);
    assertFleetWorktreePath(projectRoot, worktree.path, this.worktreesRoot);
    if (existsSync(worktree.path)) {
      execFileSync("git", ["-C", projectRoot, "worktree", "remove", worktree.path], { encoding: "utf8", stdio: "pipe" });
    }
    execFileSync("git", ["-C", projectRoot, "worktree", "prune"], { encoding: "utf8", stdio: "pipe" });
    const branch = execFileSync("git", ["-C", projectRoot, "branch", "--list", worktree.branch], { encoding: "utf8", stdio: "pipe" }).trim();
    if (branch) execFileSync("git", ["-C", projectRoot, "branch", "-D", worktree.branch], { encoding: "utf8", stdio: "pipe" });
  }
}

export function assertFleetWorktreePath(projectRoot: string, target: string, configuredRoot?: string): void {
  const roots = [
    ...(configuredRoot ? [configuredRoot] : []),
    join(dirname(projectRoot), ".fleet-worktrees", basename(projectRoot)),
  ];
  if (!roots.some((root) => isInside(root, target))) {
    throw new Error(`Refusing to remove worktree outside Fleet roots: ${target}`);
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

function isInside(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  const offset = relative(normalizedRoot, normalizedTarget);
  return Boolean(offset) && !offset.startsWith("..") && resolve(normalizedRoot, offset) === normalizedTarget;
}
