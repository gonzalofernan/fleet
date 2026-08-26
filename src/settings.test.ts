import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { cloneManagedProject, createManagedProject, ensureSettings, initializeLoopDirectory, initializeProjectDirectory, settingsForWorkspace } from "./settings.js";
import { initializeProjectContext } from "./project-context.js";

test("initializes a settings file and separated workspace directories", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-settings-"));
  const settingsPath = join(home, "config", "settings.json");
  const settings = ensureSettings(settingsPath);

  assert.equal(existsSync(settingsPath), true);
  for (const directory of [settings.projectsDirectory, settings.loopsDirectory, settings.worktreesDirectory, settings.archiveDirectory]) {
    assert.equal(existsSync(directory), true);
  }
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), settings);
});

test("persists version 1 settings as normalized version 2 settings", () => {
  const home = mkdtempSync(join(tmpdir(), "fleet-settings-migration-"));
  const path = join(home, "settings.json");
  const current = settingsForWorkspace(join(home, "workspace"));
  const { defaultProvider: _provider, heartbeatIntervalMs: _heartbeat, runtimeStaleMs: _stale, pullRequestPollMs: _pr,
    loopPollMs: _loop, autoCleanupWorktrees: _cleanup, ...legacy } = current;
  writeFileSync(path, `${JSON.stringify({ ...legacy, version: 1 })}\n`, "utf8");
  const migrated = ensureSettings(path);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.defaultProvider, "codex");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 2);
});

test("creates explicit project and loop metadata layouts", () => {
  const workspace = mkdtempSync(join(tmpdir(), "fleet-layout-"));
  const settings = settingsForWorkspace(workspace);
  const projectPath = initializeProjectDirectory(settings, "Billing API");
  const loopPath = initializeLoopDirectory(settings, "Daily review");

  const context = initializeProjectContext(settings, "Billing API", projectPath);
  assert.equal(existsSync(context.project), true);
  assert.equal(existsSync(context.status), true);
  assert.equal(existsSync(context.decisions), true);
  assert.equal(existsSync(join(projectPath, "PROJECT.md")), true);
  assert.equal(existsSync(join(loopPath, "LOOP.md")), true);
  assert.equal(existsSync(join(loopPath, "runs")), true);
});

test("creates managed Git projects outside the captain checkout", () => {
  const workspace = mkdtempSync(join(tmpdir(), "fleet-project-create-"));
  const projectPath = createManagedProject(settingsForWorkspace(workspace), "Billing API");

  assert.equal(projectPath, join(workspace, "projects", "billing-api"));
  assert.equal(existsSync(join(projectPath, ".git")), true);
  assert.equal(existsSync(join(projectPath, "PROJECT.md")), true);
  assert.equal(execFileSync("git", ["-C", projectPath, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" }).trim().length > 0, true);
});

test("clones repositories into the managed projects directory", () => {
  const source = mkdtempSync(join(tmpdir(), "fleet-project-source-"));
  execFileSync("git", ["init", source]);
  execFileSync("git", ["-C", source, "config", "user.email", "fleet@example.test"]);
  execFileSync("git", ["-C", source, "config", "user.name", "Fleet test"]);
  execFileSync("git", ["-C", source, "commit", "--allow-empty", "-m", "Initial commit"]);

  const workspace = mkdtempSync(join(tmpdir(), "fleet-project-clone-"));
  const projectPath = cloneManagedProject(settingsForWorkspace(workspace), "Existing Project", source);

  assert.equal(projectPath, join(workspace, "projects", "existing-project"));
  assert.equal(
    execFileSync("git", ["-C", projectPath, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(),
    projectPath.replaceAll("\\", "/"),
  );
  assert.equal(existsSync(join(projectPath, "PROJECT.md")), true);
});
