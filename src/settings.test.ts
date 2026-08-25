import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { cloneManagedProject, createManagedProject, ensureSettings, initializeLoopDirectory, initializeProjectDirectory, settingsForWorkspace } from "./settings.js";

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

test("creates explicit project and loop metadata layouts", () => {
  const workspace = mkdtempSync(join(tmpdir(), "fleet-layout-"));
  const settings = settingsForWorkspace(workspace);
  const projectPath = initializeProjectDirectory(settings, "Billing API");
  const loopPath = initializeLoopDirectory(settings, "Daily review");

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
